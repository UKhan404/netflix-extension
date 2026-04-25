chrome.runtime.onMessage.addListener(function handleNetflixRatingsMessage(message, sender, sendResponse) {
  if (!message || message.type !== 'nro:request-json') {
    return false;
  }

  var request = message.request || {};
  if (!request.url) {
    sendResponse({
      ok: false,
      error: 'Missing request URL.'
    });
    return false;
  }

  fetch(request.url, {
    method: request.method || 'GET',
    headers: request.headers || {},
    body: request.body || undefined
  })
    .then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.json();
    })
    .then(function (data) {
      sendResponse({ ok: true, data: data });
    })
    .catch(function (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : 'Network request failed.'
      });
    });

  return true;
});
