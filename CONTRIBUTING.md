# Contributing

Contribute through issues, project boards, discussions, and pull requests against
`develop`. The repository is agent-operated as well as human-maintained, so the
useful record is the one a reviewer can inspect later: scoped work, current
board state, linked code, and evidence that the real behavior happened.

## Start Work

Open an issue before non-trivial work. The issue owns the scope, acceptance
criteria, blockers, and evidence plan. Use the existing issue templates when
they fit:

- [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md)
- [Agent Work Item](.github/ISSUE_TEMPLATE/agent_work_item.md)

Branch from the latest `develop` with `feat/<slug>`, `fix/<slug>`,
`docs/<slug>`, or `chore/<slug>`. Always sync before opening or updating a PR:

```bash
git fetch origin
git rebase origin/develop
bun install
bun run verify
```

Keep package-local instructions in view. Read root `AGENTS.md` or `CLAUDE.md`,
then the package-local `AGENTS.md` or `CLAUDE.md` before touching that package.

## GitHub Projects

Issues are work cards. GitHub Projects are the live kanban state and ownership
record. Use fields already present on the active board before adding new ones.

Standard flow:

1. `Todo`: ready and unclaimed.
2. `Claimed`: an owner has committed to the card.
3. `In progress`: code, config, deployment, or shared state is actively being
   changed.
4. `Needs-agent-verify`: evidence is posted and another agent should check it.
5. `needs-human-verify`: agent verification is done or not applicable; a human
   needs to approve or test.
6. `Done`: only the managing human or maintainer moves cards here unless the
   board explicitly says otherwise.

When claiming a card, comment `CLAIMING: <scope>` on the issue, set the Project
`Claimed by` field to your lane or agent tag, and keep `Status` accurate. If the
work needs a shared lever such as production deploys, staging environments, DNS,
secrets, billing, or rollback authority, comment `CLAIMING LEVER: <thing>`
before touching it and release the lever when done.

Use Discussions for coordination, handoffs, multi-card questions, and noisy
status. Do not make a Discussion the only acceptance record for a task. Durable
decisions belong back in issue bodies, project readmes, `AGENTS.md`, or package
docs.

## Pull Requests

Every change ships through a PR against `develop`; do not push feature or fix
work straight to `develop`. Link the issue or Project card the PR resolves.
Keep PRs scoped to one coherent change. If a sweeping mechanical edit touches
many packages, explain why it is mechanical and keep package-specific behavior
changes out of the same PR.

The branch must be rebased on `origin/develop` before review. Resolve every
conflict, run the relevant package checks, and run `bun run verify` when the
change is ready for full validation.

## Evidence

A reviewer must be able to confirm the real behavior without reading the code.
Attach complete, manually reviewed evidence inline in the issue or PR. Do not
commit evidence artifacts to the repository.

Required evidence by surface:

- UI changes: before and after full-page screenshots for desktop and mobile, an
  MP4 walkthrough of the full flow, frontend console and network logs, and
  backend logs when a server path fires.
- Agent, model, prompt, provider, or action changes: real live-model
  trajectories with inputs, outputs, tool calls, and results.
- Native, mobile, desktop, or device changes: per-platform screenshots,
  recordings, logs, and proof the installed build is current.
- Domain changes: the artifacts produced by the change, such as DB rows,
  memories, scheduled tasks, generated files, wallet balances, on-chain
  transaction hashes, audio, or device output.

If an evidence type does not apply, keep it visible in the PR and write
`N/A - <reason>`. Never leave evidence rows blank. Open every artifact yourself
before asking for review; capturing is not review.

Useful commands:

```bash
# Real-LLM agent trajectories
packages/scenario-runner/bin/eliza-scenarios run <scenario.ts> --report <out.json>

# E2E UI recordings
bun run test:e2e:record:review

# Full matrix review bundle
bun run test:matrix:review

# App + cloud-UI screenshots; required for packages/app UI changes
bun run --cwd packages/app audit:app

# Native per-platform capture when a native/mobile/desktop surface changes
bun run --cwd packages/app capture:ios-sim -- --issue <n> --slug <s>
bun run --cwd packages/app capture:android-emu -- --issue <n> --slug <s>
bun run --cwd packages/app capture:linux-desktop -- --issue <n> --slug <s>
bun run --cwd packages/app capture:windows-desktop -- --issue <n> --slug <s>
```

Post videos as MP4 so GitHub renders them inline, screenshots as JPG where
possible, and long logs in a `<details>` block. Re-capture evidence after
rebasing when `develop` changes the behavior under review.

## Security Reporting

The canonical security policy — reporting channel, disclosure window, and
remediation SLAs — is [`SECURITY.md`](SECURITY.md). In short: report
vulnerabilities privately to `security@elizalabs.ai`; do not open a public
GitHub issue for a live vulnerability, credential leak, exploit path, or
embargoed dependency issue. Include affected versions or commits, reproduction
steps, impact, and any safe proof of exploitability. Agents that encounter a
secret or suspected vulnerability must stop exposing details publicly and route
the finding to that mailbox or a maintainer-owned private channel.

Security, SOC2, and incident-response reference material lives under
[`packages/docs/security/`](packages/docs/security/). Package-specific security
implementation notes live in the relevant package docs.

## License

By contributing, you agree that your contribution is licensed under the
repository's MIT license.
