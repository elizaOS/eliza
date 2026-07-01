# Issue 10707 Evidence

Docs/template-only change to make the evidence mandate visible at issue and PR
intake.

## Rendered Template Previews

- `10707-evidence-mandate-pr-template-before.png`
- `10707-evidence-mandate-pr-template-after.png`
- `10707-evidence-mandate-bug-template-before.png`
- `10707-evidence-mandate-bug-template-after.png`
- `10707-evidence-mandate-feature-template-before.png`
- `10707-evidence-mandate-feature-template-after.png`

The matching `.html` files were rendered through GitHub's Markdown API, then
captured with Playwright.

## Live GitHub Captures

- `10707-evidence-mandate-live-github-pr-10747.png`
- `10707-evidence-mandate-live-github-pr-template-branch.png`
- `10707-evidence-mandate-live-github-bug-template-branch.png`
- `10707-evidence-mandate-live-github-feature-template-branch.png`
- `live-github-render-summary.txt`

These screenshots were captured from the live GitHub PR and branch file pages
after the draft PR was opened. The summary records HTTP status, page title, byte
size, and whether evidence text was detected on each branch template page.

## Walkthrough

- `10707-evidence-mandate-walkthrough.mp4`
- `10707-evidence-mandate-walkthrough.webm`

The recording opens the rendered after versions for the PR template, bug issue
template, and feature issue template, showing the visible evidence checklists.

## Command And Diff Evidence

- `docs-diff.patch` contains the docs/template diff for the issue scope.
- `cmd-check.txt` contains:
  - `diff CLAUDE.md AGENTS.md` with empty output and status 0,
  - script checks for the referenced capture commands,
  - `packages/scenario-runner/bin/eliza-scenarios --help`,
  - a successful `bun run --cwd packages/app audit:app` run (`369 passed`),
  - a partial `bun run test:e2e:record` run.
- `clean-worktree-install.log` contains a successful `bun install` from a clean
  `origin/develop` worktree.
- `clean-worktree-verify.log` contains the `bun run verify` attempt from that
  clean worktree. It fails in `audit:type-safety-ratchet` before lint/typecheck
  because the current baseline is exceeded (`as unknown as: 108 current > 77
  baseline`), unrelated to this docs/template diff.
- `e2e-record-partial-failures.txt` preserves failure context from the partial
  recording run. The exact command was interrupted after starting 1,091 tests
  because it was projected to run for hours; it is not proven green here.
