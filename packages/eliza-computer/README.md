# eliza.army

Accepted work on [`elizaOS/eliza`](https://github.com/elizaOS/eliza) can earn
from a $10,000 monthly contributor pool paid in USDC.

If selected for a payout, publish a public Solana or Ethereum address through
the [elizaOS profile editor](https://eliza.app/profile/edit). The editor
generates a hidden GitHub profile README comment for you to copy and commit.
The address remains public in README source, Git history, and elizaOS profile
data. Never enter a private key or seed phrase. Leaderboard points do not
determine payouts.

The package contains:

- a minimal React + Vite site for installing and running the canonical
  `contribute-to-eliza` skill;
- a GitHub ingestion/scoring pipeline scoped to this repository;
- a transparent contribution ledger and latest GitHub work snapshot;
- Cloudflare Pages Direct Upload configuration;
- unit, browser, accessibility, download-integrity, and production smoke tests.

## Local development

```bash
bun install
bun run --cwd packages/eliza-computer leaderboard:generate
bun run --cwd packages/eliza-computer dev
```

Open `http://127.0.0.1:4466`.

## Validation

```bash
bun run --cwd packages/eliza-computer lint:check
bun run --cwd packages/eliza-computer format:check
bun run --cwd packages/eliza-computer typecheck
bun run --cwd packages/eliza-computer test
bun run --cwd packages/eliza-computer build
bun run --cwd packages/eliza-computer test:e2e
bun run --cwd packages/eliza-computer test:e2e:record
```

The local recording command builds a preview and fails closed unless its
ledger is a recent, non-empty GitHub snapshot. After the exact verified
`dist` directory has been deployed, run
`bun run --cwd packages/eliza-computer test:e2e:record:production`. Production
recording does not rebuild. It byte-compares the remote skill, manifest,
archive, checksum, and ledger with local `dist`, then records the apex DNS, TLS
certificate, HTTP-to-HTTPS redirect, security headers, browser traffic,
screenshots, and walkthrough. Capture output is validated in a fresh sibling
directory and replaces `evidence/` only after every artifact and digest passes,
so an interrupted run cannot leave a mixed or authoritative-looking partial
bundle.

## Data and scoring

The production deploy generates `public/data/leaderboard.json` from the GitHub
API immediately before building. Base merged-PR outcomes are complete across
the rolling 30-day window. The more expensive verification data—resolved
issues, substantive non-self reviews, material test changes, and concrete
evidence—is complete across the trailing seven days. Every snapshot publishes
both windows and their record counts; the generator rejects missing or
out-of-window detail instead of silently sampling.

Test awards require at least 10 additions and 20 changed lines across
recognized, non-fixture test files. A closed issue needs a linked merged pull
request or a trusted confirmed/validated/triaged label; GitHub's `COMPLETED`
state reason alone does not qualify.

Per-contributor caps keep the ledger from becoming a volume contest: the
newest five merged pull requests, five resolved issues, five material-test
bonuses, 30 evidence points, and ten substantive reviews can score in their
respective windows. Input order cannot change which outcomes win a cap.

Evidence points come only from immutable GitHub attachments in stable rows in
the canonical PR body that the generator can fetch and structurally verify.
Mutable release assets, comment copies, inline text, unreachable or malformed
artifacts, arbitrary media links, and bare checksums do not score.
Raw comments, commit counts, and lines changed are not score-bearing. Model
disclosure is measured as valid versus eligible non-bot text sources and shown
as complete, partial, missing, or invalid, but never awards points.

Open work is ordered by actionability, claim state, label-derived priority, and
recency. Issue implementation claims use a recent `CLAIMING:` comment; pull
request review claims use a recent `CLAIMING REVIEW:` comment. Claim comments
expire after seven days unless a durable assignee or claim label remains, and
only comments from repository owners, members, or collaborators reserve work.
Issue candidates need a maintainer-controlled contributor-ready label and
bounded scope; epics needing child issues and human-gated work are excluded.
Pull-request authors never count as their own review claimant.

The public methodology, window, caps, exclusions, rule version, and refresh
timestamp ship inside every snapshot and are rendered on the site.

## Deployment

GitHub Actions builds and verifies the exact artifact, then uses Cloudflare
Pages Direct Upload. Configure a protected environment with:

- `CLOUDFLARE_API_TOKEN` — scoped to Cloudflare Pages Edit for the target
  account;
- `CLOUDFLARE_ACCOUNT_ID`.

Production has no local deploy script. Push, schedule, and manual deployment
runs are accepted only from `develop`; pull requests and feature branches never
receive the protected environment's Cloudflare credentials. `develop` requires
a reviewed pull request through an active no-bypass ruleset. The environment
also requires a designated release reviewer and disables administrator bypass.
The workflow checks out the exact tested `github.sha`, installs the
lockfile-pinned Wrangler without lifecycle scripts, deploys the downloaded
build using the checked-in `wrangler.toml` output-directory contract, and sends
that SHA to Cloudflare as clean commit metadata. It then waits for Cloudflare's
API to report a new, successful production deployment with that exact clean SHA
and records the deployment ID and immutable Pages URL before checking public
bytes.

The published bootstrap, manifest, skill, archive, and checksum use
`https://eliza.army` as their stable origin. The Cloudflare Pages project keeps
the internal `eliza-computer` slug, so `https://eliza-computer.pages.dev`
remains a diagnostic fallback rather than the advertised authority.

## Installer trust and lifecycle

The site checksum detects transport corruption; it is not the trust root. The
installer independently asks `api.github.com` whether the archive revision is
the exact current `develop` head, a `develop` ancestor whose complete canonical
skill tree is still byte-identical to current `develop`, or the exact head of an
open, non-draft, same-repository pull request into `develop` carrying the maintainer-controlled
`eliza-army-release-candidate` label. The approval label event must occur after
the timeline's exact current-head commit event and every later head mutation,
and GitHub's compare API must prove the candidate is ahead of current
`develop` with nothing behind. It recursively obtains the complete canonical
skill file list from GitHub's Contents API at that SHA, rejects
non-regular entries and more than 32 files, downloads every file from
`raw.githubusercontent.com` at the same SHA, verifies each Git blob identity,
and requires the archive, provenance manifest, and GitHub bytes to match
exactly. A working-tree archive is never installable.

Repository maintainers create and apply the exact
`eliza-army-release-candidate` label only after reviewing the PR's current
head. Contributors cannot self-declare release authority in text, comments, or
similarly named labels. Remove the label when a candidate is withdrawn; a new
push invalidates the prior timeline-bound approval immediately, even before the
metadata workflow removes the retained label. Reapply it only after a
maintainer reviews the new exact head and the branch is fully synchronized.

Installs are immutable directories under the selected skills root. The visible
`contribute-to-eliza` path is an atomically replaced relative symlink, guarded
by a process-bound kernel concurrency lock that is automatically released on
normal or interrupted process exit. Each version carries a canonical local authorization
receipt recording whether it entered as `develop` or a labeled PR head.
Re-running at the same verified revision is a no-op. An update proceeds only
when GitHub's compare API proves the old revision is an ancestor of the new
authorized revision; a recorded candidate may also advance to the exact merged
`develop` result after GitHub verifies the original PR identity, even when the
maintainer label has since been removed or the PR used a squash merge. The
prior version remains available. A rollback requires setting
`ELIZA_ARMY_SKILL_OPERATION=rollback` and
`ELIZA_ARMY_SKILL_REVISION=<retained-40-character-revision>` before running the
same generated command; both active and retained trees are reverified against
GitHub before the atomic switch. Unset both variables after the rollback.
Modified, broken, divergent, downgraded, or unmanaged installs fail closed.

`eliza.army` is registered through Cloudflare Registrar in the same account as
the Pages project. Production launch requires all of these independent checks:

1. The registration is active, contact data is complete, and automatic renewal
   has the intended setting.
2. The exact tested bundle is deployed to the `eliza-computer` Pages project.
3. `eliza.army` is attached as the Pages custom domain and its Cloudflare DNS
   record is active.
4. The apex serves the exact build over a valid TLS certificate with the
   expected redirects, security headers, skill archive, checksum, and
   leaderboard snapshot.
