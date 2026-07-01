# Issue 8912 Evidence: computer-use progress streaming and approval relay

## What changed

- `COMPUTER_USE_AGENT` now accepts `streamProgress: true` and emits per-step chat callbacks with compact text plus structured progress data.
- `COMPUTER_USE` now relays pending desktop approval requests through callback content with a shared `[CHOICE:computeruse-approval ...]` block and resolves `approve:<id>` / `deny:<id>` button payloads.

## Verification

- `bun run --cwd plugins/plugin-computeruse typecheck`
- `bun run --cwd plugins/plugin-computeruse test src/__tests__/computer-use-agent.test.ts src/__tests__/use-computer-action.test.ts`
- `bun run --cwd plugins/plugin-computeruse test`
- `SCENARIO_USE_LLM_PROXY=1 ELIZA_SCENARIO_USE_LLM_PROXY=1 bun --conditions eliza-source --tsconfig-override tsconfig.json packages/scenario-runner/src/cli.ts run packages/scenario-runner/test/scenarios/deterministic-computeruse-progress-approvals.scenario.ts --scenario deterministic-computeruse-progress-approvals --lane pr-deterministic --run-dir .github/issue-evidence/8912-computeruse-progress-approvals-run --report .github/issue-evidence/8912-computeruse-progress-approvals-scenario.json --export-native .github/issue-evidence/8912-computeruse-progress-approvals-native.jsonl`
- `bun --conditions eliza-source --tsconfig-override tsconfig.json packages/scenario-runner/src/cli.ts run packages/scenario-runner/test/scenarios/deterministic-computeruse-progress-approvals.scenario.ts --scenario deterministic-computeruse-progress-approvals --lane pr-deterministic --run-dir .github/issue-evidence/8912-computeruse-progress-approvals-live-run --report .github/issue-evidence/8912-computeruse-progress-approvals-live-scenario.json --export-native .github/issue-evidence/8912-computeruse-progress-approvals-live-native.jsonl`
- `SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts run test/scenarios --lane pr-deterministic --scenario deterministic-browser-computeruse-progress --report ../../.github/issue-evidence/8912-browser-computeruse-progress-scenario-rerun.json --export-native ../../.github/issue-evidence/8912-browser-computeruse-progress-native-rerun.jsonl --run-dir ../../reports/scenarios/8912-browser-computeruse-progress-rerun` (run from `packages/scenario-runner`)
- `bun run verify`

## Artifacts

- Deterministic scenario report: `.github/issue-evidence/8912-computeruse-progress-approvals-scenario.json`
- Deterministic run viewer: `.github/issue-evidence/8912-computeruse-progress-approvals-run/viewer/index.html`
- Live-runtime scenario report: `.github/issue-evidence/8912-computeruse-progress-approvals-live-scenario.json`
- Live-runtime run viewer: `.github/issue-evidence/8912-computeruse-progress-approvals-live-run/viewer/index.html`
- Native JSONL exports: `.github/issue-evidence/8912-computeruse-progress-approvals-native.jsonl`, `.github/issue-evidence/8912-computeruse-progress-approvals-live-native.jsonl`
- Browser + computer-use progress scenario rerun: `.github/issue-evidence/8912-browser-computeruse-progress-scenario-rerun.json`
- Browser + computer-use native export/manifest: `.github/issue-evidence/8912-browser-computeruse-progress-native-rerun.jsonl`, `.github/issue-evidence/8912-browser-computeruse-progress-native-rerun.manifest.json`
- Browser + computer-use run viewer screenshot: `.github/issue-evidence/8912-browser-computeruse-progress-viewer-rerun.png`

All scenario runs listed above passed. The live-runtime run used provider `openai`; the direct-action turns do not perform model-boundary calls, so the native JSONL files are empty by design.

## N/A evidence

- Video: N/A. This PR does not change `packages/cloud-frontend`, app UI, or a browser-rendered surface. The user-visible connector payload is text/data emitted through action callbacks and is asserted in unit tests, scenario output, and the run viewer screenshot above.
- Audio: N/A. No voice, STT, TTS, or transcript path changed.
