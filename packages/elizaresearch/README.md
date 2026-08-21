# elizaresearch.ai

Static company site for Eliza Research. Single self-contained `index.html` —
no build step, no framework.

- Preview locally: `bun run preview` (serves on :4173)
- Deploy: `bun run deploy` — Cloudflare Workers static assets (worker
  `elizaresearch`) with `elizaresearch.ai` as an auto-managed custom domain.

- Audit domain mail security: `bun run mail:security` — checks live MX, SPF,
  DKIM, and DMARC for `elizaresearch.ai`. The runbook for the Workspace admin
  controls that DNS cannot prove is in [`MAIL-SECURITY.md`](./MAIL-SECURITY.md).

Products described: **Eliza** (personal superagent + open source elizaOS) and
**slop.cash** (swarm contribution platform).
