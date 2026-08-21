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

## Contribution Provenance

Provider, model, and agent-tooling disclosure is optional. Contributors must
not be blocked, prompted, or asked to reveal runtime metadata in order to open
an issue, comment, review, or pull request. When a contributor voluntarily
includes machine provenance, use the following interoperable footer:

```text
AI provider/model: <provider> / <exact-model-id>
Client / agent tooling: <client>
Contribution skill revision: elizaOS/eliza@<full-commit-sha>:packages/skills/skills/contribute-to-eliza
Attribution status: self-reported
— [<lane-tag>]
<!-- eliza-computer-attribution:v1 {"provider":"<provider-slug>","model":"<exact-model-id>","client":"<client>","skill_revision":"elizaOS/eliza@<full-commit-sha>:packages/skills/skills/contribute-to-eliza"} -->
```

Voluntary attribution is self-reported provenance, not a verified attestation
or a request for chain-of-thought. If supplied, it must be concrete,
internally consistent, and free of hidden reasoning, private prompts, session
IDs, credentials, access tokens, and other secrets. Repository validators
accept contributions with no attribution and validate only an attribution
block that an author chooses to provide.

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

Evidence is a reviewer-owned acceptance record rather than a required GitHub
Actions status. Use `scripts/check-pr-evidence.mjs` locally when preparing the
pull request, and reject missing or placeholder evidence during review. A PR
whose diff touches rendered UI should attach concrete before/after screenshots,
a walkthrough video, and OCR review artifacts.

**Before capturing, check your toolchain.** Run the doctor; it reports every
capture tool (tesseract, ffmpeg, Playwright browsers, GPU/Baidu OCR, Apple
Vision, VLM API keys, the claude/codex CLIs) and prints the exact install/start
command for anything missing. Install what it flags — a missing tool is a
fixable instruction, never a reason to ship without evidence.

### Install or repair the capture toolchain

From the repository root, one command installs or repairs the required
cross-platform capture dependencies and verifies their executable behavior:

```bash
bun run evidence:install-tools
```

The installer supports macOS with Homebrew, Windows with WinGet, and Linux with
apt-get, dnf, yum, apk, pacman, or zypper. It prefers healthy system or packaged
ffmpeg/ffprobe binaries instead of installing a redundant system copy, installs
the repository-pinned Playwright Chromium, and runs the strict doctor before it
returns success. Dependency bootstrap is locked and uses `--ignore-scripts`, so
it does not run unrelated repository postinstall or artifact-sync hooks.

Use `--github` to also install and execute the optional GitHub CLI; this does
not authenticate, persist credentials, change repository permissions, or prove
that a token can upload evidence. Use `--skip-deps` only when the locked
workspace dependencies are already installed. `--dry-run` prints the exact
argument-safe commands of the one resolved plan execution also consumes —
including the trailing strict doctor verification — without changing the host;
lines beginning `# assumes:` note where resolution depends on the dependency
step having run (packaged media binaries only resolve after `bun install`).
Add `--strict` to a dry run to fail when such assumptions remain. Every step
carries a deadline (15 minutes for package-manager operations, 2 minutes for
probes, 10 minutes for the doctor) so a wedged package manager or download
cannot block forever; multiply all deadlines on slow hosts with
`--timeout-scale=<factor>` or `ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE`.

```bash
bun run evidence:install-tools -- --github
bun run evidence:install-tools -- --skip-deps
bun run evidence:install-tools -- --dry-run
bun run evidence:install-tools -- --dry-run --strict
bun run evidence:install-tools -- --timeout-scale=3
```

Package downloads, Playwright browser installation, and package-manager index
updates require network access. Linux system packages use root directly or
require a successful `sudo -n` preflight; the installer never prompts for a
password. Homebrew runs as the current user, while WinGet uses silent,
non-interactive agreement flags. A missing Homebrew, WinGet, or supported Linux
package manager is an explicit failure. Windows PATH refresh is local to the
installer process, and no supported platform path edits shell profiles or
developer configuration. Missing optional accelerators remain explicit
non-blocking doctor findings; missing required OCR, media, or browser
capabilities fail the strict doctor.

```bash
bun run evidence:doctor                   # human capability report
bun run evidence:doctor -- --strict       # fail if a required tool is missing
bun run evidence:doctor -- --strict --json  # normalized CI/operator report
```

**Visual verification is layered and always available.** OCR runs the GPU/Baidu
Unlimited-OCR engine when a vision server is up and falls back to tesseract
otherwise; heuristic checks add flat-color/palette and pixel-diff comparisons;
and structured VLM Q&A (`vision-qa`) reviews screenshots against explicit
questions. When no API key or local server is configured, set
`ELIZA_VISION_QA_BACKEND=cli` to review screenshots through an already-authed
`claude` or `codex` CLI (auto-detected by the doctor) — real token usage is
recorded, so the review is admissible evidence.

Useful commands:

```bash
# Real-LLM agent trajectories
packages/scenario-runner/bin/eliza-scenarios run <scenario.ts> --report <out.json>

# E2E UI recordings
bun run test:e2e:record:review

# Full matrix review bundle
bun run test:matrix:review

# Re-open the newest verified bundle, or name the exact run explicitly
bun run evidence:review:no-open
bun run evidence:review:no-open -- --bundle=evidence/runs/<run-id>

# App + cloud-UI screenshots; required for packages/app UI changes
bun run --cwd packages/app audit:app

# Native per-platform capture when a native/mobile/desktop surface changes
bun run --cwd packages/app capture:ios-sim -- --issue <n> --slug <s>
bun run --cwd packages/app capture:android-emu -- --issue <n> --slug <s>
bun run --cwd packages/app capture:linux-desktop -- --issue <n> --slug <s>
bun run --cwd packages/app capture:windows-desktop -- --issue <n> --slug <s>
```

The matrix command snapshots producer hashes and filesystem identity before
executing lanes, creates one named bundle from only new or written/replaced
artifacts, runs the canonical
integrity verifier, and passes that exact run to the dashboard. Raw producer directories
are never scanned implicitly; `evidence:review -- --source=<dir>` is reserved
for deliberate archived or ad-hoc compatibility review.

Post videos as MP4 so GitHub renders them inline, screenshots as JPG where
possible, and long logs in a `<details>` block. Re-capture evidence after
rebasing when `develop` changes the behavior under review.

**Headless agents (no browser, cannot drag-and-drop):** upload media to the
dedicated [`pr-evidence` release](https://github.com/elizaOS/eliza/releases/tag/pr-evidence)
and embed the asset URLs — they end in a media extension and render inline via
`![](…)`. Prefer the one-command tool, which also patches the PR rows and
validates them locally:

```bash
# name files <pr-number>-<artifact>.<ext>, then:
node scripts/pr-evidence.mjs attach 15171 15171-after-desktop.jpg 15171-walkthrough.mp4
# embed in the PR evidence rows:
#   ![after](https://github.com/elizaOS/eliza/releases/download/pr-evidence/15171-after-desktop.jpg)
```

GitHub caps a release at 1000 assets, so once `pr-evidence` fills, `attach`
rolls uploads into overflow releases (`pr-evidence-2`, `pr-evidence-3`, …) and
emits the URL of whichever release holds the asset. The gate accepts the whole
`pr-evidence`/`pr-evidence-N` family identically, so no manual tag juggling is
needed — always attach via the script rather than a raw `gh release upload`,
which fails once the target release is full.

Never delete assets referenced by an open PR. A worked example of a fully
evidenced PR (before/after screenshots, MP4 walkthroughs, OCR readout,
vision-QA trajectory with the model named, pixel-diff report, zero-error
frontend logs) is [#15171](https://github.com/elizaOS/eliza/pull/15171).

## Security Reporting

The canonical security policy — reporting channels, disclosure window, and
remediation SLAs — is [`SECURITY.md`](SECURITY.md). In short: report
vulnerabilities privately through [GitHub Security Advisories](https://github.com/elizaOS/eliza/security/advisories/new)
or `security@elizalabs.ai`; do not open a public GitHub issue for a live
vulnerability, credential leak, exploit path, or embargoed dependency issue.
Include affected versions or commits, reproduction steps, impact, and any safe
proof of exploitability. Contributors who encounter a secret or suspected
vulnerability must stop exposing details publicly and route the finding through
those private channels.

Security architecture and hardening notes live in
[`packages/docs/security.md`](packages/docs/security.md). SOC2 and
incident-response reference material lives under
[`packages/docs/security/`](packages/docs/security/). Package-specific security
implementation notes live in the relevant package docs.

## License

By contributing, you agree that your contribution is licensed under the
repository's MIT license.
