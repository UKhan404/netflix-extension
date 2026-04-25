(function startNetflixRatingsExtension() {
  'use strict';

  if (window.__nroChromeStarted) {
    return;
  }
  window.__nroChromeStarted = true;

  function getValue(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (result) {
        resolve(result[key] || null);
      });
    });
  }

  function setValue(key, value) {
    return new Promise(function (resolve) {
      var payload = {};
      payload[key] = value;
      chrome.storage.local.set(payload, function () {
        resolve();
      });
    });
  }

  function requestJson(request) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: 'nro:imdb-graphql', query: request.query }, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response || !response.ok) {
          reject(new Error(response && response.error ? response.error : 'Request failed.'));
          return;
        }

        resolve(response.data);
      });
    });
  }

  var app = window.NetflixRatingsCore.createApp({
    getValue: getValue,
    setValue: setValue,
    requestJson: requestJson,
    logger: function () {
      console.debug.apply(console, ['[Netflix Ratings]'].concat(Array.prototype.slice.call(arguments)));
    }
  });

  app.init();
})();
