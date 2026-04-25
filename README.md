# Netflix IMDb Ratings Overlay

This project is now a Chrome extension only.

It shows a single IMDb rating badge next to the title inside Netflix's detail or more-info views. It does not remove any Netflix UI.

## What changed

- Removed Rotten Tomatoes support.
- Removed MyDramaList support.
- Removed the Violentmonkey userscript path.
- Limited the overlay to Netflix detail views instead of browse cards.
- Switched the data source to the official IMDb API.

## Official IMDb API requirement

This project uses IMDb's official API through AWS Data Exchange.

IMDb's current official docs say you need:

- An AWS account.
- AWS access keys.
- An IMDb API subscription through AWS Data Exchange.
- Your unique `x-api-key`, `data-set-id`, `revision-id`, and `asset-id`.

Official docs:

- [IMDb API getting access](https://developer.imdb.com/documentation/api-documentation/getting-access/)
- [IMDb API calling the API](https://developer.imdb.com/documentation/api-documentation/calling-the-api/)

The extension prompts you for:

- AWS Access Key ID
- AWS Secret Access Key
- AWS Session Token (optional)
- IMDb API key (`x-api-key`)
- Data set ID
- Revision ID
- Asset ID

## Security note

This extension stores your IMDb and AWS credentials in local Chrome extension storage on your machine so it can sign requests directly from the extension background worker.

That is convenient for local development, but it is not the right model for publishing broadly. A production-safe version should move the AWS signing step behind your own backend proxy.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:
   `/Users/umairkhanjadoon/Codex Playground/projects/netflix-extension`
5. Open Netflix.
6. Click `Configure IMDb API` in the setup panel and enter your official IMDb API credentials.

## UI behavior

- The rating appears only in Netflix detail views.
- The badge is injected inline next to the title.
- Clicking the badge opens the matching IMDb title page.

## Known limitations

- The extension currently matches Netflix titles to IMDb by title search text, so remakes and alternate titles can still mis-match occasionally.
- Because the extension signs AWS requests locally, this repo is best treated as a personal/local tool rather than a public distributable extension.
