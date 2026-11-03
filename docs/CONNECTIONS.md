# Connections

Every outside connection is read-only. Keys are encrypted on this PC with the same lock as the bot wallet. The phone shows only whether a connection is off, locked, or ready. Keys are not logged, not shown again, and not stored in git.

Open Controls, then Connections. Type the key and a password of at least 8 characters. Connect saves it. Test checks it. Disconnect deletes it.

## Price and token data

Order: Birdeye if a key is saved, then Helius, then DexScreener. DexScreener needs no key. If a source answers 429, that source waits one second and the next source is used.

## X

A read-only bearer token can search recent posts for cashtags and mints. Those names are only candidates. A coin still has to pass the rug, mint, freeze, and liquidity checks before a buy.

## Alerts

Telegram needs a bot token and a chat id in the saved secret as JSON: `{"token":"...","chatId":"..."}`. Discord needs the webhook URL. You can turn buy, sell, freeze, stall, and daily P&L notices on or off. The message never includes the key.

## Rug and safety

RugCheck plus mint authority, freeze authority, LP lock, and the top holders make a safety score from 0 to 100. A score under 50 blocks the coin. This is an extra gate on top of the checks that were already there.

## P&L export

`GET /api/pnl.csv` downloads a CSV of closed paper or live rows. Google Sheets can append the same rows when you save a service-account JSON or an OAuth access token, plus `spreadsheetId`. The app only appends. It does not delete rows.

## Exchange balances

Coinbase, Kraken, and Binance are balance reads. Binance is refused when the key can trade or withdraw. Create a view-only key in the exchange settings. This app does not place orders and does not withdraw.

Do not commit a key. Do not paste a key into chat, a screenshot, or the phone.
