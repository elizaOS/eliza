# #10707 Evidence Mandate Summary

## What Changed

- PR template evidence requirements now render as visible checkboxes instead of hidden HTML comments.
- Bug and feature issue templates now render an **Evidence / reproduction proof** section with visible checklist rows.
- Root `CONTRIBUTING.md` documents the evidence standard and links `PR_EVIDENCE.md` plus `.github/issue-evidence/README.md`.
- Root `CLAUDE.md` and `AGENTS.md` contain the same explicit frontend-testable proof directive and remain byte-identical.
- `README.md` now points contributors to the evidence standard from the front door.

## Rendered Template Proof

Rendered with GitHub's Markdown API and inspected via Playwright screenshots:

- `10707-evidence-mandate-pr-template-before.png`
- `10707-evidence-mandate-pr-template-after.png`
- `10707-evidence-mandate-bug-template-before.png`
- `10707-evidence-mandate-bug-template-after.png`
- `10707-evidence-mandate-feature-template-before.png`
- `10707-evidence-mandate-feature-template-after.png`
- `10707-evidence-mandate-template-contact-sheet.png`
- `10707-evidence-mandate-walkthrough.webm`

Manual review: the contact sheet shows that the old PR template rendered only section headings because evidence rows were hidden in comments; the new PR template renders the evidence gate and checklist. The old issue templates rendered no evidence proof section; the new bug and feature templates render visible evidence checkboxes.

## Other Evidence

- Full docs diff: `10707-evidence-mandate-docs-diff.patch`
- Command transcript: `10707-evidence-mandate-cmd-check.txt`

## Command Verification

- `cmp -s CLAUDE.md AGENTS.md` passed; the files are byte-identical.
- Script lookup confirmed `test:e2e:record`, `audit:app`, and native capture scripts in `packages/app/package.json`, plus root `test:e2e:record` in `package.json`.
- `packages/scenario-runner/bin/eliza-scenarios` exists and is executable.
- `bun run test:e2e:record -- --skip-tests --skip-sheets --skip-viewer` passed, proving the root recording wrapper command path.
- `bun run --cwd packages/app audit:app -- --grep "builtin coverage matches navigation TAB_PATHS"` passed after workspace install: `1 passed`.
- `bun install --frozen-lockfile --ignore-scripts` passed after final sync, no changes.
- `bun run verify` stopped at the known repo-wide `audit:type-safety-ratchet` blocker before typecheck/lint: `as unknown as: 108 current > 77 baseline`; reported files are outside this docs/template change.

## N/A Rows

- Backend/frontend logs: N/A - this PR changes Markdown intake docs/templates only.
- Real-LLM trajectory: N/A - no agent/action/provider/prompt/model behavior changes.
- Native/mobile/desktop platform capture: N/A - no app runtime or native surface changes; rendered-template screenshots/video cover the changed behavior.
