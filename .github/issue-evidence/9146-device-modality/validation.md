# Issue 9146 Device and Modality Validation

Date: 2026-06-24

## What This Proves

- Desktop/server local subprocess orchestration remains supported for every checked-in backend.
- Android direct/AOSP local-yolo remains supported for every checked-in backend.
- iOS, store builds, Android Play/store, and Android local-yolo without staged shell return explicit stub reasons instead of exposing unsupported local CLI spawn.
- Web, desktop, and Capacitor mobile clients share the same remote host APIs for task/session control; account selection and credential materialization stay on the host.
- Voice-origin tasks flow through the normal orchestrator task/session path, retain voice metadata, select the Claude subscription account, and produce a narrated completion.
- Multi-account follow-up prompts reuse the selected account for the active session.

## Artifacts

- `scenario-device-modality-report.json`: deterministic scenario-runner report for `orchestrator-device-modality-reach`.

## Validation Commands

```bash
bun install
bun run --cwd packages/core build
bun run --cwd plugins/plugin-agent-orchestrator lint:check
bun run --cwd plugins/plugin-agent-orchestrator typecheck
bun run --cwd plugins/plugin-agent-orchestrator build:ts
bun run --cwd plugins/plugin-agent-orchestrator test
bun run --cwd plugins/plugin-agent-orchestrator test:e2e:multi-account
SCENARIO_USE_LLM_PROXY=1 bun run --cwd plugins/plugin-agent-orchestrator test:scenarios
SCENARIO_USE_LLM_PROXY=1 bun --conditions=eliza-source packages/scenario-runner/src/cli.ts run plugins/plugin-agent-orchestrator/test/scenarios --lane pr-deterministic --scenario orchestrator-device-modality-reach --report .github/issue-evidence/9146-device-modality/scenario-device-modality-report.json
```

## Evidence Types Marked N/A

- Screenshots/video: N/A, no UI changed.
- Audio capture: N/A, no STT/TTS/audio rendering code changed. Voice is covered as an input modality and narrated-completion path in the scenario report.
- Live LLM trajectory: N/A for this deterministic support-matrix, stub, and account-affinity change; no model/prompt behavior changed.
