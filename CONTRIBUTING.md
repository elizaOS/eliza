# Contributing

Thanks for helping with elizaOS. Open an issue before non-trivial work, branch
from the latest `develop`, and ship changes through a PR against `develop`.
All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report
security issues privately through the [Security Policy](SECURITY.md), not public
GitHub issues.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

## Evidence Is Required

The binding shipping standard is [`PR_EVIDENCE.md`](PR_EVIDENCE.md). A reviewer
must be able to confirm the real behavior without reading the code. For any
frontend-testable change, a PR is not ready unless it includes:

- Before and after full-page screenshots for affected UI surfaces, desktop and
  mobile.
- A video walkthrough of the full flow.
- Backend structured logs and frontend console/network logs for the real path.
- Real-LLM trajectories for agent/action/provider/prompt/model changes.
- Domain artifacts where relevant: DB rows, memories, scheduled tasks, generated
  files, wallet or on-chain output, audio, or device output.

If an evidence type does not apply, keep the row visible and write
`N/A - <reason>`. Do not leave evidence rows blank.

Artifacts belong in [`.github/issue-evidence/`](.github/issue-evidence/); see
[`.github/issue-evidence/README.md`](.github/issue-evidence/README.md) for
naming and examples.

## Capture Commands

Use the existing capture tools rather than inventing one-off proof:

```bash
# Real-LLM agent trajectories
packages/scenario-runner/bin/eliza-scenarios run <scenario.ts> --report <out.json>

# E2E UI recordings
bun run test:e2e:record

# App + cloud-UI screenshots; required for packages/app UI changes
bun run --cwd packages/app audit:app

# Native per-platform capture when a native/mobile/desktop surface changes
bun run --cwd packages/app capture:ios-sim -- --issue <n> --slug <s>
bun run --cwd packages/app capture:android-emu -- --issue <n> --slug <s>
bun run --cwd packages/app capture:linux-desktop -- --issue <n> --slug <s>
bun run --cwd packages/app capture:windows-desktop -- --issue <n> --slug <s>
```

Build and deploy the latest code before capturing evidence. Open every artifact
you attach and inspect it by hand; capturing is not the same as review.
