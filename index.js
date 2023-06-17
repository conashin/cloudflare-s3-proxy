// @ts-nocheck
//
// Proxy Backblaze S3 compatible API requests, sending notifications to a webhook
//
// Adapted from https://github.com/obezuk/worker-signed-s3-template
//
import aws4fetch from 'aws4fetch';

// Extract the region from the endpoint
const endpointRegex = /^s3\.([a-zA-Z0-9-]+)\.wasabisys\.com$/;
const [ , aws_region] = AWS_S3_ENDPOINT.match(endpointRegex);

const aws = new AwsClient({
    "accessKeyId": AWS_ACCESS_KEY_ID,
    "secretAccessKey": AWS_SECRET_ACCESS_KEY,
    "service": "s3",
    "region": aws_region,
});

const unsignedError =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Unauthenticated requests are not allowed for this api</Message>
</Error>`;

// Could add more detail regarding the specific error, but this enough for now
const validationError = 
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
  <Error>
    <Type>Sender</Type>
    <Code>SignatureDoesNotMatch</Code>
    <Message>Signature validation failed.</Message>
  </Error>
  <RequestId>0300D815-9252-41E5-B587-F189759A21BF</RequestId>
</ErrorResponse>`;


addEventListener('fetch', function(event) {
    event.respondWith(handleRequest(event))
});


// These headers appear in the request, but are not passed upstream
const UNSIGNABLE_HEADERS = [
    'x-forwarded-proto',
    'x-real-ip',
]


// Filter out cf-* and any other headers we don't want to include in the signature
function filterHeaders(headers) {
    return Array.from(headers.entries())
      .filter(pair => !UNSIGNABLE_HEADERS.includes(pair[0]) && !pair[0].startsWith('cf-'));
}


function SignatureMissingException() {}


function SignatureInvalidException() {}


// Verify the signature on the incoming request
async function verifySignature(request) {
    const authorization = request.headers.get('Authorization');
    if (!authorization) {
        throw new SignatureMissingException();
    }

    // Parse the AWS V4 signature value
    const re = /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=(.+)$/;
    let [ , credential, signedHeaders, signature] = authorization.match(re);

    credential = credential.split('/');
    signedHeaders = signedHeaders.split(';');

    // Verify that the request was signed with the expected key
    if (credential[0] != AWS_ACCESS_KEY_ID) {
        throw new SignatureInvalidException();
    }

    // Use the timestamp from the incoming signature
    const datetime = request.headers.get('x-amz-date');

    // Extract the headers that we want from the complete set of incoming headers
    const headersToSign = signedHeaders
        .map(key => ({
            name: key, 
            value: request.headers.get(key) 
        }))
        .reduce((obj, item) => (obj[item.name] = item.value, obj), {});

    const signedRequest = await aws.sign(request.url, {
        method: request.method,
        headers: headersToSign,
        body: request.body,
        aws: { datetime: datetime, allHeaders:true }
    });

    // All we need is the signature component of the Authorization header
    const [ , , , generatedSignature] = signedRequest.headers.get('Authorization').match(re);

    if (signature !== generatedSignature) {
        throw new SignatureInvalidException();
    }
}


// Where the magic happens...
async function handleRequest(event) {
    const request = event.request;

    // Set upstream target hostname.
    var url = new URL(request.url);
    url.hostname = AWS_S3_ENDPOINT;

    // Only handle requests signed by our configured key.
    try {
        await verifySignature(request);
    } catch (e) {
        // Signature is missing or bad - deny the request
        return new Response(
            (e instanceof SignatureMissingException) ? 
                unsignedError : 
                validationError,
            {
                status: 403,
                headers: {
                    'Content-Type': 'application/xml',
                    'Cache-Control': 'max-age=0, no-cache, no-store'
                }
            });
    }

    // Certain headers appear in the incoming request but are
    // removed from the outgoing request. If they are in the
    // signed headers, B2 can't validate the signature.
    const headers = filterHeaders(request.headers);

    // Sign the new request
    var signedRequest = await aws.sign(url, {
        method: request.method,
        headers: headers,
        body: request.body
    });

    // Send the signed request to B2 and wait for the upstream response
    const response = await fetch(signedRequest);
    return response;
}
