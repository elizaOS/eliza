# Examples Validation Report

Last updated: 2026-05-20

This report records the local verification state for every example under
`packages/examples`. It separates checks that can run locally from checks that
require external accounts, cloud projects, desktop apps, hardware, or credentials.

## Local Verification Commands

Run these from the repository root after `bun install`:

```bash
# Typecheck every example package that exposes a typecheck script.
find packages/examples -name package.json -not -path '*/node_modules/*' -not -path '*/.next/*' -print \
  | sort \
  | while read package_file; do
      dir="${package_file%/package.json}"
      if node -e "const p=require('./${package_file}'); process.exit(p.scripts?.typecheck ? 0 : 1)"; then
        bun run --cwd "$dir" typecheck
      fi
    done

# Test every example package that exposes a test script.
find packages/examples -name package.json -not -path '*/node_modules/*' -not -path '*/.next/*' -print \
  | sort \
  | while read package_file; do
      dir="${package_file%/package.json}"
      if node -e "const p=require('./${package_file}'); process.exit(p.scripts?.test ? 0 : 1)"; then
        bun run --cwd "$dir" test
      fi
    done

# Build every example package that exposes a build script.
find packages/examples -name package.json -not -path '*/node_modules/*' -not -path '*/.next/*' -print \
  | sort \
  | while read package_file; do
      dir="${package_file%/package.json}"
      if node -e "const p=require('./${package_file}'); process.exit(p.scripts?.build ? 0 : 1)"; then
        bun run --cwd "$dir" build
      fi
    done
```

## Current Local Evidence

The local examples sweep has been run in this worktree with these outcomes:

| Scope | Evidence |
| --- | --- |
| Dependency install | `bun install` completed. |
| Package typechecks | All `packages/examples/**/package.json` packages with a `typecheck` script completed after fixes. |
| Package tests | All packages with a `test` script completed. Live endpoint clients either passed locally or skipped cleanly when no live service URL/credential was configured. |
| Package builds | All packages with a `build` script completed. Human-gated or known bundler-limited examples use explicit skip scripts that explain the required opt-in command. |
| Final targeted recheck | `bun run --cwd packages/examples/agent-console typecheck`, `bun run --cwd packages/examples/convex build`, and `bun run --cwd packages/examples/trader build` passed after the last example fixes. |
| Static docs | `packages/examples/setup-guide.html` is linked from `packages/examples/README.md` and covers Roblox, Minecraft, cloud, social, hardware, and wallet setup links. |

## Example Matrix

| Example | Local verification | Live / manual verification still required |
| --- | --- | --- |
| `_plugin` | `typecheck`, `test`, `build` | Optional manual Cypress flow via `test:e2e:manual`. |
| `a2a` | `typecheck`, `test`, `build` | `OPENAI_API_KEY` for model-backed mode. |
| `agent-console` | `typecheck` | Browser session plus one provider key to inspect live SSE telemetry. |
| `app/capacitor` | Parent skip scripts plus backend/frontend package checks | Native Capacitor device/simulator testing and provider keys. |
| `app/electron` | Parent skip scripts plus backend/frontend package checks | Desktop Electron launch and provider-key chat flow. |
| `autonomous` | `typecheck`, `build` | Optional local model and shell sandbox configuration. |
| `avatar` | `typecheck`, `build` | Browser microphone/audio flow, selected model key, optional ElevenLabs key. |
| `aws` | `typecheck`, `test`, `build` | AWS account, SAM deployment, and Lambda invocation with `OPENAI_API_KEY`. |
| `bluesky` | `typecheck`, `test`, `build` | `LIVE_TEST=true` with Bluesky credentials and dry-run/posting flags. |
| `browser-extension` | Parent typecheck skip and documented Chrome/Safari package checks | Load unpacked Chrome extension; Safari requires Xcode signing/install. |
| `browser-extension/chrome` | `typecheck`, explicit build skip | `build:tsup` only after resolving browser bundling of Node-only workspace deps; load unpacked for runtime validation. |
| `browser-extension/safari` | Typecheck skip, scripted Safari build path | Xcode and Safari extension signing. |
| `chat` | `typecheck`, `build` | One configured provider key for live chat. |
| `cloud/clone-ur-crush` | `build` | Live Next.js flow with required model/image provider keys. |
| `cloud/edad` | No package verification scripts | Manual server launch via `bun run start`. |
| `cloudflare` | `typecheck`, `test`, `build` | Wrangler login, Worker secret, deployed or local Worker endpoint. |
| `code` | `typecheck`, `test`, `build` | Provider-key E2E flows for subagents/game generation. |
| `convex` | `typecheck`, `test`, `build` | `convex dev` or deployed Convex URL plus provider key in Convex env. |
| `discord` | `typecheck`, `test`, `build` | Discord app credentials, bot install, provider key. |
| `elizagotchi` | `typecheck`, `build` | Browser gameplay smoke test. |
| `farcaster` | `typecheck`, `build` | Neynar/Farcaster credentials; start with dry-run. |
| `farcaster-miniapp` | `typecheck`, `build` | Farcaster mini app host plus wallet/provider integrations. |
| `form` | No local typecheck/build script | Manual run through shared chat entrypoint with one provider key. |
| `game-of-life` | `typecheck`, `build` | Optional manual CLI/gameplay run. |
| `gcp` | `typecheck`, `build` | GCP project, Cloud Run deployment, deployed test client URL. |
| `html` | Typecheck/build skip scripts | Browser smoke test from static server. |
| `lp-manager` | `typecheck`, `test`, `build` | Isolated Solana/EVM wallets and RPCs for live liquidity paths. |
| `mcp` | `typecheck`, `test`, `build` | OpenAI key or compatible endpoint for live MCP chat. |
| `moltbook` | `typecheck`, `build` | `LLM_API_KEY`; token only for write actions. |
| `moltbook/bags-claimer` | Typecheck/build skip scripts | Wallet/RPC setup for claim flow. |
| `next` | `typecheck`, explicit build skip | `build:next` for opt-in Next.js bundle verification; provider key for live chat. |
| `react` | `typecheck`, `build` | Browser smoke test. |
| `rest-api/elysia` | `typecheck`, `build` | Start server and run HTTP chat flow. |
| `rest-api/express` | `typecheck`, `build` | Start server and run HTTP chat flow. |
| `rest-api/hono` | `typecheck`, `build` | Start server and run HTTP chat flow. |
| `roblox` | `typecheck`, `test`, `build` | Roblox Studio place, Open Cloud key, tunnel/shared-secret bridge test. |
| `smartglasses` | `typecheck`, `test` | Even Realities simulator or BLE hardware evidence report. |
| `supabase` | Static review; no package scripts | Supabase CLI/Deno function serve or deployment with anon key and `OPENAI_API_KEY`. |
| `telegram` | `typecheck`, `build` | Telegram bot token and provider key. |
| `text-adventure` | `typecheck`, `build` | Optional manual CLI playthrough. |
| `tic-tac-toe` | `typecheck`, `build` | Optional manual/bench game modes. |
| `trader` | `typecheck`, `build` | Paper-trading UI flow, then isolated-wallet live testing only when intended. |
| `twitter-xai` | `typecheck`, `build` | X/xAI credentials; start with `TWITTER_DRY_RUN=true`. |
| `vercel` | `typecheck`, `test`, `build` | Vercel project/env plus deployed or `vercel dev` API endpoint. |

## Not Yet Proven By Local Automation

These requirements cannot be honestly marked complete from local scripts alone:

- External account deployments: AWS, GCP, Cloudflare, Convex, Supabase, Vercel.
- Public/social posting flows: Bluesky, Discord, Farcaster, Telegram, Twitter/X.
- Desktop or hardware flows: Roblox Studio, Safari/Xcode, Capacitor device builds,
  Electron app launch, Smartglasses BLE hardware.
- Financial transaction flows: `trader`, `lp-manager`, and wallet-enabled
  Farcaster mini app paths.

Use `setup-guide.html` for the account setup links and keep dry-run or paper
trading modes enabled until the target account, project, or wallet is verified.
