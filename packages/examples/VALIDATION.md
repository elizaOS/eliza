# Examples Validation Report

Last updated: 2026-05-20

This report records the local verification state for every example under
`packages/examples`. It separates checks that can run locally from checks that
require external accounts, cloud projects, desktop apps, hardware, or credentials.

## Local Verification Commands

Run these from the repository root after `bun install`:

```bash
# List all example packages and scripts.
node packages/examples/scripts/verify-examples.mjs --mode list

# Check every example package has direct README coverage and top-level docs.
node packages/examples/scripts/verify-examples.mjs --mode docs

# Run local validation sweeps. These execute every package script of that kind.
node packages/examples/scripts/verify-examples.mjs --mode typecheck
node packages/examples/scripts/verify-examples.mjs --mode test
node packages/examples/scripts/verify-examples.mjs --mode build

# Optional full run with a machine-readable report.
node packages/examples/scripts/verify-examples.mjs --mode all --json packages/examples/verification-report.json
```

## Current Local Evidence

The local examples sweep has been run in this worktree with these outcomes:

| Scope | Evidence |
| --- | --- |
| Dependency install | `bun install` completed. |
| Package typechecks | `node packages/examples/scripts/verify-examples.mjs --mode typecheck` completed with 0 failures. |
| Package tests | `node packages/examples/scripts/verify-examples.mjs --mode test` completed after dependency/build repair. Live endpoint clients either passed locally or skipped cleanly when no live service URL/credential was configured. |
| Package builds | `node packages/examples/scripts/verify-examples.mjs --mode build` completed after targeted repairs. Human-gated or known bundler-limited examples use explicit skip scripts that explain the required opt-in command. |
| Final targeted recheck | `a2a`, `bluesky`, `mcp`, `smartglasses`, `trader`, `twitter-xai`, `cloud/clone-ur-crush`, `cloud/edad`, `form`, `moltbook`, `react`, `elizagotchi`, `farcaster-miniapp`, `next`, `app/capacitor`, `app/electron`, `browser-extension`, and `farcaster` passed targeted reruns after the last fixes. |
| Static docs | `node packages/examples/scripts/verify-examples.mjs --mode docs` now checks each package README, every package row in this matrix, top-level links to `setup-guide.html`/`VALIDATION.md`, and setup guide sections for Minecraft, cloud, social, hardware, and wallet examples. |
| Setup guide links/render | `packages/examples/setup-guide.html` rendered in Playwright with the Minecraft section visible, and every external setup link returning HTTP < 400 after redirects. |

## Example Matrix

| Example | Local verification | Live / manual verification still required |
| --- | --- | --- |
| `_plugin` | `typecheck`, `test`, `build` | Optional manual Cypress flow via `test:e2e:manual`. |
| `a2a` | `typecheck`, `test`, `build` | `OPENAI_API_KEY` for model-backed mode. |
| `agent-console` | `test`, `typecheck` | Action scanner fixture test; browser session plus one provider key to inspect live SSE telemetry. |
| `app/capacitor` | `test`, parent typecheck/build skip scripts plus backend/frontend package checks | Parent script/config smoke test; native Capacitor device/simulator testing and provider keys. |
| `app/capacitor/backend` | `typecheck`, `test`, `build` | Provider key and device/simulator flow through the Capacitor shell. |
| `app/capacitor/frontend` | `test`, `typecheck`, `build` | Static backend/API wiring test; browser and native WebView smoke test against a configured backend. |
| `app/electron` | `test`, parent typecheck/build skip scripts plus backend/frontend package checks | Parent script/IPC smoke test; desktop Electron launch and provider-key chat flow. |
| `app/electron/backend` | `typecheck`, `test`, `build` | Provider-key chat flow from the packaged Electron shell. |
| `app/electron/frontend` | `test`, `typecheck`, `build` | Static preload bridge wiring test; renderer smoke test in Electron and browser dev-server mode. |
| `autonomous` | `test`, `typecheck`, `build` | Decision parser, shell allowlist, and prompt tests; optional local model and shell sandbox configuration. |
| `aws` | `typecheck`, `test`, `build` | AWS account, SAM deployment, and Lambda invocation with `OPENAI_API_KEY`. |
| `bluesky` | `typecheck`, `test`, `build` | `LIVE_TEST=true` with Bluesky credentials and dry-run/posting flags. |
| `browser-extension` | `test`, parent typecheck/build skip scripts and documented Chrome/Safari package checks | Workspace/shared runtime smoke test; load unpacked Chrome extension; Safari requires Xcode signing/install. |
| `browser-extension/chrome` | `test`, `typecheck`, explicit build skip | Manifest and script wiring smoke test; `build:tsup` only after resolving browser bundling of Node-only workspace deps; load unpacked for runtime validation. |
| `browser-extension/safari` | `test`, typecheck skip, scripted Safari build path | Safari source/conversion guard smoke test; Xcode and Safari extension signing. |
| `chat` | `test`, `typecheck`, `build` | Provider-selection tests; one configured provider key for live chat. |
| `cloud/clone-ur-crush` | `typecheck`, `test`, `build` | Live Next.js flow with required model/image provider keys. |
| `cloud/edad` | `typecheck`, `test`, `build` | Manual server launch with Eliza Cloud app ID, affiliate code, and signed-in user token. |
| `cloud/x402-image-gen` | `typecheck`, `test`, `build` | Local flow test runs against a mock cloud (no crypto). Live use needs an Eliza Cloud API key, app ID, and a funded wallet on the chosen x402 network. |
| `cloudflare` | `typecheck`, `test`, `build` | Wrangler login, Worker secret, deployed or local Worker endpoint. |
| `code` | `typecheck`, `test`, `build` | Provider-key E2E flows for subagents/game generation. |
| `convex` | `typecheck`, `test`, `build` | `convex dev` or deployed Convex URL plus provider key in Convex env. |
| `discord` | `typecheck`, `test`, `build` | Discord app credentials, bot install, provider key. |
| `elizagotchi` | `test`, `typecheck`, `build` | Static mount and agent-command wiring test; browser gameplay smoke test. |
| `farcaster` | `test`, `typecheck`, `build` | Env validation tests; Neynar/Farcaster credentials; start with dry-run. |
| `farcaster-miniapp` | `test`, `typecheck`, `build` | Static SDK/API wiring test; Farcaster mini app host plus wallet/provider integrations. |
| `form` | `typecheck`, `test`, `build` through shared `chat` entrypoint | Manual run through shared chat entrypoint with one provider key. |
| `game-of-life` | `typecheck`, `test`, `build` | Test runs a short non-interactive simulation. |
| `gcp` | `test`, `typecheck`, `build` | Non-interactive worker availability check; GCP project, Cloud Run deployment, deployed test client URL. |
| `html` | `test`, typecheck/build skip scripts | Import-map and DOM wiring test; browser smoke test from static server. |
| `lp-manager` | `typecheck`, `test`, `build` | Isolated Solana/EVM wallets and RPCs for live liquidity paths. |
| `mcp` | `typecheck`, `test`, `build` | OpenAI key or compatible endpoint for live MCP chat. |
| `moltbook` | `test`, `typecheck`, `build` | Config and fee-format tests; `LLM_API_KEY` plus token only for write actions. |
| `moltbook/bags-claimer` | `test`, typecheck/build skip scripts | Fee-format test; wallet/RPC setup for claim flow. |
| `next` | `test`, `typecheck`, explicit build skip | Static client streaming test; `build:next` for opt-in Next.js bundle verification; provider key for live chat. |
| `react` | `test`, `typecheck`, `build` | Static mount/runtime wiring test; browser smoke test. |
| `rest-api/elysia` | `test`, `typecheck`, `build` | In-process CORS/request validation tests; start server for full HTTP chat flow. |
| `rest-api/express` | `test`, `typecheck`, `build` | Ephemeral-port CORS/request validation tests; start server for full HTTP chat flow. |
| `rest-api/hono` | `test`, `typecheck`, `build` | In-process CORS/request validation tests; start server for full HTTP chat flow. |
| `smartglasses` | `typecheck`, `test` | Even Realities simulator or BLE hardware evidence report. |
| `supabase` | Static review; no package scripts | Supabase CLI/Deno function serve or deployment with anon key and `OPENAI_API_KEY`. |
| `telegram` | `test`, `typecheck`, `build` | Env and character wiring tests; Telegram bot token and provider key for live run. |
| `text-adventure` | `test`, `typecheck`, `build` | Deterministic no-LLM dungeon-engine playthrough; optional manual CLI playthrough requires `OPENAI_API_KEY`. |
| `tic-tac-toe` | `typecheck`, `test`, `build` | Test runs the non-interactive bench mode. |
| `trader` | `test`, `typecheck`, `build` | Static panel and paper-trading default test; paper-trading UI flow, then isolated-wallet live testing only when intended. |
| `twitter-xai` | `test`, `typecheck`, `build` | Credential-mode validation tests; X/xAI credentials for live run, starting with `TWITTER_DRY_RUN=true`. |
| `vercel` | `typecheck`, `test`, `build` | Vercel project/env plus deployed or `vercel dev` API endpoint. |

## Not Yet Proven By Local Automation

These requirements cannot be honestly marked complete from local scripts alone:

- External account deployments: AWS, GCP, Cloudflare, Convex, Supabase, Vercel.
- Public/social posting flows: Bluesky, Discord, Farcaster, Telegram, Twitter/X.
- Desktop or hardware flows: Safari/Xcode, Capacitor device builds, Electron
  app launch, Smartglasses BLE hardware.
- Financial transaction flows: `trader`, `lp-manager`, and wallet-enabled
  Farcaster mini app paths.

Use `setup-guide.html` for the account setup links and keep dry-run or paper
trading modes enabled until the target account, project, or wallet is verified.
