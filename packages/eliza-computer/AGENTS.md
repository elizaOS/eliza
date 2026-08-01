# @elizaos/eliza-computer

Standalone Vite site and data pipeline for `eliza.army`, the public
contribution-compute entrypoint for elizaOS.

## Purpose

This package publishes the installable `contribute-to-eliza` skill, a live work
queue, and a transparent contribution leaderboard scoped to `elizaOS/eliza`.
It is a private application, not a library. Cloudflare Pages serves the static
build; GitHub Actions refreshes the public data and deploys only after package
checks pass.

The canonical skill source is
`../skills/skills/contribute-to-eliza/`. Never maintain a second skill copy
inside this package. `scripts/prepare-site.mjs` validates that source, copies
the raw Markdown endpoints, and builds the downloadable `.skill` archive.

The public checksum is only a corruption check. The generated installer uses
GitHub as an independent trust root: the revision must be current `develop`, a
`develop` ancestor whose complete canonical skill tree is byte-identical to
current `develop`, or an open, non-draft, same-repository PR head into `develop`
with the maintainer-controlled `eliza-army-release-candidate` label. It
recursively
requires the label event to follow the exact current-head commit event, rejects
candidates behind or divergent from current `develop`, and compares the bounded
canonical Contents API file set and immutable raw bytes with the archive.
Working-tree provenance, extra files, and missing files fail closed. Local
versions are immutable sibling directories behind an atomic
relative symlink; a process-bound kernel lock survives interrupted commands
without leaving a stale denial. Updates require an ancestor relationship and
retain the prior verified version. Rollback is explicit: both active and target
trees are byte-verified against GitHub, and the requested target is
reauthorized against current GitHub state immediately before activation. A
canonical per-version authorization receipt preserves the entry-time candidate
PR identity needed to verify a later squash-merge transition; it neither
authorizes rollback nor replaces source-byte verification. Never weaken the
fixed production GitHub origins, the concurrency lock, or the version/symlink
invariants. Tests may inject only deterministic `file://` authorities through
the generator's test option, never environment variables.

## Layout

```text
packages/eliza-computer/
  src/                  React UI, data contracts, scoring helpers
  public/               Pages headers/redirects plus generated site assets
  scripts/              skill packaging, live GitHub ingestion, evidence capture
  tests/                unit and real-browser coverage
  PRODUCT.md            users, purpose, principles, accessibility
  DESIGN.md             visual system and interaction rules
  wrangler.toml         Cloudflare Pages Direct Upload contract
```

Generated files under `public/brand/`, `public/downloads/`, and the raw hosted
skill endpoints are produced by `prepare:site`. Do not edit them by hand.

## Commands

Run from the repository root:

```bash
bun run --cwd packages/eliza-computer dev
bun run --cwd packages/eliza-computer leaderboard:generate
bun run --cwd packages/eliza-computer test
bun run --cwd packages/eliza-computer typecheck
bun run --cwd packages/eliza-computer lint:check
bun run --cwd packages/eliza-computer format:check
bun run --cwd packages/eliza-computer build
bun run --cwd packages/eliza-computer test:e2e
bun run --cwd packages/eliza-computer test:e2e:record
bun run --cwd packages/eliza-computer test:e2e:record:production
```

`leaderboard:generate` reads GitHub through the authenticated `gh` CLI or
`GITHUB_TOKEN`; it fails loudly when live data cannot be loaded. The UI keeps
loading, empty, stale, and error states distinct. Never fabricate an empty or
zero leaderboard after an ingestion failure.

The local evidence command builds and records the local preview, but refuses a
missing, empty, malformed, or older-than-eight-hours live ledger. The
production command never rebuilds: it records only the existing `dist`, targets
exactly `https://eliza.army`, byte-compares the deployed skill and ledger
artifacts with that directory, and records DNS, TLS, redirect, and security
header checks. Both modes capture into a fresh sibling staging directory,
validate every artifact and digest, and publish the evidence directory only as
one complete transaction.

## Contribution scoring contract

- Score accepted outcomes, not raw activity.
- Collect base merged-PR outcomes for the complete rolling 30-day window and
  deeply verify proof/test/review/issue bonuses for the complete trailing seven
  days. Publish both bounds and record counts; never silently sample.
- Keep rules versioned, public, and deterministic.
- Deduplicate by immutable GitHub IDs.
- Exclude bots, self-review, post-merge review, and repeated low-value comments.
- Cap review/comment awards by actor and artifact.
- Model disclosure is reported provenance, not proof, and never adds points.
- Every public snapshot records its repository, window, rule version,
  generation time, source cutoff, and any staleness.

## Work-candidate selection contract

The snapshot retains every open issue and PR for source-count integrity, but
each item publishes a deterministic `selection` decision. The UI advertises
only `candidate` items. Issues also require a maintainer-controlled
contributor-ready label and bounded scope. Exclude epics needing child issues,
human-gated work, unknown or bot authors, security-sensitive labels, blocked
work, active claims (including `claimed:<lane>` and
`review-claimed:<lane>`), drafts, active review requests, current-head
approvals, and current-head changes requests. Public claim comments reserve
work only for repository owners, members, or collaborators. The bundled live
report uses the same rules. These filters are fail-closed hints, not claim
authority; users must re-read live GitHub and Project state before acting.

## Model attribution

Contributions made through the skill must use an exact provider/model
identifier in the PR body and every issue/PR comment, along with client, skill
revision, a signed lane tag, and a machine-readable
`eliza-computer-attribution:v1` marker. Never include chain-of-thought, secrets,
tokens, private prompt content, or session IDs. A human-only contribution must
say so explicitly.

## Deployment

Use Cloudflare Pages Direct Upload from the checked-in workflow. Required
repository/environment secrets are `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; `GITHUB_TOKEN` is supplied by Actions for ingestion.
All production jobs use the protected `eliza-army-production` environment.
Its deployment-branch policy must use a selected-branch allowlist whose only
permanent entry is `develop`. It must require a designated release reviewer
and disallow administrator bypass. An active repository ruleset must require a
pull request, one approval, approval after the latest push, resolved review
threads, and non-fast-forward history for `develop`, with no bypass actors.
Access to the environment secrets and branch policy belongs only to designated
release operators. Claim the deploy/DNS lever on the issue before changing the
allowlist, Pages, zones, nameservers, DNSSEC, custom domains, or registrar
state.

Push, schedule, and manual releases are restricted to the exact checked-out
`develop` SHA; pull-request and feature-branch runs never deploy. Manual
dispatches must select `develop`. The workflow has no production-candidate
input or branch-admission path, so pull-request-controlled workflow code never
receives the protected environment's Cloudflare credentials. Keep `develop` as
the environment deployment-branch allowlist's only entry; never temporarily
allowlist a feature branch, wildcard, fork head, or tag.

Do not deploy production from a package script or a local working tree. The
workflow checks out the exact tested Actions SHA, installs the lockfile-pinned
Wrangler without lifecycle scripts, downloads the verified build, and lets
`wrangler.toml` select the Pages output directory before binding that deployment
to the same commit SHA. The release stays failed until Cloudflare's API reports
a new, clean, successful production deployment for that exact SHA; the workflow
records its deployment ID and immutable Pages URL.

The production domain is registered with Cloudflare Registrar in the same
account as the Pages project. The internal project slug remains
`eliza-computer`; the public authority is `https://eliza.army`. Do not claim
that a Pages deploy proves custom-domain DNS or TLS—verify both separately.

## Definition of done

The binding standard is root `AGENTS.md` and `CONTRIBUTING.md`. For this package:

- Rebase onto current `origin/develop`, run `bun install`, package checks, and
  root `bun run verify`.
- Test leaderboard pagination, deduplication, scoring caps, bot/self-review
  exclusion, model parsing, loading/empty/stale/error states, and skill archive
  integrity.
- Drive the built site in real Chromium at desktop and mobile sizes. Verify
  keyboard use, WCAG AA, install-copy feedback, raw Markdown, archive download,
  GitHub links, zero console errors, and zero failed first-party requests.
- Attach manually reviewed before/after full-page screenshots, OCR review,
  frontend console/network logs, an MP4 walkthrough, the generated `.skill`
  archive/checksum, live GitHub snapshot, deploy log, and production DNS/TLS/
  header response. Use `N/A - <reason>` only when a row truly cannot apply.
- Forward-test the skill with a fresh agent on real repository work and attach
  the model-named trajectory/output. A mock issue, fake review, or fixture in
  place of the real path is not launch evidence.
- Post evidence inline on the issue/PR; never commit captured evidence.
- Do not leave TODOs, stubs, placeholder content, dead controls, or silent
  fallback success.

Keep `CLAUDE.md` and `AGENTS.md` byte-identical.
