(function initNetflixRatingsCore(global) {
  'use strict';

  if (global.NetflixRatingsCore) {
    return;
  }

  var STORAGE_KEYS = {
    apiKey: 'nro.omdbApiKey'
  };

  var CARD_SCAN_LIMIT = 14;
  var CARD_ROOT_SELECTOR = '.title-card-container, .slider-item';
  var DETAIL_ROOT_SELECTOR = '.previewModal--wrapper, .previewModal--container, .jawBone, .billboard-row';
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
      apiKey: null,
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
      state.apiKey = await mergedEnv.getValue(STORAGE_KEYS.apiKey);
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
      if (!state.apiKey) {
        renderSetupPanel('Add your OMDb API key to enable IMDb and Rotten Tomatoes ratings.');
        return;
      }

      removeSetupPanel();

      var targets = collectTargets();
      var cardCount = 0;

      for (var index = 0; index < targets.length; index += 1) {
        var target = targets[index];

        if (!target.root || !target.root.isConnected) {
          continue;
        }

        if (target.kind === 'card') {
          if (!isNearViewport(target.root)) {
            continue;
          }

          if (cardCount >= CARD_SCAN_LIMIT) {
            continue;
          }

          cardCount += 1;
        }

        var meta = extractTitleMeta(target.root, target.kind);
        if (!meta || !meta.title) {
          continue;
        }

        await processTarget(target, meta);
      }
    }

    function collectTargets() {
      var targetMap = new Map();

      function addTarget(root, kind) {
        if (!root || targetMap.has(root)) {
          return;
        }
        targetMap.set(root, { root: root, kind: kind });
      }

      var mainTitle = document.querySelector('main h1, main [data-uia*="video-title"]');
      if (mainTitle) {
        addTarget(mainTitle.closest('main') || mainTitle.parentElement, 'detail');
      }

      document.querySelectorAll(DETAIL_ROOT_SELECTOR).forEach(function (root) {
        addTarget(root, 'detail');
      });

      document.querySelectorAll(CARD_ROOT_SELECTOR).forEach(function (root) {
        addTarget(root, 'card');
      });

      document.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]').forEach(function (link) {
        var root = link.closest(DETAIL_ROOT_SELECTOR) || link.closest(CARD_ROOT_SELECTOR);
        if (!root) {
          return;
        }
        addTarget(root, root.matches(CARD_ROOT_SELECTOR) ? 'card' : 'detail');
      });

      return Array.from(targetMap.values()).sort(function (left, right) {
        return left.root.getBoundingClientRect().top - right.root.getBoundingClientRect().top;
      });
    }

    async function processTarget(target, meta) {
      var mount = ensureMount(target.root, target.kind);
      if (!mount) {
        return;
      }

      var queryKey = buildQueryKey(meta);
      if (mount.dataset.nroQueryKey === queryKey && mount.dataset.nroStatus === 'ready') {
        return;
      }

      mount.dataset.nroQueryKey = queryKey;

      var result = await lookupRatings(meta);

      if (!target.root.isConnected || mount.dataset.nroQueryKey !== queryKey) {
        return;
      }

      if (result.error) {
        mount.dataset.nroStatus = 'error';

        if (isApiKeyError(result.error)) {
          renderSetupPanel(result.error);
        }

        if (target.kind === 'detail') {
          renderError(mount, result.error);
        } else {
          mount.replaceChildren();
        }
        return;
      }

      renderRatings(mount, result, target.kind);
      mount.dataset.nroStatus = 'ready';
    }

    async function lookupRatings(meta) {
      var queryKey = buildQueryKey(meta);

      if (state.cache.has(queryKey)) {
        return state.cache.get(queryKey);
      }

      if (state.inFlight.has(queryKey)) {
        return state.inFlight.get(queryKey);
      }

      var task = (async function () {
        try {
          var searchUrl = buildOmdbUrl({
            s: meta.title,
            y: meta.year,
            type: meta.type
          });

          var searchData = await mergedEnv.requestJson(searchUrl);
          if (searchData && searchData.Response === 'False') {
            if (isApiKeyError(searchData.Error)) {
              return { error: searchData.Error };
            }
            return emptyRatings(meta.title);
          }

          var bestMatch = pickBestMatch(searchData && searchData.Search, meta);
          if (!bestMatch || !bestMatch.imdbID) {
            return emptyRatings(meta.title);
          }

          var detailData = await mergedEnv.requestJson(buildOmdbUrl({ i: bestMatch.imdbID }));
          if (detailData && detailData.Response === 'False') {
            if (isApiKeyError(detailData.Error)) {
              return { error: detailData.Error };
            }
            return emptyRatings(meta.title);
          }

          var ratings = normalizeRatings(detailData, meta.title);
          state.cache.set(queryKey, ratings);
          return ratings;
        } catch (error) {
          return { error: error && error.message ? error.message : 'Lookup failed.' };
        } finally {
          state.inFlight.delete(queryKey);
        }
      })();

      state.inFlight.set(queryKey, task);
      return task;
    }

    function buildOmdbUrl(params) {
      var url = new URL('https://www.omdbapi.com/');
      url.searchParams.set('apikey', state.apiKey);

      Object.keys(params).forEach(function (key) {
        if (params[key]) {
          url.searchParams.set(key, String(params[key]));
        }
      });

      return url.toString();
    }

    function pickBestMatch(results, meta) {
      if (!Array.isArray(results) || !results.length) {
        return null;
      }

      var desiredTitle = normalizeComparable(meta.title);

      return results
        .map(function (result) {
          return {
            result: result,
            score: scoreResult(result, desiredTitle, meta)
          };
        })
        .sort(function (left, right) {
          return right.score - left.score;
        })[0].result;
    }

    function scoreResult(result, desiredTitle, meta) {
      var score = 0;
      var actualTitle = normalizeComparable(result.Title);

      if (actualTitle === desiredTitle) {
        score += 120;
      } else if (actualTitle.indexOf(desiredTitle) !== -1 || desiredTitle.indexOf(actualTitle) !== -1) {
        score += 80;
      } else {
        score += tokenOverlapScore(actualTitle, desiredTitle);
      }

      if (meta.type && result.Type === meta.type) {
        score += 15;
      }

      var resultYear = extractYear(result.Year);
      if (meta.year && resultYear) {
        if (meta.year === resultYear) {
          score += 25;
        } else if (Math.abs(meta.year - resultYear) === 1) {
          score += 10;
        }
      }

      return score;
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

    function normalizeRatings(detailData, fallbackTitle) {
      var imdbRating = detailData.imdbRating && detailData.imdbRating !== 'N/A'
        ? detailData.imdbRating
        : null;

      var rottenTomatoes = null;
      if (Array.isArray(detailData.Ratings)) {
        detailData.Ratings.forEach(function (entry) {
          if (entry.Source === 'Rotten Tomatoes') {
            rottenTomatoes = entry.Value;
          }
        });
      }

      var resolvedTitle = detailData.Title || fallbackTitle;

      return {
        title: resolvedTitle,
        imdbId: detailData.imdbID || null,
        imdbRating: imdbRating,
        rottenTomatoes: rottenTomatoes,
        imdbUrl: detailData.imdbID
          ? 'https://www.imdb.com/title/' + encodeURIComponent(detailData.imdbID) + '/'
          : 'https://www.imdb.com/find/?q=' + encodeURIComponent(resolvedTitle),
        rottenTomatoesUrl: 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(resolvedTitle)
      };
    }

    function emptyRatings(title) {
      return {
        title: title,
        imdbId: null,
        imdbRating: null,
        rottenTomatoes: null,
        imdbUrl: 'https://www.imdb.com/find/?q=' + encodeURIComponent(title),
        rottenTomatoesUrl: 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(title)
      };
    }

    function extractTitleMeta(root, kind) {
      var candidates = [];

      addCandidate(candidates, textFrom(root, '[data-uia*="video-title"]'), 140);
      addCandidate(candidates, textFrom(root, 'h1'), 130);
      addCandidate(candidates, textFrom(root, 'h2'), 120);
      addCandidate(candidates, textFrom(root, 'h3'), 110);

      root.querySelectorAll('img[alt]').forEach(function (image, index) {
        if (index < 6) {
          addCandidate(candidates, image.getAttribute('alt'), 100 - index);
        }
      });

      root.querySelectorAll('[aria-label]').forEach(function (element, index) {
        if (index < 12) {
          addCandidate(candidates, element.getAttribute('aria-label'), 70 - index);
        }
      });

      root.querySelectorAll('[class*="title"], [class*="Title"], [class*="logo"], [class*="fallback-text"]').forEach(function (element, index) {
        if (index < 10) {
          addCandidate(candidates, element.textContent, 90 - index);
        }
      });

      if (kind === 'detail') {
        addCandidate(candidates, document.querySelector('main h1') && document.querySelector('main h1').textContent, 150);
      }

      candidates.sort(function (left, right) {
        return right.score - left.score;
      });

      var bestTitle = candidates.length ? candidates[0].title : null;
      if (!bestTitle) {
        return null;
      }

      return {
        title: bestTitle,
        year: extractYear(root.textContent),
        type: extractType(root.textContent)
      };
    }

    function addCandidate(bucket, rawTitle, score) {
      var cleaned = cleanTitle(rawTitle);
      if (!cleaned) {
        return;
      }
      bucket.push({
        title: cleaned,
        score: score
      });
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

      var lowered = cleaned.toLowerCase();
      if (TITLE_STOP_WORDS.indexOf(lowered) !== -1) {
        return null;
      }

      if (/^(season|episode)\b/i.test(cleaned)) {
        return null;
      }

      if (/^(tv|movie)\b$/i.test(cleaned)) {
        return null;
      }

      return cleaned;
    }

    function extractYear(text) {
      if (!text) {
        return null;
      }

      var match = String(text).match(/\b(19\d{2}|20\d{2})\b/);
      return match ? Number(match[1]) : null;
    }

    function extractType(text) {
      if (!text) {
        return null;
      }

      var normalized = String(text).toLowerCase();
      if (
        normalized.indexOf('limited series') !== -1 ||
        normalized.indexOf('series') !== -1 ||
        normalized.indexOf('season') !== -1 ||
        normalized.indexOf('episodes') !== -1
      ) {
        return 'series';
      }

      if (normalized.indexOf('movie') !== -1 || normalized.indexOf('film') !== -1) {
        return 'movie';
      }

      return null;
    }

    function normalizeComparable(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function buildQueryKey(meta) {
      return [
        normalizeComparable(meta.title),
        meta.year || '',
        meta.type || ''
      ].join('|');
    }

    function ensureMount(root, kind) {
      var existing = root.querySelector(kind === 'detail' ? '.nro-inline-host' : '.nro-card-host');
      if (existing) {
        return existing;
      }

      var mount = document.createElement('div');

      if (kind === 'detail') {
        mount.className = 'nro-inline-host';
        var anchor = root.querySelector('[data-uia*="video-title"], h1, h2, h3');
        if (anchor && anchor.parentNode) {
          anchor.insertAdjacentElement('afterend', mount);
        } else {
          root.insertAdjacentElement('afterbegin', mount);
        }
      } else {
        mount.className = 'nro-card-host';
        root.classList.add('nro-card-root');
        root.appendChild(mount);
      }

      return mount;
    }

    function renderRatings(mount, ratings, kind) {
      mount.replaceChildren();

      var wrapper = document.createElement('div');
      wrapper.className = kind === 'detail' ? 'nro-badge-group nro-inline' : 'nro-badge-group nro-compact';

      if (!ratings.imdbRating && !ratings.rottenTomatoes) {
        var emptyPill = document.createElement('a');
        emptyPill.className = 'nro-pill nro-pill-muted';
        emptyPill.href = ratings.imdbUrl;
        emptyPill.target = '_blank';
        emptyPill.rel = 'noreferrer';
        emptyPill.textContent = 'Ratings n/a';
        wrapper.appendChild(emptyPill);
        mount.appendChild(wrapper);
        return;
      }

      wrapper.appendChild(createPill('IMDb', ratings.imdbRating || 'n/a', ratings.imdbUrl, 'imdb'));
      wrapper.appendChild(createPill('RT', ratings.rottenTomatoes || 'n/a', ratings.rottenTomatoesUrl, 'rt'));
      mount.appendChild(wrapper);
    }

    function renderError(mount, message) {
      mount.replaceChildren();

      var note = document.createElement('button');
      note.type = 'button';
      note.className = 'nro-error-note';
      note.textContent = 'Ratings unavailable';
      note.title = message;
      note.addEventListener('click', function () {
        promptForApiKey();
      });

      mount.appendChild(note);
    }

    function createPill(label, value, href, tone) {
      var pill = document.createElement('a');
      pill.className = 'nro-pill nro-pill-' + tone;
      pill.href = href;
      pill.target = '_blank';
      pill.rel = 'noreferrer';
      pill.textContent = label + ' ' + value;
      return pill;
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
        title.textContent = 'Netflix Ratings';

        var text = document.createElement('span');
        text.className = 'nro-setup-text';

        var actionRow = document.createElement('div');
        actionRow.className = 'nro-setup-actions';

        var actionButton = document.createElement('button');
        actionButton.type = 'button';
        actionButton.className = 'nro-setup-button';
        actionButton.textContent = 'Add OMDb API key';
        actionButton.addEventListener('click', function () {
          promptForApiKey();
        });

        var link = document.createElement('a');
        link.href = 'https://www.omdbapi.com/apikey.aspx';
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.className = 'nro-setup-link';
        link.textContent = 'Get a free key';

        copy.appendChild(title);
        copy.appendChild(text);
        actionRow.appendChild(actionButton);
        actionRow.appendChild(link);
        state.setupPanel.appendChild(copy);
        state.setupPanel.appendChild(actionRow);
        document.body.appendChild(state.setupPanel);
      }

      var textNode = state.setupPanel.querySelector('.nro-setup-text');
      if (textNode) {
        textNode.textContent = message || 'Add your OMDb API key to enable ratings.';
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
      var promptMessage = [
        'Enter your OMDb API key.',
        'Get one at https://www.omdbapi.com/apikey.aspx',
        'Leave blank to remove the saved key.'
      ].join('\n');

      var response = global.prompt(promptMessage, state.apiKey || '');
      if (response === null) {
        return;
      }

      await saveApiKey(response.trim());
    }

    async function saveApiKey(value) {
      state.apiKey = value || null;
      state.cache.clear();
      await mergedEnv.setValue(STORAGE_KEYS.apiKey, state.apiKey);
      scanSoon();
    }

    function isNearViewport(element) {
      var rect = element.getBoundingClientRect();
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > -180 &&
        rect.top < global.innerHeight + 320;
    }

    function isApiKeyError(message) {
      return /api key|request limit/i.test(String(message || ''));
    }

    function textFrom(root, selector) {
      var node = root.querySelector(selector);
      return node ? node.textContent : null;
    }

    function injectStyles() {
      if (document.getElementById('nro-styles')) {
        return;
      }

      var style = document.createElement('style');
      style.id = 'nro-styles';
      style.textContent = [
        '.nro-inline-host { margin-top: 10px; }',
        '.nro-card-root { position: relative !important; }',
        '.nro-card-host { position: absolute; top: 10px; left: 10px; z-index: 3; pointer-events: none; }',
        '.nro-card-host .nro-badge-group { pointer-events: auto; }',
        '.nro-badge-group { display: flex; gap: 8px; flex-wrap: wrap; }',
        '.nro-pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 6px 10px; font: 600 12px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0.01em; text-decoration: none; color: #fff; background: rgba(13, 16, 24, 0.88); border: 1px solid rgba(255, 255, 255, 0.16); box-shadow: 0 10px 22px rgba(0, 0, 0, 0.28); backdrop-filter: blur(8px); }',
        '.nro-pill:hover { transform: translateY(-1px); border-color: rgba(255, 255, 255, 0.26); }',
        '.nro-pill-imdb { background: rgba(245, 197, 24, 0.92); color: #1b1b1b; border-color: rgba(255, 215, 79, 0.65); }',
        '.nro-pill-rt { background: rgba(250, 72, 46, 0.92); color: #fff7f5; border-color: rgba(255, 145, 130, 0.55); }',
        '.nro-pill-muted { background: rgba(32, 37, 47, 0.86); color: #eef2f6; }',
        '.nro-error-note { border: 0; border-radius: 999px; padding: 6px 10px; font: 600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; background: rgba(50, 55, 65, 0.88); cursor: pointer; }',
        '.nro-setup-panel { position: fixed; right: 20px; bottom: 20px; z-index: 999999; max-width: min(360px, calc(100vw - 32px)); padding: 14px 16px; border-radius: 18px; color: #fff; background: linear-gradient(135deg, rgba(19, 24, 34, 0.96), rgba(40, 9, 9, 0.96)); border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45); backdrop-filter: blur(12px); }',
        '.nro-setup-copy { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }',
        '.nro-setup-copy strong { font: 700 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
        '.nro-setup-text { font: 500 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: rgba(255, 255, 255, 0.86); }',
        '.nro-setup-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }',
        '.nro-setup-button { border: 0; border-radius: 999px; padding: 9px 14px; font: 700 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #120606; background: #e50914; cursor: pointer; }',
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
