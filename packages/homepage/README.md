This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

### 1. Environment Setup

Copy the example environment file and fill in the values:

```bash
cp .env.example .env.local
```

**Key variables:**

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_ELIZACLOUD_API_URL` | Eliza Cloud backend URL (defaults to `https://www.elizacloud.ai`) |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | Telegram bot username from @BotFather |
| `NEXT_PUBLIC_TELEGRAM_BOT_ID` | Numeric Telegram bot ID (first part of bot token before `:`) |
| `NEXT_PUBLIC_DISCORD_CLIENT_ID` | Discord Application ID (from Developer Portal > General Information) |
| `NEXT_PUBLIC_WHATSAPP_PHONE_NUMBER` | WhatsApp Business phone number in E.164 format (e.g. `+14245074963`) |

See [.env.example](.env.example) for the full list.

### Discord OAuth2 Setup

To enable Discord login locally, you must register your redirect URI in the Discord Developer Portal:

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application (matching `NEXT_PUBLIC_DISCORD_CLIENT_ID`)
3. Navigate to **OAuth2** in the left sidebar
4. Under **Redirects**, add the following URI:
   ```
   http://localhost:4444/get-started
   ```
5. Click **Save Changes**

> The redirect URI must exactly match the origin where the app is running. If you deploy to a staging or production domain, add that redirect URI as well (e.g., `https://your-domain.com/get-started`).

### WhatsApp Business Cloud API Setup

To enable WhatsApp integration, you need a Meta Business account and a WhatsApp Business App:

1. Go to [Meta for Developers](https://developers.facebook.com/) and create or select your app
2. Add the **WhatsApp** product to your app
3. In **WhatsApp → API Setup**, note your **Phone Number ID** and generate a temporary access token
4. For production, create a **System User** in [Meta Business Settings](https://business.facebook.com/settings/system-users) and generate a permanent access token with the `whatsapp_business_messaging` permission
5. In **App Dashboard → Settings → Basic**, note the **App Secret** (used for webhook signature verification)
6. Configure the webhook URL in **WhatsApp → Configuration**:
   - **Callback URL**: `https://your-domain.com/api/eliza-app/webhook/whatsapp`
   - **Verify Token**: A random secret string (generate with `openssl rand -hex 32`), must match `ELIZA_APP_WHATSAPP_VERIFY_TOKEN`
   - **Webhook Fields**: Subscribe to `messages`
7. Set the following environment variables in `eliza-cloud-v2`:
   ```env
   ELIZA_APP_WHATSAPP_ACCESS_TOKEN=     # Permanent token from System User
   ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID=  # From WhatsApp → API Setup
   ELIZA_APP_WHATSAPP_APP_SECRET=       # From Settings → Basic
   ELIZA_APP_WHATSAPP_VERIFY_TOKEN=     # Generate: openssl rand -hex 32
   ELIZA_APP_WHATSAPP_PHONE_NUMBER=     # E.164 format (e.g. +14245074963)
   ```

> For local development, use a tunneling service like [ngrok](https://ngrok.com/) to expose your local server to Meta's webhooks:
> ```bash
> ngrok http 3000
> ```
> Then use the generated URL as your callback (e.g., `https://abc123.ngrok-free.app/api/eliza-app/webhook/whatsapp`). Note: the webhook endpoint is on eliza-cloud-v2 (port 3000), not eliza-app (port 4444).

### 2. Run the Development Server

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
