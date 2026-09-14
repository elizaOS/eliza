# elizaresearch.ai

Static company site for Eliza Research: the main landing page
(`index.html`) and the senior independence study page
(`study/index.html`, served at `/study/`). No build step, no framework;
one small Worker script (`study-contact.mjs`) serves the assets and
handles the study page's contact form.

- Preview locally: `bun run preview` (serves on :4173; the contact form
  needs the Worker, so use `bunx wrangler dev` to exercise it locally)
- Deploy: `bun run deploy` — Cloudflare Workers static assets (worker
  `elizaresearch`) with `elizaresearch.ai` as an auto-managed custom domain.
  `.assetsignore` keeps source, config, and docs out of the served assets.
- Test: `bun run test` — landing-page particle lifecycle, mail-security
  evaluation, and the contact endpoint's request contract.

- Audit domain mail security: `bun run mail:security` — checks live MX, SPF,
  DKIM, and DMARC for `elizaresearch.ai`. The runbook for the Workspace admin
  controls that DNS cannot prove is in [`MAIL-SECURITY.md`](./MAIL-SECURITY.md).

Products described: **Eliza** (personal superagent + open source elizaOS) and
**slop.cash** (swarm contribution platform).

## Study contact form

`POST /api/study-contact` (handled by `study-contact.mjs`) emails form
submissions to the study inbox via the [Resend](https://resend.com) API.
The recipient address deliberately appears nowhere in this repository or
in any page — it is deploy-time configuration — so it cannot be scraped.
Bots are filtered by an invisible honeypot field; a filled honeypot gets
a fake success and nothing is delivered.

Required secrets (set once per environment):

```
bunx wrangler secret put RESEND_API_KEY   # from the Resend dashboard
bunx wrangler secret put CONTACT_TO       # inbox that receives submissions
```

Optional: `CONTACT_FROM` sets the sender identity (default
`Eliza Research Website <onboarding@resend.dev>`, which Resend allows only
for delivery to the account owner's address — verify `elizaresearch.ai`
in Resend and set e.g. `Eliza Research <study@elizaresearch.ai>` for
production). Note: Resend domain verification uses its own DKIM records
and does not touch the Google Workspace MX posture that
`bun run mail:security` audits — re-run the audit after adding records.

Until the secrets are configured the endpoint refuses submissions with a
503 and the page shows the phone number as a fallback, so the form never
pretends to deliver. Further hardening (for example Cloudflare Turnstile)
can be added in the Worker if honeypot filtering proves insufficient.
