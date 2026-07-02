# 10471 cloud-apps structured confirmation

## Scope

This slice removes raw English prose confirmation parsing from the three
cloud-apps destructive/security/money actions:

- `DELETE_APP`
- `REGENERATE_APP_API_KEY`
- `WITHDRAW_APP_EARNINGS`

Each action now stores a pending confirmation task on the first ask and acts
only on a later turn carrying structured `confirm: true`. A later
`confirm: false` cancels and consumes the pending confirmation. Plain text such
as `yes` is not authorization.

## Evidence reviewed

- Scenario runner report:
  `.github/issue-evidence/10471-cloud-apps-structured-confirm-scenario.json`
- Scenario runner matrix and viewer:
  `.github/issue-evidence/10471-cloud-apps-structured-confirm-run/matrix.json`
  and
  `.github/issue-evidence/10471-cloud-apps-structured-confirm-run/viewer/index.html`
- Native export manifest:
  `.github/issue-evidence/10471-cloud-apps-structured-confirm-native.manifest.json`

Manual review notes:

- The scenario booted a real `AgentRuntime`, registered the source
  `cloudAppsPlugin`, configured runtime cloud settings, and sent SDK traffic to
  a loopback HTTP Cloud API.
- The first delete turn returned `confirmationRequired: true` and did not
  delete.
- A follow-up `yes` returned "still waiting for confirmation" and did not
  delete.
- A follow-up `confirm: true` deleted exactly once.
- API-key rotation required a pending confirmation; the plaintext key appeared
  once in `userFacingText` and not in structured `data`.
- Withdrawal required a pending confirmation; the first-turn `$50` amount was
  used even though the confirmation text said `$500`.
- The custom final check confirmed exactly one Cloud call for delete, exactly
  one for key rotation, exactly one for withdrawal, and a withdrawal body with
  `amount: 50` plus an `idempotency_key`.

## Commands

```bash
bun run build:core
bun test --coverage-reporter=lcov __tests__
bun run --cwd plugins/plugin-cloud-apps typecheck
bun run --cwd plugins/plugin-cloud-apps lint:check
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts run ../../plugins/plugin-cloud-apps/test/scenarios --scenario cloud-apps-structured-confirm --lane pr-deterministic --run-dir ../../.github/issue-evidence/10471-cloud-apps-structured-confirm-run --report ../../.github/issue-evidence/10471-cloud-apps-structured-confirm-scenario.json --export-native ../../.github/issue-evidence/10471-cloud-apps-structured-confirm-native.jsonl
git diff --check
```

Observed results:

- `build:core`: passed.
- Plugin tests: 117 pass, 0 fail.
- Typecheck: passed.
- Biome lint: passed.
- Scenario: 1 passed, 0 failed, 0 skipped.
- `git diff --check`: passed.

## N/A evidence

- Screenshots/video: N/A. This change has no UI route, visual component, or
  browser flow; it is an action safety gate.
- Audio: N/A. No voice/TTS/STT surface changed.
- Live model trajectory: not run for this slice. The model/planner prompt was
  not changed; the action contract is the structured `confirm` parameter. The
  scenario uses direct action turns so the destructive/money behavior is tested
  deterministically through the real runtime, task store, action handlers, SDK
  client, and loopback HTTP boundary without deleting a real Cloud app or moving
  real funds.
