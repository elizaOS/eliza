# `action.BROWSER@plugins/plugin-browser/src/actions/browser.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-browser
- **File**: `plugins/plugin-browser/src/actions/browser.ts:348`
- **Token count**: 129
- **Last optimized**: never
- **Action**: BROWSER
- **Similes**: BROWSE_SITE, BROWSER_SESSION, CONTROL_BROWSER, CONTROL_BROWSER_SESSION, MANAGE_ELIZA_BROWSER_WORKSPACE, MANAGE_LIFEOPS_BROWSER, NAVIGATE_SITE, OPEN_SITE, USE_BROWSER, BROWSER_ACTION, BROWSER_AUTOFILL_LOGIN, AGENT_AUTOFILL, AUTOFILL_BROWSER_LOGIN, AUTOFILL_LOGIN, FILL_BROWSER_CREDENTIALS, LOG_INTO_SITE, SIGN_IN_TO_SITE

## Current text
```
Single BROWSER action — control whichever browser target is registered. Targets are pluggable: `workspace` (electrobun-embedded BrowserView, the default; falls back to a JSDOM web mode when the desktop bridge isn't configured), `bridge` (the user's real Chrome/Safari via the Agent Browser Bridge companion extension), and `computeruse` (a local puppeteer-driven Chromium via plugin-computeruse). The agent uses what is available — the BrowserService picks the active target when none is specified. Use `action: \
```

## Compressed variant
```
Browser tab/page control: open/navigate/click/type/screenshot/state; action autofill_login + domain autofill vault-gated credential into workspace tab pre-authorized in Settings Vault Logins. Bridge settings/status use MANAGE_BROWSER_BRIDGE.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (241 chars vs 513 chars — 53% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
