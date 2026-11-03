# Valhalla Mech

This is the Valhalla desk. It looks like the ACCELERATION command center. It runs on your PC. It is read-only until you arm live trading.

The repository is public. An access code, if you set one, only opens the app. It does not hide the code.

## Run your own agent

1. Install [Bun](https://bun.sh) (or use the copy that ships with this repo).
2. Open this folder: `plugins/plugin-valhalla-copybot`.
3. Copy `.env.example` to `.env`.
4. Paste your Google AI Studio key into `GOOGLE_GENERATIVE_AI_API_KEY`. Leave `VALHALLA_LIVE_TRADING=false`.
5. Double-click `start.bat` on Windows, or run `./start.sh` on Mac or Linux.

The desk opens at `http://127.0.0.1:8787`. It stays on this PC unless you set `VALHALLA_BIND=0.0.0.0` so the phone on your network can pair. Wallet actions still refuse any request that is not from this PC.

### Phone

Install the APK from this repository's Releases page when a build is published. That is the normal path. The phone does not need Android Studio.

On the phone, allow installs from unknown sources, then open the file. The app opens on the last screen you used. The first time, that screen is pairing. It does not crash if the PC desk is off. It shows the last known status instead. The ads are Google test ads.

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
