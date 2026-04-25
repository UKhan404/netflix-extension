chrome.runtime.onMessage.addListener(function handleNetflixRatingsMessage(message, sender, sendResponse) {
  if (!message || message.type !== 'nro:imdb-graphql') {
    return false;
  }

  loadImdbConfig(function (config) {
    if (!hasFullConfig(config)) {
      sendResponse({
        ok: false,
        error: 'IMDb API configuration is incomplete.'
      });
      return;
    }

    signAndSendGraphql(config, message.query)
      .then(function (data) {
        sendResponse({ ok: true, data: data });
      })
      .catch(function (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : 'IMDb request failed.'
        });
      });
  });

  return true;
});

function loadImdbConfig(callback) {
  chrome.storage.local.get([
    'nro.imdb.awsAccessKeyId',
    'nro.imdb.awsSecretAccessKey',
    'nro.imdb.awsSessionToken',
    'nro.imdb.apiKey',
    'nro.imdb.datasetId',
    'nro.imdb.revisionId',
    'nro.imdb.assetId'
  ], function (values) {
    callback({
      awsAccessKeyId: values['nro.imdb.awsAccessKeyId'] || '',
      awsSecretAccessKey: values['nro.imdb.awsSecretAccessKey'] || '',
      awsSessionToken: values['nro.imdb.awsSessionToken'] || '',
      imdbApiKey: values['nro.imdb.apiKey'] || '',
      datasetId: values['nro.imdb.datasetId'] || '',
      revisionId: values['nro.imdb.revisionId'] || '',
      assetId: values['nro.imdb.assetId'] || ''
    });
  });
}

function hasFullConfig(config) {
  return Boolean(
    config.awsAccessKeyId &&
    config.awsSecretAccessKey &&
    config.imdbApiKey &&
    config.datasetId &&
    config.revisionId &&
    config.assetId
  );
}

async function signAndSendGraphql(config, query) {
  var endpoint = 'https://api-fulfill.dataexchange.us-east-1.amazonaws.com/v1';
  var host = 'api-fulfill.dataexchange.us-east-1.amazonaws.com';
  var region = 'us-east-1';
  var service = 'dataexchange';
  var method = 'POST';
  var body = JSON.stringify({ query: query });
  var now = new Date();
  var amzDate = toAmzDate(now);
  var dateStamp = amzDate.slice(0, 8);

  var canonicalHeaders = {
    'content-type': 'application/json',
    'host': host,
    'x-amz-date': amzDate,
    'x-amzn-dataexchange-asset-id': config.assetId,
    'x-amzn-dataexchange-data-set-id': config.datasetId,
    'x-amzn-dataexchange-revision-id': config.revisionId,
    'x-api-key': config.imdbApiKey
  };

  if (config.awsSessionToken) {
    canonicalHeaders['x-amz-security-token'] = config.awsSessionToken;
  }

  var sortedHeaderNames = Object.keys(canonicalHeaders).sort();
  var canonicalHeadersString = sortedHeaderNames.map(function (name) {
    return name + ':' + String(canonicalHeaders[name]).trim().replace(/\s+/g, ' ');
  }).join('\n') + '\n';
  var signedHeaders = sortedHeaderNames.join(';');
  var payloadHash = await sha256Hex(body);

  var canonicalRequest = [
    method,
    '/v1',
    '',
    canonicalHeadersString,
    signedHeaders,
    payloadHash
  ].join('\n');

  var credentialScope = [dateStamp, region, service, 'aws4_request'].join('/');
  var stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  var signingKey = await getSignatureKey(config.awsSecretAccessKey, dateStamp, region, service);
  var signature = await hmacHex(signingKey, stringToSign);

  var requestHeaders = {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    'X-Amzn-DataExchange-Data-Set-Id': config.datasetId,
    'X-Amzn-DataExchange-Revision-Id': config.revisionId,
    'X-Amzn-DataExchange-Asset-Id': config.assetId,
    'x-api-key': config.imdbApiKey,
    'Authorization': [
      'AWS4-HMAC-SHA256 Credential=' + config.awsAccessKeyId + '/' + credentialScope,
      'SignedHeaders=' + signedHeaders,
      'Signature=' + signature
    ].join(', ')
  };

  if (config.awsSessionToken) {
    requestHeaders['X-Amz-Security-Token'] = config.awsSessionToken;
  }

  var response = await fetch(endpoint, {
    method: method,
    headers: requestHeaders,
    body: body
  });

  var data = await response.json();
  if (!response.ok) {
    throw new Error((data && (data.message || data.error)) || ('HTTP ' + response.status));
  }

  if (data.errors && data.errors.length) {
    throw new Error(data.errors[0].message || 'IMDb GraphQL error.');
  }

  return data;
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

async function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  var kDate = await hmacBytes('AWS4' + secretKey, dateStamp);
  var kRegion = await hmacBytes(kDate, regionName);
  var kService = await hmacBytes(kRegion, serviceName);
  return hmacBytes(kService, 'aws4_request');
}

async function hmacBytes(key, message) {
  var cryptoKey = await crypto.subtle.importKey(
    'raw',
    toUint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  var signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    toUint8Array(message)
  );

  return new Uint8Array(signature);
}

async function hmacHex(key, message) {
  return bytesToHex(await hmacBytes(key, message));
}

async function sha256Hex(value) {
  var digest = await crypto.subtle.digest('SHA-256', toUint8Array(value));
  return bytesToHex(new Uint8Array(digest));
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new TextEncoder().encode(String(value));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(function (byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
}
