# Netflix Ratings Overlay

This project gives you two ways to run the same idea on Netflix:

- A Violentmonkey userscript you can install directly.
- A Chrome extension wrapper you can load unpacked in Chrome.

It adds IMDb and Rotten Tomatoes ratings to Netflix without removing Netflix UI.

## Folder layout

- `violentmonkey/netflix-ratings.user.js`: install this in Violentmonkey.
- `manifest.json`: Chrome extension manifest.
- `src/`: shared Chrome extension source files.

## Important note

Violentmonkey does not install regular Chrome extensions. It installs userscripts.

Because your request mentioned both, this project includes both:

- Use the userscript if you want the fastest path inside Violentmonkey.
- Use the Chrome extension if you want to load it through `chrome://extensions`.

## Ratings source

The script uses OMDb for title lookup because it exposes IMDb and Rotten Tomatoes ratings from one API response.

OMDb requires an API key. Their official key page is:

- [OMDb API key request](https://www.omdbapi.com/apikey.aspx)

The free plan currently advertises a 1,000 daily request limit on their key page.

## Install in Violentmonkey

1. Open Violentmonkey and create a new script.
2. Replace the default contents with the code from `violentmonkey/netflix-ratings.user.js`.
3. Save the script.
4. Open Netflix.
5. When the setup panel appears, click `Add OMDb API key` and paste your key.

You can also use the Violentmonkey script menu to set or clear the saved key.

## Load as a Chrome extension

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder:
   `/Users/umairkhanjadoon/Codex Playground/projects/netflix-extension`
5. Open Netflix and add your OMDb API key when prompted.

## What it does

- Injects rating pills into Netflix detail views and visible title cards.
- Keeps Netflix’s existing layout and only adds extra UI.
- Limits card lookups to titles near the viewport so the page stays responsive.
- Stores your OMDb API key locally in Violentmonkey storage or Chrome extension storage.

## Known limitations

- Netflix is a private SPA and its DOM changes over time, so selectors may need maintenance later.
- OMDb matching is title-based, so some remakes, region-specific titles, or alternate spellings can resolve imperfectly.
- Rotten Tomatoes links point to Rotten Tomatoes search results because OMDb returns the rating but not a stable Rotten Tomatoes title URL.
