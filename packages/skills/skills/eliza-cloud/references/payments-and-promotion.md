# Payments And Promotion APIs

Use this reference when an app needs to charge money, define how much the
creator earns, buy traffic material, or ask the parent Eliza runtime to perform
paid Cloud actions.

## Choose The Right Money Surface

Eliza Cloud has multiple payment surfaces. Do not collapse them into one.

- **Inference markup** earns on app-scoped chat/inference usage.
- **Purchase share** earns when users buy app credits for an app.
- **App charge requests** create reusable Stripe/OxaPay links for exact dollar
  amounts. The payer receives app credits and creator earnings flow through the
  app-credit earnings ledger.
- **x402 payment requests** create wallet-native payment requests for exact
  dollar amounts, optionally tied to an app. They are best for arbitrary agent
  actions, gated downloads, one-off paid approvals, or machine-to-machine
  payment flows.
- **Org credit checkout** tops up a user's organization credits. It is not
  creator pricing.

All paid or externally visible operations should go through the parent
confirmation flow when a worker is operating through agent orchestration.

## Create An App

`POST /api/v1/apps`

```json
{
  "name": "my-app",
  "description": "Short public description",
  "app_url": "https://placeholder.invalid",
  "website_url": "https://example.com",
  "contact_email": "founder@example.com",
  "allowed_origins": ["https://example.com"],
  "logo_url": "https://example.com/logo.png",
  "skipGitHubRepo": true
}
```

Response includes the app record and a new app API key:

```json
{
  "success": true,
  "app": { "id": "app_uuid" },
  "apiKey": "sk_..."
}
```

Use `app.id` as the browser-facing `appId`. Keep the returned API key on server
routes only.

## Set How Much The Creator Makes

`PUT /api/v1/apps/{id}/monetization`

```json
{
  "monetizationEnabled": true,
  "inferenceMarkupPercentage": 100,
  "purchaseSharePercentage": 10
}
```

Meaning:

- `inferenceMarkupPercentage` is added to the base inference cost. `100` means
  the creator earns an amount equal to the base inference cost; the caller pays
  base plus markup from their organization Cloud credits.
- `purchaseSharePercentage` is the creator's percentage of app-credit purchases
  after the configured platform offset. `10` means 10%.
- The accepted ranges in this checkout are `0..1000` for inference markup and
  `0..100` for purchase share.

This endpoint does not set a fixed subscription price or one-off charge. Use an
app charge request or x402 request when the agent needs to ask for a specific
dollar amount.

## Reusable App Charge Requests

Use this when the app or agent wants to ask a user to pay a precise amount and
receive app credits through Stripe or OxaPay.

`POST /api/v1/apps/{id}/charges`

SDK wrapper: `cloud.routes.postApiV1AppsByIdCharges({ pathParams: { id }, json })`.

```json
{
  "amount": 25,
  "description": "Unlock the premium research run",
  "providers": ["stripe", "oxapay"],
  "success_url": "https://myapp.com/payment/success",
  "cancel_url": "https://myapp.com/payment/cancel",
  "callback_url": "https://myapp.com/api/payment-callback",
  "callback_secret": "replace-with-strong-shared-secret",
  "lifetime_seconds": 604800,
  "metadata": { "feature": "premium_research" }
}
```

Limits:

- `amount` is USD, minimum `1`, maximum `10000`.
- `providers` may include `stripe`, `oxapay`, or both.
- Lifetime is `60` seconds to `30` days; the default service behavior is a
  seven-day reusable request when no lifetime is supplied.

The response includes a `charge` with a platform payment URL. To create a
provider checkout session programmatically:

`POST /api/v1/apps/{id}/charges/{chargeId}/checkout`

SDK wrapper:
`cloud.routes.postApiV1AppsByIdChargesByChargeIdCheckout({ pathParams: { id, chargeId }, json })`.

```json
{
  "provider": "stripe",
  "success_url": "https://myapp.com/payment/success",
  "cancel_url": "https://myapp.com/payment/cancel"
}
```

For OxaPay, use `"provider": "oxapay"` and optionally pass `payCurrency` and
`network`.

## x402 Payment Requests

Use this when the app or agent needs an arbitrary payment request that is not
necessarily an app-credit top-up.

`POST /api/v1/x402/requests`

SDK wrapper: `cloud.routes.postApiV1X402Requests({ json })`.

```json
{
  "amountUsd": 10,
  "network": "base",
  "description": "Run one private competitor analysis",
  "appId": "app_uuid",
  "callbackUrl": "https://myapp.com/api/x402-callback",
  "expiresInSeconds": 3600,
  "metadata": { "jobId": "analysis_123" }
}
```

The create response returns:

- `paymentRequest` for durable status tracking
- `paymentRequired` metadata
- `paymentRequiredHeader`, also exposed through `PAYMENT-REQUIRED` and
  `Payment-Required` headers

Settlement is public:

- `GET /api/v1/x402/requests/{id}` checks status.
- `POST /api/v1/x402/requests/{id}/settle` settles with an `X-PAYMENT`,
  `x-payment`, or `PAYMENT-SIGNATURE` header, or a JSON `paymentPayload`.

Supported network values come from `x402-payment-requests.ts`; current examples
include `base`, `base-sepolia`, `ethereum`, `sepolia`, `bsc`, `bsc-testnet`,
`solana`, `solana-mainnet`, `solana-devnet`, and `solana-testnet`.

The service adds platform/service fees to the amount charged. Treat
`amountUsd` as the creator-requested amount and show the returned payment
metadata to the payer instead of hand-calculating totals in the worker.

## Direct Credit Checkouts

Direct credit checkout is useful for account top-ups, not exact creator charge
logic.

- `POST /api/v1/app-credits/checkout` buys app credits:

  ```json
  { "app_id": "app_uuid", "amount": 25, "success_url": "...", "cancel_url": "..." }
  ```

- `POST /api/v1/credits/checkout` buys organization credits:

  ```json
  { "credits": 25, "success_url": "...", "cancel_url": "..." }
  ```

Use app charge requests when the agent needs a durable app-specific pay link
with metadata and callbacks.

## Promotion Assets

Use these app-specific routes after the app is registered and has enough
credits for generation.

`GET /api/v1/apps/{id}/promote/assets` returns recommended sizes and cost
estimates.

`POST /api/v1/apps/{id}/promote/assets`

SDK wrapper:
`cloud.routes.postApiV1AppsByIdPromoteAssets({ pathParams: { id }, json })`.

```json
{
  "includeCopy": true,
  "includeAdBanners": true,
  "targetAudience": "AI builders who want hosted agent apps",
  "customPrompt": "Sharp launch visuals for a cloud agent marketplace app"
}
```

This generates social cards, optional banners, and optional ad copy. Successful
assets are saved back to the app record.

`POST /api/v1/apps/{id}/promote/preview`

```json
{ "platforms": ["twitter", "discord", "telegram"], "count": 3 }
```

`POST /api/v1/apps/{id}/promote` can execute configured promotion channels:
social posting, SEO updates, advertising, Twitter automation, Telegram
automation, and Discord automation. Advertising requires an ad account id and
budget; do not start paid ads without explicit confirmation.

## Advertising And Paid Acquisition

Use advertising APIs only after the app has a real destination URL, generated or
uploaded creative assets, an approved ad account, and explicit budget approval.
Campaign creation and campaign start are paid operations.

### Connect or list ad accounts

`GET /api/v1/advertising/accounts?platform=meta|google|tiktok`

`POST /api/v1/advertising/accounts/discover`

```json
{
  "platform": "meta",
  "accessToken": "<temporary-provider-token>"
}
```

Use discover before connect when the platform token can access more than one
ad account. The response returns provider account ids/names; pass the selected
id into `externalAccountId` on connect.

`POST /api/v1/advertising/accounts`

```json
{
  "platform": "meta",
  "accessToken": "provider_oauth_access_token",
  "refreshToken": "provider_refresh_token_if_any",
  "externalAccountId": "provider_ad_account_id",
  "accountName": "Main Growth Account"
}
```

Current route code accepts provider tokens directly. Production agent flows
should use an OAuth start/callback/account-picker layer so workers never handle
raw platform tokens.

Account selection matters. If `externalAccountId` is omitted, provider
validation may pick the first accessible account or a user identity that is not
usable as an ad account. Use a selected provider ad account id for real spend.

### Create a campaign

`POST /api/v1/advertising/campaigns`

```json
{
  "adAccountId": "ad_account_uuid",
  "name": "Launch - AI builders",
  "objective": "traffic",
  "budgetType": "daily",
  "budgetAmount": 50,
  "budgetCurrency": "USD",
  "targeting": {
    "locations": ["US"],
    "ageMin": 18,
    "ageMax": 55,
    "interests": ["AI tools", "software development"]
  },
  "appId": "app_uuid"
}
```

`GET /api/v1/advertising/campaigns?appId=<appId>` lists campaigns.

### Add creative

`POST /api/v1/advertising/campaigns/{id}/creatives`

```json
{
  "name": "Launch image creative",
  "type": "image",
  "headline": "Build AI apps that earn",
  "primaryText": "Launch on Eliza Cloud with auth, billing, payments, and promotion built in.",
  "callToAction": "learn_more",
  "destinationUrl": "https://myapp.example",
  "pageId": "facebook_page_id_when_using_meta",
  "instagramActorId": "optional_instagram_actor_id_when_using_meta",
  "tiktokIdentityId": "optional_tiktok_identity_id",
  "tiktokIdentityType": "CUSTOMIZED_USER",
  "media": [
    {
      "id": "generated_asset_uuid",
      "source": "generation",
      "url": "https://cdn.example/asset.png",
      "providerAssetId": "provider_native_asset_id_when_required",
      "type": "image",
      "order": 0
    }
  ]
}
```

Provider caveats:

- Meta link ads require `pageId` or a server-side `META_DEFAULT_PAGE_ID`.
- TikTok image/video ads require `media[].providerAssetId` from TikTok's upload
  API; a public Cloud/R2 URL is not enough for native delivery.
- Google currently creates responsive search ads from text fields. Generated
  image/video assets need a future Google asset-upload path before image/video
  campaign creative can be automated.
- Campaigns and creatives should be created paused/draft first. Starting
  delivery is a separate confirmed action.

### Start, pause, and measure

- `POST /api/v1/advertising/campaigns/{id}/start` starts paid delivery.
- `POST /api/v1/advertising/campaigns/{id}/pause` pauses delivery.
- `GET /api/v1/advertising/campaigns/{id}/analytics` returns campaign metrics.

Do not start delivery without a confirmed budget, destination URL, ad-account
ownership, platform policy acceptance, and a user-approved audience/creative.
Workers should call the parent via `parent-agent` cloud commands for these
operations so the parent can confirm spend and account context.

## General Media Generation

Cloud exposes general media endpoints that can be used to create promotional
material for an app.

### Image

`POST /api/v1/generate-image`

```json
{
  "prompt": "Square launch image for a playful AI finance assistant app",
  "model": "google/gemini-2.5-flash-image",
  "numImages": 2,
  "aspectRatio": "1:1",
  "stylePreset": "editorial"
}
```

The response includes generated image data and stored public URLs.

### Video

`POST /api/v1/generate-video`

```json
{
  "prompt": "Ten second product teaser for an AI app builder dashboard",
  "model": "fal-ai/veo3",
  "durationSeconds": 10,
  "resolution": "720p",
  "audio": true
}
```

The response includes a video URL and billing metadata when the provider is
configured.

### Voiceover / TTS

`POST /api/v1/voice/tts`

```json
{
  "text": "Build, launch, and monetize your AI app on Eliza Cloud.",
  "modelId": "eleven_flash_v2_5",
  "outputFormat": "mp3_44100_128"
}
```

The response is streamed audio. Use `eleven_flash_v2_5` for the lowest
latency default, and prefer streaming/websocket paths for live agents. For
telephony or realtime playback, request a PCM/u-law output format that matches
the caller pipeline instead of generating MP3 and transcoding it later.

### Music

`POST /api/v1/generate-music`

```json
{
  "prompt": "City pop launch track for an upbeat AI app builder",
  "model": "fal-ai/minimax-music/v2.6",
  "lyrics": "[Verse]\nBuild it in the morning\n[Chorus]\nLaunch it by the night",
  "instrumental": false,
  "audio": {
    "format": "mp3",
    "sampleRate": "44100",
    "bitrate": "256000"
  }
}
```

Default provider is Fal MiniMax Music 2.6. `elevenlabs/music_v1` uses the
ElevenLabs music API and stores the generated audio in Cloud R2 before
returning a public URL. `suno/default` is only a Suno-compatible provider: set
`SUNO_API_KEY`, preferably `SUNO_BASE_URL`, and override pricing before using
it for production. Suno first-party public API availability is not guaranteed.

For faster voice agents, the active Cloud TTS route is ElevenLabs-only. Prefer
`eleven_flash_v2_5`, streaming responses, and PCM/u-law formats. Future
provider adapters should consider Cartesia WebSocket TTS, Deepgram Aura,
PlayHT streaming, and OpenAI Realtime/TTS after pricing and billing sources are
added.

## Worker / Parent-Agent Pattern

When a spawned worker needs a paid Cloud action or account-specific state, it
should ask the parent rather than using hidden credentials:

```text
USE_SKILL parent-agent {"request":"Create a $25 Stripe/OxaPay charge request for app <appId> titled 'Unlock premium research', confirm with the user first if needed, and return the payment URL."}
```

When the worker knows the exact Cloud API call, prefer deterministic commands:

```text
USE_SKILL parent-agent {"mode":"list-cloud-commands","query":"charges"}
USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.charges.create","params":{"id":"<appId>","body":{"amount":25,"description":"Unlock premium research","providers":["stripe","oxapay"]}}}
USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.charges.create","confirmed":true,"params":{"id":"<appId>","body":{"amount":25,"description":"Unlock premium research","providers":["stripe","oxapay"]}}}
```

The unconfirmed paid command should return `confirmation_required`. Only rerun
with `confirmed:true` after the parent/user has approved the exact spend,
recipient, and action.

For read-only planning, the worker may inspect local route code. For actual
paid operations, private account data, domains, ad spend, or external posting,
the parent should confirm and relay the result.
