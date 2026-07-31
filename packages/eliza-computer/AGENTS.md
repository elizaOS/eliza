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
```

`leaderboard:generate` reads GitHub through the authenticated `gh` CLI or
`GITHUB_TOKEN`; it fails loudly when live data cannot be loaded. The UI keeps
loading, empty, stale, and error states distinct. Never fabricate an empty or
zero leaderboard after an ingestion failure.

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
Production is the protected `develop` deployment unless maintainers change the
release policy. Claim the deploy/DNS lever on the issue before changing Pages,
zones, nameservers, DNSSEC, custom domains, or registrar state.

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
