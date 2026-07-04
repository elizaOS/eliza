# Issue #11821 — scenario-runner PR / press-distribution evidence (parent #11362)

Reviewer-verifiable scenario evidence for the PR / press-distribution (`VIEWS`
app-control) flow, captured with the scenario-runner.

## What this proves

The `deterministic-pr-smoke` scenario drives the real agent action pipeline
(real `AgentRuntime` + PGLite, no SQL mocks) through the app-control `VIEWS`
surface used by the PR / press-distribution workflow, and asserts **real domain
artifacts**, not just `ok: true` / "action called":

- A deterministic text reply round-trips through the runtime.
- Four `VIEWS` actions fire: `manager`, `pin`, `window` (alwaysOnTop), and
  `interact` (`fill-input` → `Remote Ledger Updated`).
- `finalChecks` assert the exact ordered sequence of **view-shell HTTP
  requests** the actions emitted (method + pathname + body + response + query),
  i.e. the persisted distribution/interaction effect — not routing text.

This is the `pr-deterministic` lane variant the issue asks for: it needs **no
live newswire credentials** and runs keyless in CI. The live-only variant that
consumes a real provider (issue #11820 dependency) remains gated and is **N/A**
here — no external provider credentials/spend approval were in scope for this
capture (see acceptance-criteria row below).

## Reproduce

```bash
cd packages/scenario-runner
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts \
  run test/scenarios --scenario deterministic-pr-smoke --lane pr-deterministic \
  --report   ../../.github/issue-evidence/11821-pr-distribution-scenario/report.json \
  --report-dir ../../.github/issue-evidence/11821-pr-distribution-scenario/viewer \
  --run-dir  ../../.github/issue-evidence/11821-pr-distribution-scenario/run \
  --export-native ../../.github/issue-evidence/11821-pr-distribution-scenario/native.jsonl
```

Result: `deterministic-pr-smoke passed (629ms)`, provider
`deterministic-llm-proxy`, 1 native `eliza_native_v1` row.

## Artifacts

- `report.json` — per-turn trajectory + finalCheck results.
- `native.jsonl` / `native.manifest.json` — training-corpus native export (1 row).
- `run/` — run viewer (`run/viewer/index.html`) + matrix + trajectory files.
- `viewer/` — report bundle.

## Manual review

Opened `report.json`: scenario `passed`; all 5 turns have empty
`failedAssertions`; the exact-deterministic-reply assertion and the exact
view-shell HTTP request-sequence `custom` finalCheck both pass. Confirmed the
`native.jsonl` row was written from the passed scenario.

## Acceptance-criteria coverage

- Assertions check real domain effects (exact HTTP request sequence), not only
  `ok: true` / action-called text — **met**.
- Live lane gated + fail-closed without credentials — **met** (this capture is
  the deterministic lane; live lane N/A, no provider creds/spend approval).
