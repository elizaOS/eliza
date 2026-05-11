# Advertising API Setup

This document covers what Eliza Cloud needs before agents can create, attach,
launch, pause, and measure paid ad campaigns for Cloud apps.

## Current Eliza Cloud Surface

The Cloud API already has the core advertising resources:

- `GET /api/v1/advertising/accounts`
- `POST /api/v1/advertising/accounts`
- `POST /api/v1/advertising/accounts/discover`
- `POST /api/v1/advertising/accounts/{id}/media`
- `GET /api/v1/advertising/campaigns`
- `POST /api/v1/advertising/campaigns`
- `GET /api/v1/advertising/campaigns/{id}`
- `PATCH /api/v1/advertising/campaigns/{id}`
- `DELETE /api/v1/advertising/campaigns/{id}`
- `GET /api/v1/advertising/campaigns/{id}/creatives`
- `POST /api/v1/advertising/campaigns/{id}/creatives`
- `GET /api/v1/advertising/creatives/{id}`
- `PATCH /api/v1/advertising/creatives/{id}`
- `DELETE /api/v1/advertising/creatives/{id}`
- `POST /api/v1/advertising/campaigns/{id}/start`
- `POST /api/v1/advertising/campaigns/{id}/pause`
- `GET /api/v1/advertising/campaigns/{id}/analytics`

Supported platform values are `meta`, `google`, and `tiktok`.

The current account connection route accepts raw provider access tokens. Use
the discover route first when a provider token can see more than one ad account:

```json
{
  "platform": "meta",
  "accessToken": "provider_oauth_access_token"
}
```

Then connect the selected account:

```json
{
  "platform": "meta",
  "accessToken": "provider_oauth_access_token",
  "refreshToken": "provider_refresh_token_if_available",
  "externalAccountId": "provider_ad_account_id",
  "accountName": "Main Ad Account"
}
```

That is sufficient for internal/manual testing. Public agent workflows should
add OAuth start/callback/account-picker routes before workers handle real user
ad accounts.

Provider clients currently mirror these public API families:

- Google Ads REST mutate/search endpoints for campaign budgets, campaigns, ad
  groups, responsive search ads, and metrics. Default API version is `v24`
  unless `GOOGLE_ADS_API_VERSION` overrides it.
- Meta Marketing API Graph endpoints for ad accounts, campaigns, ad sets, ad
  creatives, ads, and insights. Default API version is `v24.0` unless
  `META_GRAPH_API_VERSION` overrides it.
- TikTok Business API `open_api/v1.3` endpoints for advertiser info,
  campaigns, ad groups, ads, status updates, and integrated reports.

Campaigns are created paused/disabled. Paid delivery is a separate start call.
Creative creation also requires platform-native asset context:

- Meta link/video creatives require `pageId` or `META_DEFAULT_PAGE_ID`, and may
  pass `instagramActorId` or `META_DEFAULT_INSTAGRAM_ACTOR_ID`. Image URLs are
  uploaded to Meta Ad Images and linked by `image_hash`; video URLs are mapped
  through Meta Ad Videos and linked by `video_id`.
- TikTok image/video creatives require provider-native `image_id` or
  `video_id`. Cloud uploads generated URLs through TikTok's ad file upload API
  before creative creation when `media[].providerAssetId` is absent.
- Google image creatives upload generated images as Google Ads `ImageAsset`
  resources. YouTube URLs are mapped to Google Ads `YOUTUBE_VIDEO` assets, and
  raw video URLs use Google Ads resumable `YouTubeVideoUpload` ingestion.
  Creatives with image assets use responsive display ads; when a processed
  YouTube video asset is also present, Cloud attaches it to the responsive
  display creative. Text-only creatives continue to use responsive search ads.

## Required Provider Registration

### Google Ads

Official docs:

- https://developers.google.com/google-ads/api/docs/get-started/select-account
- https://developers.google.com/google-ads/api/docs/oauth/overview

Register:

- Google Ads manager account with an API developer token.
- Google Cloud OAuth client for Eliza Cloud.
- OAuth consent configuration that can request Google Ads access.
- Authorized redirect URI for the future Cloud callback endpoint, for example
  `https://www.elizacloud.ai/api/v1/advertising/oauth/google/callback`.

Configure:

- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- Optional `GOOGLE_ADS_API_VERSION`
- Optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID`

OAuth scope:

- `https://www.googleapis.com/auth/adwords`

### Meta / Facebook / Instagram

Official docs:

- https://developers.facebook.com/docs/marketing-api/
- https://developers.facebook.com/docs/app-review/

Register:

- Meta developer app.
- Business portfolio / Business Manager.
- Marketing API product.
- Facebook Page, Instagram professional account, ad account, and pixel/dataset
  where required by the campaign objective.
- OAuth redirect URI for the future Cloud callback endpoint, for example
  `https://www.elizacloud.ai/api/v1/advertising/oauth/meta/callback`.
- App Review for production access to the permissions below.

Configure:

- `META_APP_ID`
- `META_APP_SECRET`
- Optional `META_GRAPH_API_VERSION`
- Optional `META_DEFAULT_PAGE_ID`
- Optional `META_DEFAULT_INSTAGRAM_ACTOR_ID`
- Optional `META_SYSTEM_USER_TOKEN` for internal service-account testing only.

Permissions normally needed:

- `ads_read`
- `ads_management`
- `business_management` when selecting business-owned ad accounts/assets.

Instagram ad delivery uses Meta Marketing API placements; the connected Meta
account still needs access to the Instagram asset.

### TikTok

Official docs:

- https://ads.tiktok.com/help/article/marketing-api?lang=en
- https://business-api.tiktok.com/portal/docs

Register:

- TikTok for Business / TikTok Ads Manager account.
- TikTok Business API developer application.
- Advertiser account access.
- Redirect URI for the future Cloud callback endpoint, for example
  `https://www.elizacloud.ai/api/v1/advertising/oauth/tiktok/callback`.
- App approval for campaign management, creative management, reporting, and
  advertiser selection scopes.

Configure:

- `TIKTOK_ADS_APP_ID`
- `TIKTOK_ADS_APP_SECRET`

## Agent Workflow

1. Register or reuse the Eliza Cloud app.
2. Generate promotion assets with `/api/v1/apps/{id}/promote/assets`,
   `/api/v1/generate-image`, `/api/v1/generate-video`,
   `/api/v1/generate-music`, or `/api/v1/voice/tts`.
3. Discover selectable provider ad accounts if the account id is not already known.
4. Connect or select an ad account.
5. Create a campaign with a destination URL, app id, budget, and targeting.
6. Upload media to the ad account when the agent needs the provider id in
   advance, or let `advertising.creatives.create` auto-upload missing provider
   ids for synced campaigns.
7. Create creative records from generated or uploaded media.
8. Inspect, update, or delete drafts with
   `/api/v1/advertising/creatives/{id}` before starting paid delivery.
9. Keep the campaign paused/draft until the owner confirms the exact platform,
   account, destination, creative, audience, and budget.
10. Start delivery with `/api/v1/advertising/campaigns/{id}/start`.
11. Poll analytics and pause when the budget or quality guardrail is hit.

Spawned workers should use the parent-agent bridge:

```text
USE_SKILL parent-agent {"mode":"list-cloud-commands","query":"advertising"}
USE_SKILL parent-agent {"mode":"cloud-command","command":"advertising.accounts.discover","params":{"body":{"platform":"meta","accessToken":"<temporary-provider-token>"}}}
USE_SKILL parent-agent {"mode":"cloud-command","command":"advertising.accounts.media.upload","confirmed":true,"params":{"id":"<adAccountId>","body":{"type":"image","name":"launch-card","url":"https://cdn.example/asset.png"}}}
USE_SKILL parent-agent {"mode":"cloud-command","command":"advertising.campaigns.create","params":{"body":{"adAccountId":"<uuid>","name":"Launch","objective":"traffic","budgetType":"daily","budgetAmount":50,"budgetCurrency":"USD","appId":"<appId>"}}}
USE_SKILL parent-agent {"mode":"cloud-command","command":"advertising.creatives.list","params":{"id":"<campaignId>"}}
USE_SKILL parent-agent {"mode":"cloud-command","command":"advertising.creatives.update","confirmed":true,"params":{"id":"<creativeId>","body":{"headline":"Updated launch headline"}}}
```

The unconfirmed call should return `confirmation_required`. Re-run paid actions
with `confirmed:true` only after the parent/user approves.

## Safety Defaults

- Treat campaign creation, creative upload, and campaign start as paid or
  externally visible actions.
- Create campaigns paused/draft first when provider APIs allow it.
- Starting delivery is a separate confirmation step.
- Store provider tokens encrypted and never expose them to task agents.
- Redact all access tokens, refresh tokens, developer tokens, app secrets, and
  private keys in logs.
- Record an audit event for account connect, campaign create, creative create,
  start, pause, budget changes, and failed provider calls.
- Add daily and lifetime budget caps at both Cloud and provider levels.

## Provider Payload Notes

### Meta Creative

Optional media upload:

```json
{
  "type": "image",
  "name": "launch-card",
  "url": "https://cdn.example/asset.png"
}
```

The response `providerAssetId` is a Meta image hash for images or a Meta
`video_id` for videos. Video uploads use Meta's URL-based Ad Video ingestion, so
the source URL must stay provider-readable long enough for Meta to fetch it.

`POST /api/v1/advertising/campaigns/{id}/creatives` should include:

```json
{
  "name": "Launch creative",
  "type": "image",
  "headline": "Build AI apps that earn",
  "primaryText": "Launch with auth, billing, payments, and promotion built in.",
  "callToAction": "learn_more",
  "destinationUrl": "https://myapp.example",
  "pageId": "facebook_page_id",
  "instagramActorId": "optional_instagram_actor_id",
  "media": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "source": "generation",
      "url": "https://cdn.example/asset.png",
      "providerAssetId": "optional_meta_image_hash",
      "type": "image",
      "order": 0
    }
  ]
}
```

### TikTok Creative

Upload generated media to TikTok first, or let creative creation do it:

```json
{
  "type": "video",
  "name": "launch-video",
  "url": "https://cdn.example/asset.mp4",
  "thumbnailUrl": "https://cdn.example/asset-thumb.png"
}
```

The response `providerAssetId` is a TikTok `video_id` or `image_id`. Then pass
it explicitly, or omit it and let Cloud map the URL during creative creation:

```json
{
  "name": "TikTok launch creative",
  "type": "video",
  "headline": "Build AI apps",
  "primaryText": "Launch and monetize on Eliza Cloud.",
  "callToAction": "learn_more",
  "destinationUrl": "https://myapp.example",
  "tiktokIdentityId": "optional_identity_id",
  "tiktokIdentityType": "CUSTOMIZED_USER",
  "media": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "source": "generation",
      "url": "https://cdn.example/asset.mp4",
      "providerAssetId": "tiktok_video_id",
      "type": "video",
      "order": 0
    }
  ]
}
```

### Google Creative

Upload generated images to Google Ads when creating display creatives:

```json
{
  "type": "image",
  "name": "Launch Image",
  "url": "https://cdn.example/asset.jpg"
}
```

The response `providerAssetId` is a Google Ads asset resource name such as
`customers/123/assets/456`. Creatives with an image provider id create a paused
responsive display ad. Text-only creatives create a paused responsive search ad.

YouTube video URLs are mapped to Google Ads `YOUTUBE_VIDEO` assets:

```json
{
  "type": "video",
  "name": "Launch Video",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "thumbnailUrl": "https://cdn.example/asset-thumb.jpg"
}
```

Raw video URLs are uploaded through Google Ads `YouTubeVideoUpload` and return a
`customers/{customerId}/youTubeVideoUploads/{id}` resource. After Google/YouTube
processing reaches `PROCESSED`, use the resulting YouTube video id to create a
`YOUTUBE_VIDEO` asset or pass a YouTube URL through the media upload route.

## Implementation Gaps To Close Before Public Launch

- Add OAuth start/callback routes:
  - `GET /api/v1/advertising/oauth/{platform}/start`
  - `GET /api/v1/advertising/oauth/{platform}/callback`
  - account-picker UI that calls `POST /api/v1/advertising/accounts/discover`
    after OAuth callback so the user chooses the exact account and assets.
- Replace raw-token account connection in public flows.
- Refresh expiring tokens on a scheduled job.
- Add idempotency keys or persisted intermediate state for multi-step provider
  campaign creation to avoid duplicate budgets/campaigns/ad sets on retry.
- Add a background reconciler for Google `YouTubeVideoUpload` resources so raw
  video uploads automatically become `YOUTUBE_VIDEO` assets once processing
  reaches `PROCESSED`. Current provider upload/mapping supports Meta
  images/videos, TikTok images/videos, Google image assets, Google YouTube video
  assets, and Google raw video ingestion.
- Ensure campaign creation creates paused/draft provider objects when supported.
- Add provider sandbox/unit tests and Hono route tests for account connection,
  campaign create, creative create, start, pause, analytics, and failure paths.

## Content Safety Notes

- Set `OPENAI_MODERATION_API_KEY` or `OPENAI_API_KEY` and keep
  `CONTENT_SAFETY_MODE=enforce` for public launch. Use
  `CONTENT_SAFETY_REQUIRE_CONFIG=true` in production so public generation and
  advertising routes fail closed if moderation is not configured.
- Cloud reviews ad campaign copy, creative text, image media, generated image
  outputs, promotion copy, promotion images, video prompts, music prompts and
  lyrics, and TTS text before billing or external publication.
- OpenAI Moderation supports text and image inputs through
  `omni-moderation-latest`, but the official classification table marks
  `sexual/minors` as text-only. Do not treat image moderation as a complete
  CSAM classifier; keep provider policy checks, abuse reporting, and platform
  review workflows in place.
