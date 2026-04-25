# Netflix Ratings Overlay

This project gives you two ways to run the same idea on Netflix:

- A Violentmonkey userscript you can install directly.
- A Chrome extension wrapper you can load unpacked in Chrome.

It adds IMDb and Rotten Tomatoes ratings to Netflix and can also add MyDramaList ratings for Asian dramas without removing Netflix UI.

## Folder layout

- `violentmonkey/netflix-ratings.user.js`: install this in Violentmonkey.
- `manifest.json`: Chrome extension manifest.
- `src/`: shared Chrome extension source files.

## Important note

Violentmonkey does not install regular Chrome extensions. It installs userscripts.

Because your request mentioned both, this project includes both:

- Use the userscript if you want the fastest path inside Violentmonkey.
- Use the Chrome extension if you want to load it through `chrome://extensions`.

## Ratings sources

- OMDb powers IMDb and Rotten Tomatoes ratings.
- MyDramaList powers MDL ratings for Asian dramas when a MyDramaList API key is configured.

## API keys

This project now supports two optional keys:

- OMDb API key: required for IMDb and Rotten Tomatoes ratings.
- MyDramaList API key: required for MDL ratings.

Official references:

- [OMDb API key request](https://www.omdbapi.com/apikey.aspx)
- [MyDramaList API reference](https://mydramalist.github.io/MDL-API/)

The MyDramaList docs currently describe the API key header as `mdl-api-key`.

## Install in Violentmonkey

1. Open Violentmonkey and create a new script.
2. Replace the default contents with the code from `violentmonkey/netflix-ratings.user.js`.
3. Save the script.
4. Open Netflix.
5. Use the on-page setup panel or the Violentmonkey script menu to add your OMDb key and, if you have one, your MyDramaList key.

## Load as a Chrome extension

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder:
   `/Users/umairkhanjadoon/Codex Playground/projects/netflix-extension`
5. Open Netflix and add your API keys when prompted.

## What it does

- Injects rating pills into Netflix detail views and visible title cards.
- Keeps Netflix’s existing layout and only adds extra UI.
- Shows IMDb and Rotten Tomatoes when OMDb is configured.
- Shows MyDramaList when a title matches MDL and a MyDramaList key is configured.
- Limits card lookups to titles near the viewport so the page stays responsive.
- Stores your API keys locally in Violentmonkey storage or Chrome extension storage.

## Known limitations

- Netflix is a private SPA and its DOM changes over time, so selectors may need maintenance later.
- OMDb and MyDramaList matching are title-based, so remakes, alternate spellings, and regional titles can still resolve imperfectly.
- MyDramaList API access depends on having a working MDL developer key.
- Rotten Tomatoes links point to Rotten Tomatoes search results because OMDb returns the rating but not a stable Rotten Tomatoes title URL.
