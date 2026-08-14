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
| `VITE_TELEGRAM_BOT_USERNAME` | Optional Telegram bot username override (default `Elizav2_Bot`) |
| `VITE_TELEGRAM_BOT_ID` | Optional numeric Telegram bot ID override (default `7684336618`) |
| `VITE_DISCORD_CLIENT_ID` | Optional Discord Application ID override (default `1468649258654630063`) |
| `WHATSAPP_PUBLIC_ENABLED` | Deployment switch that must be true before the public WhatsApp CTA is built |
| `VITE_WHATSAPP_PHONE_NUMBER` | Production WhatsApp Business sender in E.164 format; omitted by default |

OAuth provider callback configuration belongs to the unified Cloud auth routes
and API deployment. Do not register a callback against this source package or
its optional test-harness port.

### WhatsApp production activation

The homepage is provider-neutral: it opens the admitted Business sender with
`wa.me`, while the gateway can receive and reply through either the direct Meta
Cloud API adapter or the Twilio adapter. Leave `WHATSAPP_PUBLIC_ENABLED=false`
until one provider owns a registered production sender and a real handset
round trip has succeeded.

1. Register a production sender with Meta or Twilio and configure the matching
   gateway credentials and webhook.
2. Set the target GitHub environment's `VITE_WHATSAPP_PHONE_NUMBER` variable to
   that exact sender.
3. Set `WHATSAPP_PUBLIC_ENABLED=true` in the same environment and deploy the
   consolidated app.
4. Verify the rendered `wa.me` target, receive a handset message through the
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
