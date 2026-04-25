chrome.runtime.onMessage.addListener(function handleNetflixRatingsMessage(message, sender, sendResponse) {
  if (!message || message.type !== 'nro:request-json' || !message.url) {
    return false;
  }

  fetch(message.url)
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
