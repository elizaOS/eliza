# elizaresearch.ai

Static company site for Eliza Research. Self-contained HTML pages — no build
step, no framework. Besides the landing page, it serves the store-facing
endpoints that app-store listings reference (Workers assets map
`privacy.html` → `/privacy`, etc.):

- `/privacy` — privacy policy, including the account/data-deletion path
- `/terms` — terms of service
- `/support` — support contact and response path

These URLs are load-bearing for store review (Apple, Google Play, Microsoft,
Samsung, Amazon, Solana Mobile, Snap, Flathub, browser-extension stores) and
must stay public and unauthenticated. `store-endpoints.test.mjs` pins the
pages and the repo store-listing metadata that references them.

- Preview locally: `bun run preview` (serves on :4173)
- Deploy: `bun run deploy` — Cloudflare Workers static assets (worker
  `elizaresearch`) with `elizaresearch.ai` as an auto-managed custom domain.

Products described: **Eliza** (personal superagent + open source elizaOS) and
**slop.cash** (swarm contribution platform).
