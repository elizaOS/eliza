# Valhalla Mech

This is the Valhalla desk. TokenJunction LLC publishes it. TokenJunction LLC is a private company and the owner of Valhalla. The desk looks like the ACCELERATION command center. It runs on your PC. It is read-only until you arm live trading.

The public name is TokenJunction LLC. The terms, the privacy policy, the disclaimer, the store drafts, the Windows installer publisher field, and the extension author use that name. The public site is https://valhalla-app.xyz. Support is hello@valhalla-app.xyz. A street address and an EIN stay out of these files. `{BUSINESS_ADDRESS}` stays a placeholder in `docs/play/listing.md`.

The repository is public. An access code, if you set one, only opens the app. It does not hide the code.

## Phone and iOS

The sideload Android app is the Gradle `sideload` flavor in `android/`. It can offer an update from the GitHub release. The file is installed with the system package installer only after you tap Update available and the SHA-256 matches. The `play` flavor does not include that updater. Play updates come from Google Play. iOS updates come from the App Store. The iOS app does not download its own package.

The first launch asks for age 18+, shows that this is not financial advice, then offers pairing or a demo. Delete phone data clears the setup.

## Valhalla Brain

Brain is the advisory model layer. Gemini is the default. You can also pick OpenAI, Anthropic, Grok, OpenRouter, or local Ollama. Keys stay encrypted on this PC. A monthly cap stops extra model calls. The analyst can only make a pass fail. It cannot approve a coin the rules already blocked. A strategy tweak waits for your tap and can be rolled back. Details are in [docs/AI.md](../../docs/AI.md).

## Self-repair

The agent watches itself. Hung calls time out. The next data provider is used. A failed balance is unknown, not zero. A send that lands late is not sent again. A restart runs only when no position is open and nothing is in flight. The desk shows a health score and a Self-Repair Log. A suggested fix waits for your confirm tap. A code change is never applied by the agent. Details are in [docs/SELF_REPAIR.md](../../docs/SELF_REPAIR.md).

## Run your own agent

1. Install [Bun](https://bun.sh) (or use the copy that ships with this repo).
2. Open this folder: `plugins/plugin-valhalla-copybot`.
3. Copy `.env.example` to `.env`.
4. Paste your Google AI Studio key into `GOOGLE_GENERATIVE_AI_API_KEY`. Leave `VALHALLA_LIVE_TRADING=false`.
5. Double-click `start.bat` on Windows, or run `./start.sh` on Mac or Linux.

The desk opens at `http://127.0.0.1:8787`. It stays on this PC unless you set `VALHALLA_BIND=0.0.0.0` so the phone on your network can pair. Wallet actions still refuse any request that is not from this PC.

### Phone

Install the APK from this repository's Releases page when a build is published. That is the normal path. The phone does not need Android Studio.

On the phone, allow installs from unknown sources, then open the file. The app opens on the last screen you used. The first time, that screen is pairing. It does not crash if the PC desk is off. It shows the last known status instead.

The phone does not store a wallet key. It has no send or withdraw control. Create and fund the bot wallet on the PC desk. Write down a new wallet's backup there. It is shown once.

After you pair, the phone watches the PC agent:

- It reconnects with a longer wait after each miss.
- A heartbeat warns you if the agent is stalled or offline.
- Recover agent asks the PC to run the safe watchdog. The loop restarts only when no position is open.
- A background notice carries those alerts. The app does not ask you to turn battery optimization off.
- If the pairing token expires, the phone asks for a new one.
- Error lines stay on the phone. Open Error log to read them.
- Chat uses the same PC agent and the same Google AI Studio key. The key stays on the PC. A settings idea is not applied until you tap confirm, and it must stay inside the desk limits.

The bot stays read-only. Arm live only from Controls on the PC, and only after you type `CONFIRM LIVE`. Set `VALHALLA_LIVE_TRADING=false` in `.env` if you want the file to block live swaps.

There is no send or withdraw button. Move SOL with your own wallet app.

Chat on the desk answers status, positions, and P&L. It refuses transfer and "turn off safety" requests. Gemini uses Google AI Studio, not Vertex.

A log is written to `data/agent.log` and `data/audit.jsonl`. The log panel shows the same lines. Keys are not written there.

## Play Store

The steps to publish the phone app are in [docs/PLAY_STORE.md](../../docs/PLAY_STORE.md). You still need a Play Console account, the upload key, and the closed test. The repository does not contain those secrets.

## Ads

The phone uses Google AdMob, not AdSense. A new build uses Google's sample ad IDs, so the ads are test ads until you set your own. Nothing in the app source stores a live ad unit ID.

Set these when you build the phone app. Use the environment, or `android/local.properties`. Do not commit the real IDs.

- `ADS_ENABLED` is `true` by default. Set it to `false` to turn every ad off.
- `ADMOB_APP_ID`
- `ADMOB_BANNER_ID`
- `ADMOB_INTERSTITIAL_ID`
- `ADMOB_REWARDED_ID`
- `HOUSE_ADS_URL` defaults to `https://valhalla-app.xyz/offers.json`. An offer stays off until its `url` is an https link. `OFFER_CLICK_URL` stays empty until you paste the Brain API click address.
- `PRIVACY_POLICY_URL` defaults to https://valhalla-app.xyz/privacy-policy.md. Set it only if you publish the policy somewhere else.

The banner and the optional ad buttons are on the pairing screen and the error log only. They are hidden on status, chat, Recover agent, and settings confirm. A short ad and a break ad start only when you tap those buttons. A reward does not change trading.

Before the first third-party ad, the app runs Google's consent form for GDPR and CCPA.

Your own messages are a title, a line of text, and an optional https link. The feed looks like this:

```json
{ "ads": [{ "title": "Valhalla desk", "text": "Trading stays on the PC.", "url": "" }] }
```

To be paid by AdMob:

1. Create an AdMob account at https://admob.google.com and add a payment profile.
2. Register the Android app and copy the app ID into `ADMOB_APP_ID`.
3. Create a banner, an interstitial, and a rewarded ad unit. Copy each ID into the matching setting.
4. Publish `android/PRIVACY_POLICY.md` on your site and set `PRIVACY_POLICY_URL`.
5. Publish `android/app-ads.txt.example` as `https://YOUR-DOMAIN/app-ads.txt` after you replace the publisher ID.
6. Build the app again. Until those IDs are set, the app keeps Google's sample IDs.

Google's policies restrict financial and crypto products. AdMob and the Play Store can reject a crypto trading app, or ask for a license or an extra declaration in some countries. Read the current AdMob program policies and Play policy before you turn on paid ads. Test ads do not pay.

The PC desk does not show web ads unless you opt in. AdSense does not belong on a localhost desk. Set `ADSENSE_ENABLED=true` and `ADSENSE_CLIENT_ID=ca-pub-` plus 16 digits in `.env` only for a public site. `ADSENSE_SLOT` is optional. Leave both unset on your own computer.

## Settings

Open Controls any time. You can lock the wallet, change the password, replace the wallet, edit size, lanes, stops, the run timer, and API keys. Keys are stored in `data/local.env` on this PC and are not shown again.

If a trade is open, new settings wait until the book is empty, unless you confirm to apply them now. Presets cannot turn off rug checks, manipulation checks, stops, cooldowns, or the 3-loss circuit breaker.

Backup downloads settings. You can include the encrypted wallet file. The backup does not contain a readable key.

## What stays on

- Rug, honeypot, mint, and freeze checks
- Manipulation and creator scan
- Liquidity, volume, and buy-pressure floors
- Hard stop, tiered take-profit, and max hold
- No averaging down
- Re-buy cooldown
- Slippage cap
- Daily loss pause
- Circuit breaker after 3 losses
- A timeout on every network call
- A watchdog that restarts a stalled loop only when no position is open
- An audit line for each action and setting change

## Character

`characters/valhalla-mech.character.json` is the Valhalla persona. The start script uses it as the desk agent. You can also add `@elizaos/plugin-valhalla-copybot` to an Eliza character.

## Checks already in this fork

This fork already runs secret scanning, CodeQL, and Dependabot. See the root `SECURITY.md`, `.github/workflows/gitleaks.yml`, `.github/workflows/codeql.yml`, and `.github/dependabot.yml`. A plugin workflow runs lint and tests when this folder changes. Signed Android builds stay on the existing `android-build.yml` path. This desk does not add a second withdraw path there.

## Develop

```bash
bun run --cwd plugins/plugin-valhalla-copybot test
bun run --cwd plugins/plugin-valhalla-copybot lint:check
```
