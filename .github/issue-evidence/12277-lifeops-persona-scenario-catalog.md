# Issue #12277 Evidence: LifeOps Persona Scenario Catalog Foundation

## Scope

- Added the optional `tier` metadata path for scenario definitions, static metadata loading, reports, and native JSONL export.
- Added empty persona pack catalog scaffolds for parent issue #12186 with a total target count of 212 scenarios.
- Added the LifeOps persona scenario authoring guide and a catalog coverage checker.
- No runtime agent behavior, prompt behavior, UI, connector, model routing, device, audio, wallet, or on-chain behavior changed.

## Commands Reviewed

```bash
cmp -s packages/scenario-runner/CLAUDE.md packages/scenario-runner/AGENTS.md
```

Result: passed; package-local agent docs remain identical.

```bash
node -e 'const fs=require("fs"); for (const f of fs.readdirSync("plugins/plugin-personal-assistant/test/scenarios/_catalogs").filter((f)=>f.endsWith(".catalog.json"))) JSON.parse(fs.readFileSync("plugins/plugin-personal-assistant/test/scenarios/_catalogs/"+f,"utf8")); console.log("catalog-json-ok");'
```

Result: passed; all catalog JSON files parsed.

```bash
node packages/scripts/check-lifeops-persona-catalog-coverage.mjs --json
```

Result: passed; 8 packs found, target total 212, authored 0, verified 0, errors `[]`.

```bash
bun test --cwd packages/scenario-runner src/scenario-expansion.test.ts src/native-export.test.ts
```

Result: passed; 25 tests passed.

```bash
bun test --cwd packages/scenario-runner src/corpus-assertion-guard.test.ts src/action-effect-ratchet.test.ts src/echo-assertion-ratchet.test.ts src/skippable-check-ratchet.test.ts
```

Result: passed after rebasing onto current `origin/develop` and updating the explicit pr-deterministic corpus baseline for the already-present `persona.flexible-scheduling` scenario; 14 tests passed.

```bash
python3 -m pytest packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py::test_optional_scenario_tiers_are_valid -q -s
```

Result: passed; printed `LifeOpsBench scenarios with tier metadata: 0`.

```bash
python3 -m py_compile packages/benchmarks/lifeops-bench/eliza_lifeops_bench/types.py packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py
```

Result: passed.

```bash
bunx @biomejs/biome check packages/scripts/check-lifeops-persona-catalog-coverage.mjs packages/scenario-runner/schema/index.js packages/scenario-runner/src/cli.ts packages/scenario-runner/src/executor.ts packages/scenario-runner/src/loader.ts packages/scenario-runner/src/native-export.ts packages/scenario-runner/src/native-export.test.ts packages/scenario-runner/src/scenario-expansion.test.ts packages/scenario-runner/src/types.ts packages/scenario-runner/src/corpus-assertion-guard.test.ts plugins/plugin-personal-assistant/test/scenarios/_catalogs packages/scenario-runner/CLAUDE.md packages/scenario-runner/AGENTS.md packages/benchmarks/lifeops-bench/SCENARIO_AUTHORING.md .github/issue-evidence/12277-lifeops-persona-scenario-catalog.md
```

Result: passed; touched files checked, no fixes applied.

```bash
git diff --check
```

Result: passed.

## Blocked Or Unrelated Gates

```bash
python3 -m pytest packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py -q
```

Result: blocked by missing snapshot fixtures in this checkout:

- `packages/benchmarks/lifeops-bench/data/snapshots/tiny_seed_42.json`
- `packages/benchmarks/lifeops-bench/data/snapshots/medium_seed_2026.json`

The new tier validation test passed independently.

```bash
bun run --cwd packages/scenario-runner typecheck
```

Result: blocked by broad repository dependency/type-generation state unrelated to this change, including missing declarations for modules resolved through `dist/node_modules` and missing generated shared/core files.

```bash
bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts list ../test/scenarios --validate-scenarios
bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts list ../../plugins/plugin-personal-assistant/test/scenarios --validate-scenarios
```

Result: blocked before scenario validation by a missing generated core i18n module:
`packages/core/src/i18n/generated/validation-keyword-data.ts`.

## N/A Evidence

- Real-LLM trajectories: N/A - this is catalog/schema/report metadata scaffolding with empty new catalogs and no agent prompt or model behavior changes.
- UI screenshots, video, frontend logs, and app audit: N/A - no UI code changed.
- Backend logs: N/A - no server runtime path changed.
- Native/mobile/desktop capture: N/A - no platform runtime code changed.
- Audio evidence: N/A - no voice, transcript, STT, or TTS behavior changed.
- Domain artifacts: N/A beyond the added catalog files and command outputs above.
