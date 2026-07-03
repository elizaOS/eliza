# gpt-5.5 trajectory harvest — BENCHMARK + E2E families

Stage-2 extension of the scenario harvest to the **benchmark** and **e2e**
families. Same provider seam as the scenario family: `ELIZA_CHAT_VIA_CLI=codex`
selects the CLI-subscription provider `@elizaos/plugin-cli-inference`, whose
large-tier model handlers spawn `codex exec -m gpt-5.5` (the CLI reads
`~/.codex/auth.json` itself — no API key passes through eliza). Every run is
captured as an `eliza_native_v1` trajectory + a pass/fail verdict, so Stage 3
can GEPA-repair failures and Stage 4 can extract passes into training data.

Driver: `scripts/training-harvest/bench-e2e-harvest-runner.mjs` (sibling of the
scenario `harvest-runner.mjs`; it never touches the scenario code path). Same
`--provider-env` / `--resume` / `--shard` / `--limit` / `--dry-run` interface.

The driver folds in the two env vars the CLI route needs end to end but that a
bare provider-env file omits:
`ELIZA_PLANNER_NATIVE_TOOLS=0` (text-planner mode — the free-text CLI serves the
planner) and `ELIZA_TRAJECTORY_RECORDING=1`. It blanks `CEREBRAS_API_KEY` /
`OPENAI_API_KEY` in the e2e child env so the cli backend is selected
unambiguously (harvest wants gpt-5.5 only).

---

## BENCHMARK family — PROVEN LIVE on gpt-5.5 ✅

### What was wired

`packages/benchmarks/framework/typescript/src/bench.ts` `--real-llm` was
hardcoded to `@elizaos/plugin-openai` (needs `OPENAI_API_KEY`/`CEREBRAS_API_KEY`)
with no cli/codex branch — so benchmarks could not run on gpt-5.5-via-Codex.
Added a **CLI-subscription branch** to `resolveLlmPlugin()`:

- When `ELIZA_CHAT_VIA_CLI` is `claude` | `claude-sdk` | `codex` | `codex-sdk`,
  bench.ts loads `@elizaos/plugin-cli-inference` instead of the OpenAI plugin.
  The cli route is checked **first** (explicit opt-in wins over an ambient key).
- Because plugin-cli-inference registers **large-tier handlers only**, the
  branch pairs it with two zero-cost shims (mirroring the proven scenario-runner
  cli path): a zero-vector `TEXT_EMBEDDING` fallback (384-dim, matches the
  benchmark mock) and a `TEXT_SMALL → TEXT_LARGE` bridge — so a real message turn
  (incl. `checkShouldRespond`) runs end to end on the subscription CLI.
- New `--iterations=N` / `--warmup=N` overrides clamp the 50×5 perf default to
  **one real turn = one trajectory** (`--iterations=1 --warmup=0`), minimal cost.

The runtime's `JsonFileTrajectoryRecorder` writes `RecordedTrajectory` JSON to
`ELIZA_TRAJECTORY_DIR` (on by default), then the scenario-runner
`exportScenarioNativeJsonl` converts it to `eliza_native_v1` JSONL.

### Proven per-family run command

```bash
# one benchmark scenario, live on gpt-5.5 via codex
node scripts/training-harvest/bench-e2e-harvest-runner.mjs \
  --family benchmark \
  --provider-env scripts/training-harvest/s1-provider.example.json \
  --item single-message            # or --limit N for the cheapest-first prefix

# direct bench.ts invocation the driver runs under the hood:
ELIZA_CHAT_VIA_CLI=codex ELIZA_CLI_CODEX_MODEL=gpt-5.5 ELIZA_PLANNER_NATIVE_TOOLS=0 \
ELIZA_TRAJECTORY_DIR=<dir>/run/trajectories LOG_LEVEL=info \
bun --conditions eliza-source --tsconfig-override tsconfig.json \
  packages/benchmarks/framework/typescript/src/bench.ts \
  --real-llm --scenarios=single-message --iterations=1 --warmup=0 --output=<dir>/result.json
```

### Wire evidence (gpt-5.5, not OpenAI/Cerebras)

- `[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=codex — large-tier handlers spawn the codex CLI`
- `[cli-inference] text-planner mode (ELIZA_PLANNER_NATIVE_TOOLS=0) — ACTION_PLANNER also served via this route`
- RESPONSE_HANDLER model latency **~13.9s** = codex spawn (mock <1ms; Cerebras sub-second).
- `CEREBRAS_API_KEY` was present in-env yet the cli route won → cli-first ordering confirmed.
- Standalone smoke: `codex exec -m gpt-5.5 … → {"item":{"type":"agent_message","text":"WIRE_OK_GPT55"}}`, real token usage.

### Trajectory location + format

```
harvest/benchmark/framework/<scenario>/
  run/trajectories/<agentId>/<trajId>.json   RecordedTrajectory (recorder)
  native.jsonl                               eliza_native_v1 rows (boundary=vercel_ai_sdk.generateText)
  native.manifest.json                       scenario-runner export manifest
  result.json                                bench.ts scenario result
  verdict.json                               { status, rows, model, provider, exitCode }
  stdout.log / stderr.log
```

### Corpus + harvested results

- **Corpus: 18 model-driving framework scenarios** (the `db-*` / `startup-cold`
  scenarios never call the model → excluded). Ordered cheapest-first in the
  driver; the scaling/burst ones (`burst-1000`, `history-scaling-10000`, …) send
  hundreds of messages per turn — expensive on a live subscription, run last.
- **Harvested live on gpt-5.5 (3 items, 7 rows):**
  - `single-message` — passed, 1 row, replyText `"I'm doing fine. How can I help?"`
  - `minimal-bootstrap` — passed, 1 row, replyText `"Minimal test received."`
  - `with-should-respond` — passed, **5 rows** (checkShouldRespond turns exercise
    the `TEXT_SMALL → TEXT_LARGE` bridge — proves the shim + multi-row capture).

> The 53 registered `benchmarks/orchestrator` adapters are a separate, mostly
> Python/heavier surface: only the ~eliza-adapter-routed ones boot a runtime and
> would need the `ELIZA_BENCH_SERVER_CMD` + `native-export` wiring noted in
> `manifest.json`. This stage proves the CLI/codex seam on the framework TS
> benchmark (`bench.ts`), the one owned harness; the orchestrator adapters are
> out of scope for this stage.

---

## E2E family — wiring delivered; live run needs a built workspace ⚠️

### What was wired (three pieces)

1. **Provider selector cli branch** —
   `packages/app-core/test/helpers/live-provider.ts` `selectLiveProvider()` was
   key-based only (cerebras/groq/openai/anthropic/google/openrouter/local-llama-cpp),
   so every live-agent lane **skipped** under cli-only. Added a `selectCliProvider()`
   (mirrors core's canonical `packages/core/src/testing/live-provider.ts`):
   when `ELIZA_CHAT_VIA_CLI` names a cli backend and its creds exist, returns
   `{ name:"cli", pluginPackage:"@elizaos/plugin-cli-inference", … }`, checked
   FIRST. **Additive + env-gated** — inert when `ELIZA_CHAT_VIA_CLI` is unset, so
   existing CI is unaffected. Also added to `selectLiveProviderAsync`.
2. **A vitest config that surfaces the lanes** —
   `packages/app-core/vitest.harvest-live-agent.config.ts`. The default
   `vitest.config.ts` excludes every `*.live.e2e.test.ts` / `*.real.e2e.test.ts`
   with unconditional globs, and `vitest.app-real-e2e.config.ts` only surfaces
   `test/app/**` — so `test/live-agent/*.live.e2e.test.ts` was "dark". The new
   config inherits the default's `@elizaos/*` source aliases + adds
   `resolve.conditions:['eliza-source', …]` and includes the live-agent lanes.
3. **The driver e2e path** — runs the lane through `run-vitest.mjs` with
   `ELIZA_LIVE_TEST=1 ELIZA_INCLUDE_LIVE_E2E=1` + the trajectory env, converts
   with native-export, verdict = vitest pass/fail (coarser than per-scenario).

### Remaining precondition: build the workspace first

The live-agent lanes eagerly import first-party PLUGINS (`@elizaos/plugin-birdclaw`,
…) through the app-core plugin catalog. In a **dist-less fresh worktree** Vite
cannot resolve their entries (`Failed to resolve entry for package
"@elizaos/plugin-birdclaw"`), even with the `eliza-source` condition, so the lane
fails at transform before the provider gate runs. This is the standard nightly
"real" lane precondition (`bun run build` first — PR_EVIDENCE: "always build
before capturing"), **environmental, not a harvest-code gap**. The driver detects
it and records `status: "blocked-workspace-build"` (see the cloud-providers
verdict). With a built workspace, the three pieces above run the lanes on
gpt-5.5-via-Codex and emit `eliza_native_v1` trajectories.

> By contrast the benchmark family runs from source via `bun --conditions
> eliza-source` (bun's resolver honors the condition for all packages incl.
> plugins), which is why it harvests live with no build. The e2e vitest lanes go
> through Vite's resolver, which needs the plugin dists present.

### Per-family run command (after `bun run build`)

```bash
node scripts/training-harvest/bench-e2e-harvest-runner.mjs \
  --family e2e \
  --provider-env scripts/training-harvest/s1-provider.example.json \
  --lane cloud-providers          # substring filter; omit for the full harvestable set
```

Trajectory location: `harvest/e2e/<lane-slug>/run/trajectories/**` →
`native.jsonl` (+ `native.manifest.json`, `verdict.json`, logs).

### Lane classification — harvestable vs env-gated (51 lanes)

**Harvestable** (drive a real runtime turn, need ONLY a live provider). The
app-core lanes are unblocked by piece #1 above; the lifeops-harness lanes need
the same cli branch added to
`plugins/plugin-personal-assistant/test/helpers/lifeops-live-harness.ts` (that
harness is separately key-based) before they select gpt-5.5.

| Lane | Weight | Notes |
|---|---|---|
| `app-core/test/live-agent/cloud-providers.live.e2e` | light | in-process `createRealTestRuntime` + single `generateText` — **lightest** |
| `app-core/test/live-agent/real-runtime-helpers.live.e2e` | light | in-process ConversationHarness turn |
| `app-core/test/live-agent/experience-extraction.live.e2e` | light | ConversationHarness turn + extraction |
| `app-core/test/live-agent/action-invocation.live.e2e` | light | real action-selection turns (tool-call trajectory) |
| `app-core/test/live-agent/page-scoped-chat.live.e2e` | light | page-scoped chat turns |
| `app-core/test/live-agent/personality-routing.live.e2e` | light | in-process PGlite routing turns |
| `app-core/test/live-agent/runtime-debug.live.e2e` | light | init/useModel probe (not a clean message turn) |
| `app-core/test/live-agent/agent-runtime.live.e2e` | heavy | also spawns a `startEliza` subprocess |
| `app-core/test/live-agent/cloud-auth.live.e2e` | heavy | subprocess; mostly HTTP asserts + 1 guarded turn |
| `app-core/test/live-agent/database-conversation.live.e2e` | heavy | conversation via spawned `start:eliza` subprocess |
| `app-core/test/live-agent/plugin-lifecycle.live.e2e` | heavy | broad plugin-load sweep, not a focused turn |
| `app-core/test/app/streaming-visible-text.live.e2e` | heavy | needs Chrome + built `packages/app` |
| `app-core/test/app/memory-relationships.real.e2e` | heavy | needs Chrome + built app |
| `app-core/test/app/qa-checklist.real.e2e` | heavy | needs Chrome + built app |
| `pa/test/lifeops-chat.live.e2e` | medium | lifeops harness (needs harness cli branch) |
| `pa/test/lifeops-memory.live.e2e` | medium | lifeops harness (needs harness cli branch) |
| `pa/test/assistant-user-journeys.live.e2e` | heavy | large multi-journey lifeops suite (harness cli branch) |
| `pa/test/lifeops-gmail-chat.live.e2e` | medium | Gmail seeded locally (fake client id) → provider-only (harness cli branch) |
| `pa/test/selfcontrol-chat.live.e2e` | medium | real chat turn (harness cli branch) |

**Env-gated (excluded)** — need connector/cloud/device creds or run no live-model
turn (no trajectory):

- Connectors: `farcaster` (`FARCASTER_NEYNAR_API_KEY`+signer+fid), `feishu`
  (`FEISHU_APP_ID/SECRET`), `lens` (`LENS_API_KEY`+addr), `matrix`
  (`MATRIX_ACCESS_TOKEN`+homeserver), `nostr` (`NOSTR_PRIVATE_KEY`), `telegram`
  (`TELEGRAM_BOT_TOKEN`), `connector-health` (discord/telegram tokens).
- Cloud/remote: `cloud-login-persist` (posts a fake key, no model),
  `lifeops-activity-signals.remote` (`REMOTE_API_BASE`+`REMOTE_API_TOKEN`),
  `orchestrator-workbench` (needs a running dev stack + playwright).
- Device/hardware: `vision` (`OPENAI_API_KEY`+`ELIZA_REAL_APIS`+macOS screencapture),
  `computeruse` ×2 (headful desktop / real screenshot-click), `lifeops-screen-context`
  (Chrome screen capture), `selfcontrol-desktop`/`selfcontrol-dev` (desktop dev stack).
- No live-model turn (route/DB coverage only → no trajectory): `config-routes`,
  `health-and-dev-stack`, `permissions-and-sensitive`, `views-routes`,
  `views-interact-ws-roundtrip`, `conversation-deterministic` (deterministic
  proxy), `documents-api`, `form-plugin`, `knowledge-graph-service`,
  `lifeops-signal`, `reminder-review-job`, `pglite-e2e`, `training-api`,
  `shopify-api` (not-configured path).
- Pinned to a different provider: `journey-cerebras-eval` (hard-pinned to
  `CEREBRAS_API_KEY` grading — ignores the codex/gpt-5.5 selection).
- Uses the Codex CLI directly, not an AgentRuntime turn: `coding-agent-codex-artifact`.

### E2E corpus counts

- **51** live/real e2e lanes total (from `manifest.json`).
- **~19 harvestable** (drive a live-model turn, provider-only) — of which **11
  app-core lanes** are unblocked by this stage's selector cli branch (7 light + 4
  heavy-subprocess), **3 app-UI lanes** additionally need Chrome + a built
  `packages/app`, and **5 lifeops lanes** additionally need the lifeops-harness
  cli branch.
- **~32 env-gated** (excluded — connector/cloud/device creds or no live-model turn).

---

## Stage-2 fan-out (both families)

```bash
# resumable, shardable — same interface as the scenario harvest-runner
node scripts/training-harvest/bench-e2e-harvest-runner.mjs --family benchmark \
  --provider-env <s1.json> --resume --shard 0/4      # worker 0 of 4
node scripts/training-harvest/bench-e2e-harvest-runner.mjs --family e2e \
  --provider-env <s1.json> --resume                  # after `bun run build`

# offline driver self-test (enumerate only)
node scripts/training-harvest/bench-e2e-harvest-runner.mjs --family benchmark --deterministic --dry-run
```

`--resume` skips any item whose `verdict.json` exists; `--shard i/n` splits the
corpus deterministically across parallel codex workers; `--limit N` caps the run.

## Blockers / residuals

- **E2E live run** needs `bun run build` (workspace dist) before the vitest lanes
  can transform — an environmental precondition, wiring is complete.
- **Lifeops e2e lanes** need the same cli branch added to
  `lifeops-live-harness.ts` (a separate key-based selector) to select gpt-5.5.
- **Orchestrator benchmark adapters** (53) are a separate Python/heavier surface;
  only the eliza-adapter ones would need `ELIZA_BENCH_SERVER_CMD` + native-export
  wiring — out of scope for this stage.
