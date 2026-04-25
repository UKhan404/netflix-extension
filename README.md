# Netflix IMDb Ratings Overlay

This project is a Chrome extension that shows a single IMDb rating badge next to the title inside Netflix's detail or more-info views.

It does not remove any Netflix UI, and it now uses OMDb again so you only need a simple OMDb API key instead of AWS credentials.

## What it does

- Shows only the IMDb rating.
- Removes Rotten Tomatoes support.
- Removes MyDramaList support.
- Keeps the overlay limited to Netflix detail views.
- Places the IMDb badge inline next to the title.

## Setup

This version uses OMDb for the IMDb score lookup.

You only need:

- An OMDb API key

Get one here:

- [OMDb API key request](https://www.omdbapi.com/apikey.aspx)

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:
   `/Users/umairkhanjadoon/Codex Playground/projects/netflix-extension`
5. Open Netflix.
6. Click `Add OMDb key` in the setup panel and paste your API key.

You can also use the extension menu commands to set or clear the OMDb key.

## UI behavior

- The rating appears only in Netflix detail views.
- The badge is injected next to the Netflix title.
- Clicking the badge opens the matching IMDb title page.

## Known limitations

- OMDb matching is title-based, so remakes, alternate titles, and regional titles can still mis-match occasionally.
- Some titles may have no IMDb rating available through OMDb.
