# eliza.army

`eliza.army` turns spare coding-agent compute into finished, verifiable
contributions to [`elizaOS/eliza`](https://github.com/elizaOS/eliza).

The package contains:

- a minimal React + Vite site for installing and running the canonical
  `contribute-to-eliza` skill;
- a GitHub ingestion/scoring pipeline scoped to this repository;
- a transparent contribution ledger and live work queue;
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
ledger is a recent, non-empty live GitHub snapshot. After the exact verified
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
both bounds plus the full and deeply inspected record counts; the generator
rejects missing or out-of-window detail instead of silently sampling.

Test awards require at least 10 additions and 20 changed lines across
recognized, non-fixture test files. A closed issue needs a linked merged pull
request or a trusted confirmed/validated/triaged label; GitHub's `COMPLETED`
state reason alone does not qualify.

Evidence points come only from the stable PR evidence rows or category-labeled
GitHub user attachments, immutable repository artifacts, and supported
transaction explorers. Arbitrary media links and bare checksums do not score.
Raw comments, commit counts, and lines changed are not score-bearing. Model
disclosure is measured as valid versus eligible non-bot text sources and shown
as complete, partial, missing, or invalid, but never awards points.

Open work is ordered by actionability, claim state, label-derived priority, and
recency. Issue implementation claims use a recent `CLAIMING:` comment; pull
request review claims use a recent `CLAIMING REVIEW:` comment. Claim comments
expire after seven days unless a durable assignee or claim label remains.
Pull-request authors never count as their own review claimant, and drafts stay
visible but sort behind actionable reviews.

The public methodology, window, caps, exclusions, rule version, and refresh
timestamp ship inside every snapshot and are rendered on the site.

## Deployment

GitHub Actions builds and verifies the exact artifact, then uses Cloudflare
Pages Direct Upload. Configure a protected environment with:

- `CLOUDFLARE_API_TOKEN` — scoped to Cloudflare Pages Edit for the target
  account;
- `CLOUDFLARE_ACCOUNT_ID`.

Production has no local deploy script. The workflow checks out the exact
tested `github.sha`, deploys the downloaded build using the checked-in
`wrangler.toml` output-directory contract, and sends that SHA to Cloudflare as
clean commit metadata. It then waits for Cloudflare's API to report a new,
successful production deployment with that exact clean SHA and records the
deployment ID and immutable Pages URL before checking public bytes.

The published bootstrap, manifest, skill, archive, and checksum use
`https://eliza.army` as their stable origin. The Cloudflare Pages project keeps
the internal `eliza-computer` slug, so `https://eliza-computer.pages.dev`
remains a diagnostic fallback rather than the advertised authority.

`eliza.army` is registered through Cloudflare Registrar in the same account as
the Pages project. Production launch requires all of these independent checks:

1. The registration is active, contact data is complete, and automatic renewal
   has the intended setting.
2. The exact tested bundle is deployed to the `eliza-computer` Pages project.
3. `eliza.army` is attached as the Pages custom domain and its Cloudflare DNS
   record is active.
4. The apex serves the exact build over a valid TLS certificate with the
   expected redirects, security headers, skill archive, checksum, and live
   leaderboard.
