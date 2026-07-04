# S1 — gpt-5.5-via-Codex harness routing (PROVEN LIVE)

Stage 1 linchpin: prove the scenario/benchmark harness runs live on **gpt-5.5**
through the user's **ChatGPT/Codex subscription** (no API key), and document the
exact incantation Stages 2-4 reuse.

## Verdict: PROVEN. No proxy needed for the scenario runner.

The routing mechanism **already exists** and is the sanctioned, develop-shippable
path — `@elizaos/plugin-cli-inference` selected via `ELIZA_CHAT_VIA_CLI=codex`.
It cold-spawns the official `codex exec -m gpt-5.5` binary, which reads its own
`~/.codex/auth.json` OAuth creds. eliza never sees the token.

## The mechanism (verified, not assumed)

1. **Auth shape** — `~/.codex/auth.json` is ChatGPT-OAuth (`auth_mode:"chatgpt"`,
   `tokens.{access_token,refresh_token,account_id}`), NOT a raw API key. Confirmed
   by reading structure only (no token values printed).
2. **Provider selection seam** — `packages/core/src/testing/live-provider.ts`
   `selectLiveProvider()`. The `cli` provider (`selectCliProvider`, L203-230) is
   chosen when `ELIZA_CHAT_VIA_CLI∈{claude,claude-sdk,codex,codex-sdk}` **and** the
   backend's on-disk creds exist. It is **LAST** in preference order, so ANY real
   API key or on-disk Eliza Cloud key wins first — those must be absent for codex
   to be selected. `pluginPackage = "@elizaos/plugin-cli-inference"`, model
   defaults to `gpt-5.5`.
3. **Scenario runner wiring** — `packages/scenario-runner/src/runtime-factory.ts`
   L302 `resolveScenarioProviderConfig` → `selectLiveProvider` → registers the cli
   plugin (L480-492) → adds a `TEXT_SMALL→TEXT_LARGE` bridge (L494-517) because the
   cli plugin registers large-tier handlers only.
4. **Codex model handler** — `plugins/plugin-cli-inference/index.ts` registers
   `TEXT_LARGE / TEXT_MEGA / RESPONSE_HANDLER` (always) and `ACTION_PLANNER`
   **only when `ELIZA_PLANNER_NATIVE_TOOLS=0`** (text-planner mode — REQUIRED, else
   the planner has no handler in a cli-only runtime). `CodexCli.generate()`
   (`src/codex-cli-exec.ts` L182-196) spawns
   `codex exec -m <ELIZA_CLI_CODEX_MODEL> -s read-only --skip-git-repo-check -C <tmp> --color never --json <prompt>`.
5. **Two codex plugins exist — don't confuse them:**
   - `@elizaos/plugin-cli-inference` (subprocess `codex exec`) — the sanctioned path
     `selectLiveProvider` uses. **This is what the harness runs.**
   - `@elizaos/plugin-codex-cli` (in-process HTTP to `chatgpt.com/backend-api/codex/responses`,
     `CodexBackend`) — faster, no subprocess, but NOT wired into `selectLiveProvider`.
     It is the ready-made building block for a codex→OpenAI proxy if one is ever needed
     (see Stage-2 benchmark note below).

## One real change required to make it work in a fresh worktree

`plugins/plugin-cli-inference/package.json` was the ONLY plugin missing the
`eliza-source` export condition that every sibling plugin has. Without it, the
`bun --conditions eliza-source` source-mode run resolved `.` to the unbuilt
`dist/node/index.node.js` and threw `Cannot find module '@elizaos/plugin-cli-inference'`.
Added the condition (entry `./index.node.ts`), mirroring `plugin-app-control` et al.
This is a real defect fix, not a workaround — the sanctioned cli/codex scenario
provider was unreachable in source-mode worktrees.

## PROOF 1 — raw one-shot (`raw-oneshot-codex-gpt55.jsonl`)

```
codex exec -m gpt-5.5 -s read-only --skip-git-repo-check -C <tmp> --color never --json \
  "Reply with exactly the single word: PONG..."
```
→ exit 0, `{"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}`,
usage `{input_tokens:15932, output_tokens:24, reasoning_output_tokens:16}`. gpt-5.5
served it via the subscription.

## PROOF 2 — live scenario end-to-end (`report-app-list.json`, trajectory, native jsonl)

Scenario `app-list` ("show me the apps") PASSED in **77s** via `provider=cli`.
- Harness log: `[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=codex`,
  `text-planner mode`, `TEXT_SMALL→TEXT_LARGE bridge`, `provider: cli`.
- Real gpt-5.5 trajectory (5 `eliza_native_v1` rows in `native-app-list.jsonl`):
  - should_respond → `{"contexts":["connectors"],"intents":["list apps"],"replyText":"On it.","candidateActionNames":["LIST_APPS","LIST_CONNECTORS"]}`
  - ACTION_PLANNER → `{"action":"APP","params":{"action":"list"}}` (+ native toolCall `APP{action:list}`)
  - evaluation → structured `{"success":false,"decision":"FINISH","thought":"..."}`
- finalChecks (selectedAction / selectedActionArguments / actionCalled = `APP`/`list`)
  all green. The downstream "connection refused" is only the absent local apps
  backend — the **model's action selection was correct**.
- Provider is recorded as `default` at the model boundary (cli-inference doesn't
  tag the codex model id there); provenance is established by `providerName=cli` +
  the `ELIZA_CHAT_VIA_CLI=codex` gate + `-m gpt-5.5` argv + the raw one-shot.

## THE EXACT INCANTATION — Stage 2 fan-out (scenario corpus)

Run from `packages/scenario-runner`. `env -i` + `--env-file=<empty>` are load-bearing:
the root `.env` (auto-loaded by bun/dotenvx) sets provider keys and would make the
last-place cli provider lose. `ELIZA_CONFIG_PATH` → nonexistent neutralizes the
on-disk Eliza Cloud key (`~/.eliza/eliza.json`) which would otherwise select
plugin-openai. `ELIZA_PLANNER_NATIVE_TOOLS=0` is REQUIRED (else no planner handler).

```bash
cd packages/scenario-runner
EMPTYENV=$(mktemp); : > "$EMPTYENV"
env -i HOME="$HOME" PATH="$PATH" \
    ELIZA_CHAT_VIA_CLI=codex \
    ELIZA_PLANNER_NATIVE_TOOLS=0 \
    ELIZA_CLI_CODEX_MODEL=gpt-5.5 \
    ELIZA_CLI_CODEX_PLANNER_MODEL=gpt-5.5 \
    ELIZA_CLI_TIMEOUT_MS=240000 \
    ELIZA_SAVE_TRAJECTORIES=1 \
    ELIZA_BENCH_SKIP_EMBEDDING=1 \
    ELIZA_ALLOW_DEFAULT_SECRET_SALT=1 \
    ELIZA_CONFIG_PATH=/tmp/nonexistent-eliza-config.json \
    bun --env-file="$EMPTYENV" --conditions eliza-source --tsconfig-override ../../tsconfig.json \
      src/cli.ts run <SCENARIO_DIR> \
      --scenario <id>            # omit --scenario to run the whole dir \
      --report-dir <out/reports> \
      --run-dir  <out/run>       # writes trajectories/ + viewer/ \
      --export-native <out/native.jsonl>   # Stage 4 training rows
```

Corpus to fan out (984 `*.scenario.ts` total):
- `packages/test/scenarios` — **713** files (the big `live-only` corpus).
- `plugins/*/test/scenarios` — **229** files (per-plugin, incl. plugin-app-control).

Per-scenario isolation: PGLite can't be torn down/recreated in one process
(segfaults) — invoke `eliza-scenarios run` **once per scenario** from a shell loop
(the CLAUDE.md gotcha), or once per dir accepting a shared runtime.

Cost/throughput note: cold `codex exec` is ~20-40s/model-call; app-list = 77s for
~5 calls. 984 scenarios × several calls each is the "expensive full run" Stage 2
owns — do NOT run it here. Consider the warm `codex-sdk` backend for Stage 2
(requires `@openai/codex-sdk` — currently MISSING in node_modules — plus
`ELIZA_CLI_CODEX_BIN=$(which codex)`; the SDK-bundled codex 0.80.0 rejects gpt-5.5).

## e2e / live lane (same seam, canonical form)

`packages/scenario-runner/package.json` already ships:
```
test:live:e2e = bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
                src/cli.ts run ../../plugins/plugin-app-control/test/scenarios \
                --report-dir ../../reports/scenarios/live --run-dir ../../reports/scenarios/live
```
Prefix it with the codex `env -i … ELIZA_CHAT_VIA_CLI=codex …` block above and it
runs live on gpt-5.5. Same for `test:corpus` on `../test/scenarios`.

## Benchmark harness (packages/benchmarks) — STAGE 2 RESIDUAL

- **`framework/typescript/src/bench.ts`** `--real-llm` mode is **hardcoded to the
  OpenAI plugin** (accepts only `OPENAI_API_KEY` / `CEREBRAS_API_KEY`, sets
  `OPENAI_BASE_URL`). It has **no cli/codex branch**. To run these benchmarks on
  gpt-5.5-via-Codex, Stage 2 must EITHER (a) add a cli-provider branch that
  registers `@elizaos/plugin-cli-inference` when `ELIZA_CHAT_VIA_CLI` is set, OR
  (b) stand up a **codex→OpenAI-compatible proxy** and point `OPENAI_BASE_URL` at
  it. Option (b) is a ~1-file HTTP shim wrapping the existing
  `plugin-codex-cli` `CodexBackend` (already speaks the codex /responses SSE API);
  it would unify EVERY OpenAI-seam harness onto one endpoint. Recommend (b).
- **`eliza-adapter/` (Python, osworld/action-calling)** boots a real eliza server
  via `ELIZA_BENCH_SERVER_CMD` and inherits its environment. Because
  `plugin-cli-inference` auto-enables on `ELIZA_CHAT_VIA_CLI=codex`
  (`auto-enable.ts shouldEnable`), setting the codex env on the server command
  should route the booted agent to gpt-5.5 — mechanism exists; verify live in Stage 2.

## GEPA / DSPy leads (for S3, not run here)

- `packages/core/src/services/optimized-prompt.ts` — `OptimizedPromptService`
  (loads DSPy artifacts from `~/.local/state/milady/optimized-prompts/<task>/`).
- `scripts/training-harvest/` — `build-manifest.mjs` + `manifest.json` (Stage 4 harvest).
- `packages/benchmarks/smithers-adapter/tests/test_optimization.py`,
  `packages/benchmarks/lib/trajectory_normalizer.py` — optimization + normalization.

## Files

- `raw-oneshot-codex-gpt55.jsonl` / `.stderr` — raw provider proof.
- `report-app-list.json`, `run-app-list/` (trajectories + viewer + matrix),
  `native-app-list.jsonl` (+ manifest) — live scenario proof.
- `harness-run-app-list.log` — full boot + run log (secret-swept clean).
