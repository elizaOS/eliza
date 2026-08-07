# eliza.app waitlist (production surface)

This directory is the canonical source for what `Deploy Homepage` publishes to
the `eliza-app-home` Cloudflare Pages project (eliza.app / www.eliza.app).

- `site/` — static waitlist page (deployed as the Pages artifact)
- `functions/api/waitlist.js` — Pages Function backing `POST /api/waitlist`
  (validation, hashed KV keys, dedupe, IP rate limit, origin check, honeypot).
  Bound to KV namespace `eliza-app-waitlist-production`
  (`c776f8d792214e80ad0d3dad9da6f01c`) on the Pages project.
- `tests/` — unit tests for the function plus a local static server/capture
  helper.

Deployed 2026-08-05 as deployment `d562e1eb-9c39-4644-9b8b-4f53fea90257`,
replacing the stale phone/channel demo (rollback anchor
`088b3bd5-b3fc-414e-900c-95e04875c33a`). The full Vite app in
`packages/homepage` is retained for the relaunch; putting it back in
production requires reverting `.github/workflows/deploy-homepage.yml`
deliberately.

Wrangler picks up `functions/` relative to the deploy working directory, so
the workflow runs `wrangler pages deploy site` from this directory, which
uploads the static artifact and the function together.
