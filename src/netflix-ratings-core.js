(function initNetflixRatingsCore(global) {
  'use strict';

  if (global.NetflixRatingsCore) {
    return;
  }

  var STORAGE_KEYS = {
    omdbApiKey: 'nro.omdbApiKey',
    cache: 'nro.omdbCacheV1'
  };
  var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var CACHE_MAX_ENTRIES = 400;

  var DETAIL_ROOT_SELECTOR = '.previewModal--wrapper, .previewModal--container, .jawBone, .billboard-row, main';
  var DETAIL_TITLE_SELECTOR = [
    '[data-uia*="video-title"]',
    'h1',
    'h2'
  ].join(', ');
  var DETAIL_MOUNT_SELECTOR = [
    '.previewModal--detailsMetadata-right > div:first-child',
    '.previewModal--detailsMetadata > div:first-child',
    '.previewModal--metadatAndControls-info > div:first-child',
    '.billboard-info [class*="meta"]',
    '.billboard-row [class*="meta"]',
    '.jawBone [class*="meta"]',
    '.jawBoneContainer [class*="meta"]'
  ].join(', ');
  var DETAIL_FALLBACK_SELECTOR = [
    '.previewModal--metadatAndControls-info',
    '.previewModal--detailsMetadata',
    '.previewModal--detailsMetadata-right',
    '.jawBoneContainer',
    '.billboard-info',
    '.billboard-row .info',
    'main'
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
      setupPanel: null,
      cachePersistTimer: null
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
      state.cache = await loadPersistentCache();
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
        var title = extractTitleFromRoot(root, titleNode);
        if (!title) {
          return;
        }

        var anchorNode = titleNode || root.querySelector(DETAIL_MOUNT_SELECTOR) || root;
        if (!targetMap.has(root)) {
          targetMap.set(root, {
            root: root,
            anchorNode: anchorNode,
            titleNode: titleNode,
            title: title
          });
        }
      });

      return Array.from(targetMap.values());
    }

    async function processTarget(target) {
      if (!target.root.isConnected || !target.anchorNode.isConnected) {
        return;
      }

      var mount = ensureMount(target);
      if (!mount) {
        return;
      }

      var queryKey = normalizeComparable(target.title);

      if (mount.dataset.nroQueryKey === queryKey && mount.dataset.nroStatus === 'ready') {
        return;
      }

      mount.dataset.nroQueryKey = queryKey;
      renderLoading(mount);

      var result = await lookupImdb(target.title);
      if (!target.root.isConnected || mount.dataset.nroQueryKey !== queryKey) {
        return;
      }

      if (result.error) {
        mount.dataset.nroStatus = 'ready';
        renderUnavailable(mount, result.error, result.imdbUrl);
        return;
      }

      mount.dataset.nroStatus = 'ready';
      renderRating(mount, result);
    }

    async function lookupImdb(title) {
      var queryKey = normalizeComparable(title);
      var cached = getCachedResult(queryKey);
      if (cached) {
        return cached;
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
            var noSearchMatch = unavailableResult(title, 'No OMDb title match was found.');
            cacheResult(queryKey, noSearchMatch);
            return noSearchMatch;
          }

          var candidates = Array.isArray(searchData.Search) ? searchData.Search : [];
          var bestMatch = pickBestMatch(candidates, title);
          if (!bestMatch || !bestMatch.imdbID) {
            var noBestMatch = unavailableResult(title, 'No close OMDb title match was found.');
            cacheResult(queryKey, noBestMatch);
            return noBestMatch;
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
            var noDetailRating = unavailableResult(title, 'OMDb returned no IMDb rating for this title.', {
              imdbUrl: 'https://www.imdb.com/title/' + encodeURIComponent(bestMatch.imdbID) + '/'
            });
            cacheResult(queryKey, noDetailRating);
            return noDetailRating;
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

          cacheResult(queryKey, result);
          return result;
        } catch (error) {
          var failure = unavailableResult(title, error && error.message ? error.message : 'OMDb lookup failed.');
          if (shouldPersistResult(failure)) {
            cacheResult(queryKey, failure);
          }
          return failure;
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

    function getCachedResult(queryKey) {
      var entry = state.cache.get(queryKey);
      if (!entry) {
        return null;
      }

      if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
        state.cache.delete(queryKey);
        scheduleCachePersist();
        return null;
      }

      entry.updatedAt = Date.now();
      return entry.result;
    }

    function cacheResult(queryKey, result) {
      state.cache.set(queryKey, {
        result: result,
        updatedAt: Date.now(),
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      trimCache();
      scheduleCachePersist();
    }

    function shouldPersistResult(result) {
      if (!result) {
        return false;
      }

      if (!result.error) {
        return true;
      }

      if (isApiKeyError(result.error)) {
        return false;
      }

      return !/lookup failed|network request failed|http\s\d+/i.test(String(result.error));
    }

    async function loadPersistentCache() {
      var raw = await mergedEnv.getValue(STORAGE_KEYS.cache);
      if (!raw) {
        return new Map();
      }

      try {
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
        var nextCache = new Map();
        var now = Date.now();

        entries.forEach(function (entry) {
          if (
            entry &&
            typeof entry.key === 'string' &&
            entry.value &&
            entry.value.result &&
            entry.value.expiresAt > now
          ) {
            nextCache.set(entry.key, entry.value);
          }
        });

        return nextCache;
      } catch (error) {
        log('cache load failed', error);
        return new Map();
      }
    }

    function scheduleCachePersist() {
      if (state.cachePersistTimer) {
        global.clearTimeout(state.cachePersistTimer);
      }

      state.cachePersistTimer = global.setTimeout(function () {
        state.cachePersistTimer = null;
        persistCache().catch(function (error) {
          log('cache persist failed', error);
        });
      }, 250);
    }

    async function persistCache() {
      trimCache();
      var payload = {
        entries: Array.from(state.cache.entries()).map(function (entry) {
          return {
            key: entry[0],
            value: entry[1]
          };
        })
      };
      await mergedEnv.setValue(STORAGE_KEYS.cache, JSON.stringify(payload));
    }

    function trimCache() {
      var now = Date.now();
      Array.from(state.cache.entries()).forEach(function (entry) {
        if (!entry[1].expiresAt || entry[1].expiresAt <= now) {
          state.cache.delete(entry[0]);
        }
      });

      if (state.cache.size <= CACHE_MAX_ENTRIES) {
        return;
      }

      var ranked = Array.from(state.cache.entries()).sort(function (left, right) {
        return (right[1].updatedAt || 0) - (left[1].updatedAt || 0);
      });

      state.cache = new Map(ranked.slice(0, CACHE_MAX_ENTRIES));
    }

    function ensureMount(target) {
      var existing = target.root.querySelector('.nro-imdb-host');
      if (existing) {
        return existing;
      }

      var mountContainer = target.root.querySelector(DETAIL_MOUNT_SELECTOR);
      var mount = document.createElement('span');
      mount.className = 'nro-imdb-host';
      var fallbackContainer = target.root.querySelector(DETAIL_FALLBACK_SELECTOR);

      if (mountContainer) {
        mountContainer.appendChild(mount);
      } else if (fallbackContainer && fallbackContainer.parentNode) {
        fallbackContainer.insertAdjacentElement('afterend', mount);
      } else if (target.titleNode && target.titleNode.parentNode) {
        target.titleNode.insertAdjacentElement('afterend', mount);
      } else if (target.anchorNode && target.anchorNode.parentNode) {
        target.anchorNode.insertAdjacentElement('afterbegin', mount);
      } else {
        target.root.insertAdjacentElement('afterbegin', mount);
      }

      return mount;
    }

    function renderLoading(mount) {
      mount.style.display = 'inline-flex';
      mount.replaceChildren();

      var text = document.createElement('span');
      text.className = 'nro-imdb-badge nro-imdb-badge-loading';
      text.textContent = 'IMDb ...';
      mount.appendChild(text);
    }

    function renderRating(mount, rating) {
      mount.style.display = 'inline-flex';
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
      mount.style.display = 'inline-flex';
      mount.replaceChildren();

      var badge = document.createElement('a');
      badge.className = 'nro-imdb-badge nro-imdb-badge-muted';
      badge.href = imdbUrl || '#';
      badge.target = '_blank';
      badge.rel = 'noreferrer';
      badge.textContent = 'IMDb n/a';
      badge.title = errorMessage || 'IMDb rating not available.';
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
      await mergedEnv.setValue(STORAGE_KEYS.cache, '');
      scanSoon();
    }

    function extractTitleFromRoot(root, titleNode) {
      var candidates = [];

      addTitleCandidate(candidates, titleNode ? titleNode.textContent : null, 140);
      addTitleCandidate(candidates, textFrom(root, '[data-uia*="video-title"]'), 135);
      addTitleCandidate(candidates, textFrom(root, 'h1'), 130);
      addTitleCandidate(candidates, textFrom(root, 'h2'), 120);
      addTitleCandidate(candidates, textFrom(root, 'h3'), 110);

      root.querySelectorAll('img[alt]').forEach(function (image, index) {
        if (index < 6) {
          addTitleCandidate(candidates, image.getAttribute('alt'), 100 - index);
        }
      });

      root.querySelectorAll('[aria-label]').forEach(function (element, index) {
        if (index < 10) {
          addTitleCandidate(candidates, element.getAttribute('aria-label'), 80 - index);
        }
      });

      root.querySelectorAll('[class*="title"], [class*="Title"], [class*="logo"], [class*="fallback-text"]').forEach(function (element, index) {
        if (index < 10) {
          addTitleCandidate(candidates, element.textContent, 90 - index);
        }
      });

      addTitleCandidate(candidates, document.querySelector('main h1') && document.querySelector('main h1').textContent, 125);

      candidates.sort(function (left, right) {
        return right.score - left.score;
      });

      return candidates.length ? candidates[0].title : null;
    }

    function addTitleCandidate(bucket, value, score) {
      var cleaned = cleanTitle(value);
      if (!cleaned) {
        return;
      }

      bucket.push({
        title: cleaned,
        score: score
      });
    }

    function textFrom(root, selector) {
      var node = root.querySelector(selector);
      return node ? node.textContent : null;
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
        '.nro-imdb-host { display: inline-flex; align-items: center; margin-left: 8px; vertical-align: middle; }',
        '.previewModal--metadatAndControls-info + .nro-imdb-host, .previewModal--detailsMetadata + .nro-imdb-host, .previewModal--detailsMetadata-right + .nro-imdb-host, .jawBoneContainer + .nro-imdb-host, .billboard-info + .nro-imdb-host, .billboard-row .info + .nro-imdb-host { display: flex; margin: 8px 0 0; }',
        '.nro-imdb-badge { display: inline-flex; align-items: center; border: 0; border-radius: 999px; padding: 2px 8px; font: 700 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-decoration: none; color: #19160a; background: linear-gradient(135deg, #f6d55b, #f4bf1a); box-shadow: 0 4px 10px rgba(0, 0, 0, 0.16); cursor: pointer; }',
        '.nro-imdb-badge-loading { color: #302608; opacity: 0.9; }',
        '.nro-imdb-badge-muted { color: rgba(255, 255, 255, 0.92); background: rgba(86, 93, 108, 0.82); box-shadow: none; }',
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
