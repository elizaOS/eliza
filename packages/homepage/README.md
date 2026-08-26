# Eliza homepage source

Public landing and download components embedded into `packages/app`. This
package is not a standalone product application: it has no normal dev, build,
preview, or Pages deployment command. The unified app artifact serves both
`eliza.app` and `cloud.eliza.app`.

## Getting Started

### 1. Environment setup

Configure these values for the `packages/app` build. Copying the local example
is only useful when running this package's isolated visual test harness:

```bash
cp .env.example .env.local
```

**Key variables** (Vite uses the `VITE_` prefix; only `VITE_*` vars are exposed to the browser):

| Variable | Description |
|---|---|
| `VITE_ELIZACLOUD_API_URL` | Eliza Cloud backend URL (defaults to `https://api.eliza.app`) |
| `VITE_TELEGRAM_BOT_USERNAME` | Local/direct-build Telegram username fallback (default `ElizaIsNotABot`); with the ID, the repository-scoped staging release authority |
| `VITE_TELEGRAM_BOT_ID` | Local/direct-build numeric Telegram ID fallback (default `8931353359`); with the username, the repository-scoped staging release authority |
| `VITE_DISCORD_CLIENT_ID` | Optional Discord Application ID override (default `1468649258654630063`) |
| `WHATSAPP_PUBLIC_ENABLED` | Deployment switch that must be true before the public WhatsApp CTA is built |
| `VITE_WHATSAPP_PHONE_NUMBER` | Admitted Blooio WhatsApp sender in E.164 format; set to the shared `+18087881821` number |

OAuth provider callback configuration belongs to the unified Cloud auth routes
and API deployment. Do not register a callback against this source package or
its optional test-harness port.

Protected staging releases require the complete repository-scoped pair before
migrations or API deployment, and neither component may match the canonical
production identity. Protected production releases ignore that pair and derive
their exact identity from `src/lib/contact.ts` at the checked-out release SHA.
Same-named GitHub Environment variables are not an override mechanism because
GitHub resolves the repository `vars` context before Environment variables
arrive on the runner. Pull requests have static build checks but no Pages
preview release path.

### WhatsApp production activation

The homepage opens the admitted Blooio WhatsApp sender with `wa.me`. A normal
Blooio channel is not automatically a WhatsApp channel: it resolves outbound
messages to iMessage, RCS, or SMS. Leave `WHATSAPP_PUBLIC_ENABLED=false` until
Blooio exposes a separate active WhatsApp-capable channel for the shared number
and a real handset round trip has succeeded.

1. Ask Blooio to provision and expose an active WhatsApp channel for
   `+18087881821`; verify it through `GET /v4/channels`.
2. Confirm the gateway receives `message.received` with that exact channel id
   and replies through the v4 channel-aware message endpoint.
3. Set the repository `VITE_WHATSAPP_PHONE_NUMBER` variable to
   `+18087881821`.
4. Set `WHATSAPP_PUBLIC_ENABLED=true` and deploy the
   consolidated app.
5. Verify the rendered `wa.me` target, receive a handset message through the
   signed webhook, and confirm the agent reply reaches the same handset.

The release workflow rejects the Twilio shared sandbox (`+14155238886`), the
current Meta developer test sender (`+15551649988`), and the former unverified
homepage number (`+14159611510`).

### 2. Run the unified development server

```bash
bun install
bun run --cwd packages/app dev
```

`packages/app` aliases the embedded entries in this directory, so changes here
hot-reload through the same frontend used by the product.

### 3. Build and validate

```bash
bun run --cwd packages/homepage typecheck
bun run --cwd packages/homepage test
bun run --cwd packages/app build:web
```

### Review and edit the homepage scenarios

The optional source harness exposes a development-only script board at
`/demo-scenarios`, with anchors for `#household`, `#co-parenting`, `#friends`,
`#trip`, and `#community`. In the current local review environment, for
example, the Trip room is available at
`http://127.0.0.1:24446/demo-scenarios#trip`.

The board and the animated desktop/mobile homepage both import
`src/lib/landing-demo.ts`; never duplicate scenario copy in the review page.
Recap embeds also use the shared `src/components/landing-demo-card.tsx`
renderer and the production card classes, so UI changes appear one-to-one in
the board and phone.
Edit that shared file, then run:

```bash
bun run --cwd packages/homepage test
bun run --cwd packages/homepage test:e2e -- tests/e2e/demo-scenarios.spec.ts --project=chromium
```

The route is intentionally excluded from production builds. It is a team
editing and review tool, not a public `eliza.app` page.

## Deploy

`packages/app` imports the approved embedded surfaces and syncs their public
assets. `.github/workflows/cloud-cf-deploy.yml` builds and deploys that single
artifact to the `eliza-app` Cloudflare Pages project. The optional Playwright
harness in this directory exists only to preserve focused source visual tests;
it cannot build or deploy a product artifact.

### Canonical domains

The domain map lives in `@elizaos/shared/brand` as `EXTERNAL_URLS`:

| Surface | Origin |
|---|---|
| Marketing homepage | `https://eliza.app` |
| Hosted Eliza web app and cloud console | `https://cloud.eliza.app` |
| elizaOS downloads | `https://os.eliza.app` |
| Docs | `https://docs.elizaos.ai` |

`eliza.app` and `cloud.eliza.app` are custom domains on `eliza-app`.
`www.eliza.app` redirects to `eliza.app`; all `elizacloud.ai` product hosts
redirect to their canonical `eliza.app` peers.
`os.eliza.app` is a custom domain on the existing `elizaos-homepage` Pages
project. `elizaos.ai` remains unchanged until its later redirect.
