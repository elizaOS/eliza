# Issue 8801 - keyless harness CI evidence

Scope: folds the keyless harness proofs into the required `test.yml`
`test-status` path through `zero-key-e2e`, makes the scenario corpus accounting
explicit, and records the remaining broad adoption work in follow-up #10757.

Manual review:

- Confirmed `zero-key-harness-e2e` blanks provider keys and runs the central
  mock harness plus `plugin-anthropic` and `plugin-discord` `test:harness`.
- Confirmed `zero-key-e2e` now depends on `zero-key-harness-e2e` and fails the
  required zero-key aggregate when that harness job is not successful.
- Confirmed the external `pr-deterministic` corpus is guarded by exact scenario
  IDs, not a loose count or regex scan.
- Confirmed the source-mode scenario executor can auto-load
  `@elizaos/plugin-anthropic-proxy`, so `anthropic-proxy.proxy-status` runs
  instead of silently skipping when plugin `dist/` files are absent.
- Confirmed default scenario coverage reports covered, deferred, and missing
  scenarios separately, with deferred default coverage tied to #10757.

Verification:

```bash
OPENAI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= OPENROUTER_API_KEY= GOOGLE_GENERATIVE_AI_API_KEY= CEREBRAS_API_KEY= \
  bun run --cwd packages/scenario-runner test -- \
  src/executor.test.ts src/corpus-assertion-guard.test.ts src/scenario-pr-workflow.test.ts
# 3 pass, 48 tests pass

OPENAI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= OPENROUTER_API_KEY= GOOGLE_GENERATIVE_AI_API_KEY= CEREBRAS_API_KEY= \
  bun run --cwd plugins/plugin-anthropic test:harness
# 1 pass, 2 tests pass

OPENAI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= OPENROUTER_API_KEY= GOOGLE_GENERATIVE_AI_API_KEY= CEREBRAS_API_KEY= \
  bun run --cwd plugins/plugin-discord test:harness
# 1 pass, 1 test pass

cd packages
OPENAI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= OPENROUTER_API_KEY= GOOGLE_GENERATIVE_AI_API_KEY= CEREBRAS_API_KEY= \
  bunx vitest run --config test/mocks/vitest.config.ts test/mocks/__tests__/
# 3 pass, 57 tests pass

node packages/scripts/check-scenario-workflow-coverage.mjs \
  --report-dir reports/scenarios/catalog-inventory
# scenario workflow coverage 685/707; deferred 22; missing 0; untagged-lane 0

actionlint .github/workflows/test.yml \
  .github/workflows/keyless-harness-e2e.yml \
  .github/workflows/scenario-pr.yml
# no output, exit 0

bunx biome check <touched source and evidence files>
# Checked 12 files. No fixes applied.

git diff --check
# no output, exit 0

OPENAI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= OPENROUTER_API_KEY= GOOGLE_GENERATIVE_AI_API_KEY= CEREBRAS_API_KEY= \
  SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run ../test/scenarios/anthropic-proxy \
  --lane pr-deterministic \
  --report-dir ../../reports/scenarios/pr-deterministic-anthropic-proxy \
  --run-dir ../../reports/scenarios/pr-deterministic-anthropic-proxy
# 1 passed, 0 failed, 0 skipped of 1

OPENAI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= OPENROUTER_API_KEY= GOOGLE_GENERATIVE_AI_API_KEY= CEREBRAS_API_KEY= \
  bun run --cwd packages/scenario-runner test:corpus:pr:e2e
# 27 passed, 0 failed, 0 skipped of 27
```

Full-suite note:

- `bun run verify` was attempted after `git fetch origin`, rebase onto
  `origin/develop`, and `bun install`. It failed before typecheck/lint at the
  repo-wide `audit:type-safety-ratchet` gate:
  - `as unknown as`: 107 current > 77 baseline
  - core/agent/app-core `?? 0`: 381 current > 380 baseline
  The branch diff adds no `as unknown as` casts, and its `?? 0` additions are in
  scenario-runner tests rather than the ratchet's failing core/agent/app-core
  production bucket.
- `bun run --cwd packages/scenario-runner test:pr:e2e` was attempted and stopped
  after existing deterministic app-control fixture/schema failures before the
  branch's targeted corpus lane. The targeted corpus lane above passed.

Evidence marked N/A:

- UI screenshots/video: N/A, no UI change.
- Live LLM trajectory: N/A, deterministic proxy and CI policy change only.
- Native/device capture: N/A, workflow and scenario-corpus contract change only.
