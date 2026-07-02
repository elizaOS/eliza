# #10695 Default Gemma 4 31B Evidence

## Source Check

- Cerebras model catalog: https://inference-docs.cerebras.ai/models/overview
- Gemma model page: https://inference-docs.cerebras.ai/models/gemma-4-31b
- Chat Completions API: https://inference-docs.cerebras.ai/api-reference/chat-completions

Confirmed from the official Cerebras docs during implementation:

- `gemma-4-31b` is a Cerebras-hosted chat model.
- Paid context window used in tables: `131_000`.
- Price used in cost tables: `$0.99/M` input, `$1.49/M` output.
- `reasoning_effort` is supported; the live check used `reasoning_effort: "none"`.

## Live Model Proof

- Artifact: `10695-gemma-cerebras-live-chat.json`
- Endpoint: `https://api.cerebras.ai/v1/chat/completions`
- Model: `gemma-4-31b`
- Response text inspected: `gemma default live check passed`
- Usage inspected: `prompt_tokens=41`, `completion_tokens=7`, `reasoning_tokens=0`

Live registry smoke:

```bash
ELIZA_RUN_LIVE_TESTS=1 bun test --coverage-reporter=lcov packages/core/src/runtime/__tests__/field-registry-cerebras.live.test.ts
```

Result: `2 pass`, `30 expect() calls`; both tests hit the live Cerebras endpoint through the shared default model.

## Visual Evidence

Full audit:

```bash
bun run --cwd packages/app audit:app
```

Result: `349 passed`. The relevant cockpit/task-coordinator GUI/TUI screenshots passed across mobile portrait, mobile landscape, desktop landscape, and iPad portrait.

After this capture, `origin/develop` advanced by `c3e624a1949` (`fix(ci): restore CodeQL threads to 8 now that paths-ignore shrank the DB (#10731)`), which only changes `.github/workflows/codeql.yml`. The branch was rebased onto that commit before PR creation; no runtime or UI files changed underneath the evidence.

Manual review:

- `10695-app-audit-contact-sheet.png`
- `10695-app-audit-manual-review.md`
- `10695-app-audit-summary.json`

Targeted desktop recordings:

- `10695-cockpit-gui-desktop-recording.webm` plus `10695-cockpit-gui-desktop-trace.zip`
- `10695-task-coordinator-gui-desktop-recording.webm` plus `10695-task-coordinator-gui-desktop-trace.zip`

I opened the copied finish frames and the contact sheet. No overlap, clipped text, broken responsive layout, console errors, hover violations, or screenshot quality issues were visible on the touched surfaces.

## Focused Test Results

- `bun install --frozen-lockfile --ignore-scripts` — passed after final rebase, no lockfile changes.
- `bun run verify` — stopped at the known repo-wide `audit:type-safety-ratchet` failure before typecheck/lint: `as unknown as: 108 current > 77 baseline`; listed files are outside this branch (`packages/feed/...`, `packages/agent/src/api/dispatch-route.ts`, `packages/app-core/platforms/electrobun/...`, etc.).
- `node packages/shared/scripts/generate-keywords.mjs --target ts` — passed.
- `bunx biome check --write ...changed files...` — passed; only pre-existing undeclared-env warnings in standalone Cerebras scripts.
- `bun run build:core` — passed after final rebase, `65 successful`, `65 total`.
- `ELIZA_RUN_LIVE_TESTS=1 bun test --coverage-reporter=lcov packages/core/src/features/trajectories/pricing.test.ts packages/core/src/runtime/__tests__/field-registry-cerebras.live.test.ts` — `29 pass`, `0 fail`, `89 expect() calls`.
- `bun test --coverage-reporter=lcov packages/agent/src/__tests__/view-llm-eval.test.ts packages/agent/src/api/provider-switch-config.test.ts packages/agent/src/runtime/eliza-cloud-config.test.ts` — `52 pass`, `0 fail`.
- `bun run --cwd packages/app-core test -- src/benchmark/__tests__/cerebras-endpoint.test.ts test/helpers/live-provider.test.ts --coverage.enabled=false` — `22 pass`.
- `bun test --isolate --coverage-reporter=lcov packages/cloud/shared/...` selected catalog/pricing/provider tests — `130 pass`.
- `bun run --cwd plugins/plugin-elizacloud test -- __tests__/unit/text-cerebras-response-format.test.ts --coverage.enabled=false` — `10 pass`.
- `bun run --cwd plugins/plugin-elizacloud test -- __tests__/text-native-plumbing.test.ts --coverage.enabled=false` — skipped because `ELIZAOS_CLOUD_API_KEY` is not set.
- `bun run --cwd plugins/plugin-openai test -- __tests__/cerebras-config.shape.test.ts --coverage.enabled=false` — `16 pass`.
- `bun run --cwd plugins/plugin-pty test -- test/eliza-code-spec.test.ts test/pty-routes.test.ts --coverage.enabled=false` — `29 pass`.
- `bun run --cwd plugins/plugin-agent-orchestrator test -- __tests__/unit/model-chooser-contract.test.ts __tests__/unit/opencode-spawn-config-auto-detect.test.ts --coverage.enabled=false` — `28 pass`.
- `bun run --cwd packages/ui test -- src/components/cockpit/cockpit-modes.test.ts src/components/cockpit/CockpitNewSessionForm.test.tsx --coverage.enabled=false` — `9 pass`.
- `bun run --cwd plugins/plugin-task-coordinator test -- src/CockpitRoute.test.tsx src/CockpitSessionPane.test.tsx --coverage.enabled=false` — `11 pass`.
