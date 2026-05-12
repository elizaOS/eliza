Static React + Vite SPA for the Eliza homepage. Calls the Eliza Cloud API directly — no Next.js, no proxy.

## Getting Started

### 1. Environment Setup

Copy the example environment file and fill in the values:

```bash
cp .env.example .env.local
```

**Key variables** (Vite uses the `VITE_` prefix; only `VITE_*` vars are exposed to the browser):

| Variable | Description |
|---|---|
| `VITE_ELIZACLOUD_API_URL` | Eliza Cloud backend URL (defaults to `https://www.elizacloud.ai`) |
| `VITE_TELEGRAM_BOT_USERNAME` | Telegram bot username from @BotFather |
| `VITE_TELEGRAM_BOT_ID` | Numeric Telegram bot ID (first part of bot token before `:`) |
| `VITE_DISCORD_CLIENT_ID` | Discord Application ID (from Developer Portal → General Information) |
| `VITE_WHATSAPP_PHONE_NUMBER` | WhatsApp Business phone number in E.164 format (e.g. `+14245074963`) |

### Discord OAuth2 Setup

Register your redirect URI in the Discord Developer Portal:

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application (matching `VITE_DISCORD_CLIENT_ID`)
3. Navigate to **OAuth2** → **Redirects** and add:
   ```
   http://localhost:4444/get-started
   ```
   Add a corresponding entry for each deployed origin (e.g. `https://eliza.app/get-started`).

### 2. Run the Development Server

```bash
bun install
bun run dev
```

Open [http://localhost:4444](http://localhost:4444) — Vite hot-reloads on save.

### 3. Build

```bash
bun run build      # outputs static assets to ./dist
bun run preview    # serves ./dist locally on :4444
```

## Deploy to Cloudflare Pages

Cloudflare Pages serves the static `dist/` output. SPA fallback is configured via `public/_redirects` (`/* /index.html 200`); long-cache headers are configured via `public/_headers`.

### Option A — Connect the GitHub repo to Cloudflare Pages

1. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages → Connect to Git**.
2. Select this repository.
3. Set build settings:
   - **Build command:** `bun run --filter eliza-app build` (or run `bun run build` from `eliza/packages/homepage`)
   - **Build output directory:** `eliza/packages/homepage/dist`
   - **Root directory:** `eliza/packages/homepage`
4. Set the `VITE_*` environment variables under **Settings → Environment Variables** (separately for Production and Preview).
5. Save and deploy.

### Option B — Wrangler CLI (local)

`wrangler` is included as a dev dependency. Authenticate once, then deploy:

```bash
bunx wrangler login

# production deploy (pushes dist/ to the eliza-homepage Pages project)
bun run deploy

# preview deploy (uses --branch=preview)
bun run deploy:preview
```

The Pages project name (`eliza-homepage`) is configured in `wrangler.toml` and in the npm scripts. Change it there if your Cloudflare project is named differently.

### Custom domain

After the first deploy, attach a custom domain in the Pages project's **Custom domains** tab. Cloudflare provisions the certificate automatically.
