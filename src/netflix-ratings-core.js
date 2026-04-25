(function initNetflixRatingsCore(global) {
  'use strict';

  if (global.NetflixRatingsCore) {
    return;
  }

  var STORAGE_KEYS = {
    omdbApiKey: 'nro.omdbApiKey'
  };

  var DETAIL_ROOT_SELECTOR = '.previewModal--wrapper, .previewModal--container, .jawBone, .billboard-row, main';
  var DETAIL_TITLE_SELECTOR = [
    '[data-uia*="video-title"]',
    'h1',
    'h2'
  ].join(', ');
  var TITLE_STOP_WORDS = [
    'play',
    'resume',
    'my list',
    'remove from my list',
    'downloads',
    'audio and subtitles',
    'more info',
    'more information',
    'next episode',
    'next',
    'previous',
    'details',
    'close',
    'mute',
    'unmute',
    'skip intro',
    'skip recap',
    'episodes',
    'trailers and more',
    'search',
    'help'
  ];

  function createApp(env) {
    var state = {
      omdbApiKey: null,
      cache: new Map(),
      inFlight: new Map(),
      scanTimer: null,
      observer: null,
      setupPanel: null
    };

    var mergedEnv = Object.assign({
      getValue: function () {
        return Promise.resolve(null);
      },
      setValue: function () {
        return Promise.resolve();
      },
      requestJson: function () {
        return Promise.reject(new Error('No requestJson implementation provided.'));
      },
      registerMenuCommand: null,
      logger: function () {
        return undefined;
      }
    }, env || {});

    function log() {
      try {
        mergedEnv.logger.apply(null, arguments);
      } catch (error) {
        console.debug('[Netflix Ratings]', error);
      }
    }

    async function init() {
      injectStyles();
      registerMenuCommands();
      state.omdbApiKey = await mergedEnv.getValue(STORAGE_KEYS.omdbApiKey);
      wireNavigation();
      observeDom();
      scanSoon();
    }

    function registerMenuCommands() {
      if (typeof mergedEnv.registerMenuCommand !== 'function') {
        return;
      }

      mergedEnv.registerMenuCommand('Netflix Ratings: Set OMDb API key', function () {
        promptForApiKey();
      });

      mergedEnv.registerMenuCommand('Netflix Ratings: Clear OMDb API key', async function () {
        await saveApiKey('');
      });
    }

    function wireNavigation() {
      if (!global.__nroHistoryPatched) {
        ['pushState', 'replaceState'].forEach(function (methodName) {
          var original = global.history[methodName];
          if (typeof original !== 'function') {
            return;
          }
          global.history[methodName] = function patchedHistoryMethod() {
            var result = original.apply(this, arguments);
            global.dispatchEvent(new Event('nro:navigation'));
            return result;
          };
        });
        global.__nroHistoryPatched = true;
      }

      global.addEventListener('nro:navigation', scanSoon);
      global.addEventListener('popstate', scanSoon);
      global.addEventListener('scroll', scanSoon, { passive: true });
      global.addEventListener('resize', scanSoon, { passive: true });
    }

    function observeDom() {
      if (state.observer) {
        return;
      }

      state.observer = new MutationObserver(function () {
        scanSoon();
      });

      state.observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    function scanSoon() {
      if (state.scanTimer) {
        global.clearTimeout(state.scanTimer);
      }

      state.scanTimer = global.setTimeout(function () {
        state.scanTimer = null;
        scanPage().catch(function (error) {
          log('scan failed', error);
        });
      }, 180);
    }

    async function scanPage() {
      if (!state.omdbApiKey) {
        renderSetupPanel('Add your OMDb API key to show IMDb ratings next to Netflix titles in the detail view.');
        clearBadges();
        return;
      }

      removeSetupPanel();

      var targets = collectTargets();
      for (var index = 0; index < targets.length; index += 1) {
        await processTarget(targets[index]);
      }
    }

    function collectTargets() {
      var targetMap = new Map();

      document.querySelectorAll(DETAIL_ROOT_SELECTOR).forEach(function (root) {
        var titleNode = root.querySelector(DETAIL_TITLE_SELECTOR);
        if (!titleNode) {
          return;
        }

        var title = extractCleanTitle(titleNode);
        if (!title) {
          return;
        }

        if (!targetMap.has(titleNode)) {
          targetMap.set(titleNode, {
            root: root,
            titleNode: titleNode,
            title: title
          });
        }
      });

      return Array.from(targetMap.values());
    }

    async function processTarget(target) {
      if (!target.root.isConnected || !target.titleNode.isConnected) {
        return;
      }

      var mount = ensureMount(target.titleNode);
      var queryKey = normalizeComparable(target.title);

      if (mount.dataset.nroQueryKey === queryKey && mount.dataset.nroStatus === 'ready') {
        return;
      }

      mount.dataset.nroQueryKey = queryKey;
      renderLoading(mount);

      var result = await lookupImdb(target.title);
      if (!target.titleNode.isConnected || mount.dataset.nroQueryKey !== queryKey) {
        return;
      }

      if (result.error) {
        mount.dataset.nroStatus = 'error';
        renderUnavailable(mount, result.error, result.imdbUrl);
        return;
      }

      mount.dataset.nroStatus = 'ready';
      renderRating(mount, result);
    }

    async function lookupImdb(title) {
      var queryKey = normalizeComparable(title);

      if (state.cache.has(queryKey)) {
        return state.cache.get(queryKey);
      }

      if (state.inFlight.has(queryKey)) {
        return state.inFlight.get(queryKey);
      }

      var task = (async function () {
        try {
          var searchData = await mergedEnv.requestJson({
            url: buildOmdbUrl({
              s: title
            })
          });

          if (searchData && searchData.Response === 'False') {
            if (isApiKeyError(searchData.Error)) {
              return unavailableResult(title, searchData.Error);
            }
            return unavailableResult(title, 'No OMDb title match was found.');
          }

          var candidates = Array.isArray(searchData.Search) ? searchData.Search : [];
          var bestMatch = pickBestMatch(candidates, title);
          if (!bestMatch || !bestMatch.imdbID) {
            return unavailableResult(title, 'No close OMDb title match was found.');
          }

          var detailData = await mergedEnv.requestJson({
            url: buildOmdbUrl({
              i: bestMatch.imdbID
            })
          });

          if (detailData && detailData.Response === 'False') {
            if (isApiKeyError(detailData.Error)) {
              return unavailableResult(title, detailData.Error, {
                imdbUrl: 'https://www.imdb.com/title/' + encodeURIComponent(bestMatch.imdbID) + '/'
              });
            }
            return unavailableResult(title, 'OMDb returned no IMDb rating for this title.', {
              imdbUrl: 'https://www.imdb.com/title/' + encodeURIComponent(bestMatch.imdbID) + '/'
            });
          }

          var rating = detailData.imdbRating && detailData.imdbRating !== 'N/A'
            ? detailData.imdbRating
            : null;

          var result = {
            title: detailData.Title || title,
            imdbId: detailData.imdbID || bestMatch.imdbID,
            imdbUrl: 'https://www.imdb.com/title/' + encodeURIComponent(detailData.imdbID || bestMatch.imdbID) + '/',
            imdbRating: rating,
            error: rating ? null : 'OMDb did not provide an IMDb rating for this title.'
          };

          state.cache.set(queryKey, result);
          return result;
        } catch (error) {
          return unavailableResult(title, error && error.message ? error.message : 'OMDb lookup failed.');
        } finally {
          state.inFlight.delete(queryKey);
        }
      })();

      state.inFlight.set(queryKey, task);
      return task;
    }

    function buildOmdbUrl(params) {
      var url = new URL('https://www.omdbapi.com/');
      url.searchParams.set('apikey', state.omdbApiKey);

      Object.keys(params).forEach(function (key) {
        if (params[key]) {
          url.searchParams.set(key, String(params[key]));
        }
      });

      return url.toString();
    }

    function pickBestMatch(candidates, desiredTitle) {
      var normalizedDesired = normalizeComparable(desiredTitle);

      var ranked = candidates
        .map(function (candidate) {
          return {
            candidate: candidate,
            score: scoreTitle(candidate.Title, normalizedDesired)
          };
        })
        .sort(function (left, right) {
          return right.score - left.score;
        });

      return ranked.length && ranked[0].score >= 24 ? ranked[0].candidate : null;
    }

    function scoreTitle(candidateTitle, desiredTitle) {
      var comparable = normalizeComparable(candidateTitle);

      if (!comparable) {
        return 0;
      }

      if (comparable === desiredTitle) {
        return 120;
      }

      if (comparable.indexOf(desiredTitle) !== -1 || desiredTitle.indexOf(comparable) !== -1) {
        return 80;
      }

      return tokenOverlapScore(comparable, desiredTitle);
    }

    function tokenOverlapScore(left, right) {
      var leftTokens = left.split(' ').filter(Boolean);
      var rightTokens = right.split(' ').filter(Boolean);
      var overlap = 0;

      leftTokens.forEach(function (token) {
        if (rightTokens.indexOf(token) !== -1) {
          overlap += 12;
        }
      });

      return overlap;
    }

    function unavailableResult(title, error, seed) {
      return Object.assign({
        title: title,
        imdbId: null,
        imdbUrl: 'https://www.imdb.com/find/?q=' + encodeURIComponent(title),
        imdbRating: null,
        error: error
      }, seed || {});
    }

    function ensureMount(titleNode) {
      var sibling = titleNode.nextElementSibling;
      if (sibling && sibling.classList.contains('nro-imdb-host')) {
        return sibling;
      }

      var mount = document.createElement('span');
      mount.className = 'nro-imdb-host';
      titleNode.insertAdjacentElement('afterend', mount);
      return mount;
    }

    function renderLoading(mount) {
      mount.replaceChildren();

      var text = document.createElement('span');
      text.className = 'nro-imdb-badge nro-imdb-badge-loading';
      text.textContent = 'IMDb ...';
      mount.appendChild(text);
    }

    function renderRating(mount, rating) {
      mount.replaceChildren();

      if (!rating.imdbRating) {
        renderUnavailable(mount, rating.error || 'IMDb rating unavailable.', rating.imdbUrl);
        return;
      }

      var badge = document.createElement('a');
      badge.className = 'nro-imdb-badge';
      badge.href = rating.imdbUrl;
      badge.target = '_blank';
      badge.rel = 'noreferrer';
      badge.textContent = 'IMDb ' + String(rating.imdbRating);
      mount.appendChild(badge);
    }

    function renderUnavailable(mount, errorMessage, imdbUrl) {
      mount.replaceChildren();

      var badge = document.createElement('a');
      badge.className = 'nro-imdb-badge nro-imdb-badge-muted';
      badge.href = imdbUrl || '#';
      badge.target = '_blank';
      badge.rel = 'noreferrer';
      badge.textContent = 'IMDb n/a';
      badge.title = errorMessage;
      mount.appendChild(badge);
    }

    function clearBadges() {
      document.querySelectorAll('.nro-imdb-host').forEach(function (node) {
        node.remove();
      });
    }

    function renderSetupPanel(message) {
      if (!document.body) {
        return;
      }

      if (!state.setupPanel) {
        state.setupPanel = document.createElement('div');
        state.setupPanel.className = 'nro-setup-panel';

        var copy = document.createElement('div');
        copy.className = 'nro-setup-copy';

        var title = document.createElement('strong');
        title.textContent = 'IMDb Ratings Setup';

        var text = document.createElement('span');
        text.className = 'nro-setup-text';

        var actionRow = document.createElement('div');
        actionRow.className = 'nro-setup-actions';

        var configureButton = document.createElement('button');
        configureButton.type = 'button';
        configureButton.className = 'nro-setup-button';
        configureButton.textContent = 'Add OMDb key';
        configureButton.addEventListener('click', function () {
          promptForApiKey();
        });

        var docsLink = document.createElement('a');
        docsLink.href = 'https://www.omdbapi.com/apikey.aspx';
        docsLink.target = '_blank';
        docsLink.rel = 'noreferrer';
        docsLink.className = 'nro-setup-link';
        docsLink.textContent = 'Get OMDb key';

        copy.appendChild(title);
        copy.appendChild(text);
        actionRow.appendChild(configureButton);
        actionRow.appendChild(docsLink);
        state.setupPanel.appendChild(copy);
        state.setupPanel.appendChild(actionRow);
        document.body.appendChild(state.setupPanel);
      }

      var textNode = state.setupPanel.querySelector('.nro-setup-text');
      if (textNode) {
        textNode.textContent = message;
      }
    }

    function removeSetupPanel() {
      if (!state.setupPanel) {
        return;
      }

      state.setupPanel.remove();
      state.setupPanel = null;
    }

    async function promptForApiKey() {
      var response = global.prompt(
        [
          'Enter your OMDb API key.',
          'Get one at https://www.omdbapi.com/apikey.aspx',
          'Leave blank to remove the saved key.'
        ].join('\n'),
        state.omdbApiKey || ''
      );

      if (response === null) {
        return;
      }

      await saveApiKey(response.trim());
    }

    async function saveApiKey(value) {
      state.omdbApiKey = value || null;
      state.cache.clear();
      state.inFlight.clear();
      await mergedEnv.setValue(STORAGE_KEYS.omdbApiKey, state.omdbApiKey);
      scanSoon();
    }

    function extractCleanTitle(titleNode) {
      var clone = titleNode.cloneNode(true);
      clone.querySelectorAll('.nro-imdb-host').forEach(function (node) {
        node.remove();
      });
      return cleanTitle(clone.textContent);
    }

    function cleanTitle(value) {
      if (!value) {
        return null;
      }

      var cleaned = String(value)
        .replace(/\s+/g, ' ')
        .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
        .replace(/^(play|resume|details|more info(?:rmation)?|episodes|watch|next episode)\s*:?\s+/i, '')
        .replace(/\((19|20)\d{2}\)$/g, '')
        .trim();

      if (!cleaned || cleaned.length < 2 || cleaned.length > 120) {
        return null;
      }

      if (!/[a-z0-9]/i.test(cleaned)) {
        return null;
      }

      if (TITLE_STOP_WORDS.indexOf(cleaned.toLowerCase()) !== -1) {
        return null;
      }

      return cleaned;
    }

    function normalizeComparable(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isApiKeyError(message) {
      return /api key|request limit/i.test(String(message || ''));
    }

    function injectStyles() {
      if (document.getElementById('nro-styles')) {
        return;
      }

      var style = document.createElement('style');
      style.id = 'nro-styles';
      style.textContent = [
        '.nro-imdb-host { display: inline-flex; align-items: center; margin-left: 10px; vertical-align: middle; }',
        '.nro-imdb-badge { display: inline-flex; align-items: center; border: 0; border-radius: 999px; padding: 4px 9px; font: 700 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-decoration: none; color: #19160a; background: linear-gradient(135deg, #f6d55b, #f4bf1a); box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22); cursor: pointer; }',
        '.nro-imdb-badge-loading { color: #302608; opacity: 0.9; }',
        '.nro-imdb-badge-muted { color: #eef2f6; background: rgba(58, 63, 74, 0.92); }',
        '.nro-setup-panel { position: fixed; right: 20px; bottom: 20px; z-index: 999999; max-width: min(430px, calc(100vw - 32px)); padding: 14px 16px; border-radius: 18px; color: #fff; background: linear-gradient(135deg, rgba(18, 24, 34, 0.96), rgba(28, 14, 7, 0.96)); border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45); backdrop-filter: blur(12px); }',
        '.nro-setup-copy { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }',
        '.nro-setup-copy strong { font: 700 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
        '.nro-setup-text { font: 500 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: rgba(255, 255, 255, 0.86); }',
        '.nro-setup-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }',
        '.nro-setup-button { border: 0; border-radius: 999px; padding: 9px 14px; font: 700 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #161005; background: #f4bf1a; cursor: pointer; }',
        '.nro-setup-link { color: #fff; font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-decoration: underline; text-underline-offset: 2px; }'
      ].join('\n');

      document.head.appendChild(style);
    }

    return {
      init: init,
      promptForApiKey: promptForApiKey
    };
  }

  global.NetflixRatingsCore = {
    createApp: createApp
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
