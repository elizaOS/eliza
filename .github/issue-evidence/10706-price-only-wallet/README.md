# #10706 — price-only wallet widget: on-device before/after

`ondevice-before-after.png` — rendered on a connected Android instance
(emulator-5556, via the device's own Chrome + `adb reverse`):

- **BEFORE** — the wallet widget showed the **aggregate holding value**
  ("Wallet · $12,480.00 · 2 chains") — the "amount they have" the user does not
  want surfaced.
- **AFTER (#10706)** — the top held cryptos by **unit price only** (WBTC
  $64,000.00 +1.4%, ETH $3,050.00 −0.6%, SOL $152.30 +2.1%, USDC $1.00) — no
  amount held, no holding value, no portfolio total; 24h change tinted.

The render uses the widget's real row markup. The selection logic
(`selectPricedHoldings`) — skip < $1, top-5 by holding value, price-only, must
have a market price — is covered by 8 unit tests; the widget render/no-leak/tap
by 5 more.
