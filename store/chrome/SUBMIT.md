# Chrome Web Store submission

Copy these fields into the Chrome Web Store dashboard. The upload file is `store/chrome/valhalla-extension-store.zip`. `manifest.json` is at the root of that zip.

## Name

Valhalla

## Short description

Read-only status for your Valhalla desk. No wallet. No send or withdraw.

That line is 72 characters. The limit is 132.

## Long description

Valhalla shows the status of a desk that runs on your computer.

The extension is read-only. It cannot send, withdraw, or move funds. It does not ask for a seed phrase or a wallet key.

You can point it at the desk on this computer and read status. If the desk is off, the extension says so.

TokenJunction LLC publishes Valhalla. Crypto is risky. This is not financial advice and it does not promise profit.

Chrome on Android cannot install extensions. This listing is for desktop Chrome.

## Category

Productivity

## Language

English

## Single purpose

This item has one purpose: show read-only status from the user's Valhalla desk on the same computer.

It does not trade, send, withdraw, or hold a wallet key. A status line is not financial advice.

The Chrome Web Store updates this extension by itself after it is published. You do not download a new zip for each version. Until the store link is set, load the unpacked folder again when you want a new build.

The popup can show a house banner labeled Ad or Sponsored for free users. The image and the link are inside the extension package. They are not an AdSense or AdMob script. Pro hides that banner. An affiliate link, if present, says that we may earn a fee.

## Permission justifications

storage: The extension saves the desk address and the pairing token in chrome.storage.local on this browser. Those values stay on the device. They are not sent to TokenJunction.

There is no required host permission. There is no content script. The extension does not call api.valhalla-app.xyz or a Solana RPC. Balances and scores stay on the desk and the Brain API.

Optional host permission, requested only when the user clicks Show status: http://127.0.0.1/* and http://localhost/*. That lets the extension read the desk on this computer. It does not cover other websites.

The extension does not request tabs, a broad host pattern, or remote code. There is no eval and no remote script.

## Privacy practices

Privacy policy URL: https://valhalla-app.xyz/privacy

Answers you can paste:

- This item does not sell user data.
- This item does not use or transfer user data for purposes that are unrelated to its single purpose.
- This item does not use or transfer user data to determine creditworthiness or for lending.
- Data stays on the user's computer. The extension stores the desk address the user types and a pairing token for that desk.
- The extension does not collect email, contacts, location, web history, or a wallet seed.
- Go Pro opens a checkout page in a new tab. The extension does not see the card number.

Data types to declare: none collected by TokenJunction. The pairing token is stored locally for the desk on this computer.

## Pricing

Free. The extension does not include a purchase inside the popup. A Go Pro link opens the website checkout in a new tab. That subscription includes a 15 day free trial. The length is `TRIAL_DAYS` in `product.config.json`.

## Regions

All regions.

## Graphics in this folder

- icon-128.png is 128 by 128.
- screenshot-1280x800.png is 1280 by 800.
- tile-440x280.png is the 440 by 280 small tile.

## Reviewer notes

Load the unpacked zip. The service worker starts and the popup shows VALHALLA. The desk address defaults to http://127.0.0.1:8787. No account is required to open the popup.
