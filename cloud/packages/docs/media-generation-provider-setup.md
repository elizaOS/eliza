# Media Generation Provider Setup

This document covers provider setup for Cloud image, video, music, and voice
promotion APIs used by agent-built apps.

## Current Eliza Cloud Surface

- `POST /api/v1/generate-image`
- `POST /api/v1/generate-video`
- `POST /api/v1/generate-music`
- `POST /api/v1/voice/tts`
- `POST /api/v1/apps/{id}/promote/assets`

All public generation endpoints require a Cloud session or API key, reserve
credits before provider I/O, and write usage/generation records where the route
has durable output.

All public prompts are reviewed by Cloud content safety before credits are
reserved. Image outputs and app promotion images are reviewed again after they
are stored in R2 and before their URLs are returned or linked to ads. Video
generation also respects provider `has_nsfw_concepts` signals when available.

Generated image/video URLs can be mapped into paid ad platforms with
`POST /api/v1/advertising/accounts/{id}/media`. Creative creation also
auto-uploads missing provider asset ids for synced campaigns, so an agent can
generate media, pass the returned URL into `media[]`, and let Cloud attach the
provider-native id before the creative is sent to Meta, TikTok, or Google.
Google video mapping is YouTube-backed: YouTube URLs become `YOUTUBE_VIDEO`
assets immediately, while raw generated videos enter Google Ads
`YouTubeVideoUpload` processing. Poll
`GET /api/v1/advertising/accounts/{id}/media?providerAssetResourceName=...`;
when it reports `ready:true`, pass the returned YouTube URL back through the
media upload route to create the final `YOUTUBE_VIDEO` asset.

Configure the safety gate with:

- `OPENAI_MODERATION_API_KEY` or `OPENAI_API_KEY`
- Optional `OPENAI_MODERATION_MODEL` defaults to `omni-moderation-latest`
- `CONTENT_SAFETY_MODE=enforce|warn|off`, defaulting to `enforce` when a key is
  present
- `CONTENT_SAFETY_REQUIRE_CONFIG=true` in production so public generation fails
  closed when moderation is not configured
- Development-only `CONTENT_SAFETY_FAIL_OPEN=true` if moderation outage should
  not block local testing

## Fal

Official docs:

- https://fal.ai/models/fal-ai/minimax-music/v2.6/api
- https://fal.ai/docs/documentation/model-apis/pricing

Configure one of:

- `FAL_KEY`
- `FAL_API_KEY`

Music defaults to `fal-ai/minimax-music/v2.6`. The route accepts `prompt`,
optional `lyrics`, `instrumental`, `lyricsOptimizer`, and `audio` settings.
Fal MiniMax Music supports structured lyric tags and returns an audio URL.

Pricing notes:

- Fal exposes account/model pricing through its platform pricing API.
- Cloud includes conservative music snapshot prices so billing works before an
  admin override exists.
- For production, set a manual pricing override in
  `PUT /api/v1/admin/ai-pricing` for each enabled music model and contract.

## ElevenLabs

Official docs:

- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/api-reference/music/compose
- https://elevenlabs.io/docs/api-reference/music/stream
- https://elevenlabs.io/docs/api-reference/reducing-latency

Configure:

- `ELEVENLABS_API_KEY`
- Optional `ELEVENLABS_VOICE_ID`
- Optional `ELEVENLABS_MODEL_ID`
- Optional `ELEVENLABS_OUTPUT_FORMAT`
- Optional `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY`

TTS defaults to `eleven_flash_v2_5`, which is the fastest default for
interactive agents. Use `eleven_multilingual_v2` or `eleven_v3` when quality
and expressive control matter more than latency. Prefer streaming or websocket
TTS paths for live agents.

Low-latency TTS guidance:

- Keep short utterances under about 1,000 characters.
- Use `eleven_flash_v2_5`.
- Use default, synthetic, or instant-clone voices before professional clones
  when latency matters.
- Request PCM/u-law formats for realtime playback or telephony pipelines to
  avoid MP3 decode/transcode work.

Music uses `elevenlabs/music_v1`, calls ElevenLabs `/v1/music`, and stores the
returned binary audio in the configured Cloud R2 `BLOB` bucket.

ElevenLabs also exposes `/v1/music/stream` for streaming song bytes. The Cloud
route currently calls `/v1/music` because it needs a complete binary object to
store in R2 and return as a stable URL.

## Suno-Compatible Providers

Suno does not currently have a stable first-party public API surface in this
repo. Cloud supports a compatibility provider only:

- `SUNO_API_KEY`
- Optional `SUNO_BASE_URL`

The model id is `suno/default`. Treat this as an adapter to a trusted provider
you configure, not a guarantee of official Suno access. Override pricing before
production use and verify generated-content rights with the selected provider.

Research note: public Suno API access is still dominated by third-party or
unofficial wrappers such as `sunoapi.org` and open-source proxy projects. Do
not represent `suno/default` as first-party Suno unless Suno publishes a stable
official developer API and terms.

## Faster TTS Options To Consider

The current Cloud route is ElevenLabs-only. It already exposes per-request
`outputFormat`, `optimizeStreamingLatency`, `voiceSettings.speed`, and defaults
to `eleven_flash_v2_5` for low-latency responses.

Provider candidates for future adapters:

- Cartesia Sonic: byte-stream, SSE, and WebSocket TTS APIs. Their docs recommend
  WebSocket when text arrives incrementally from an LLM or when the lowest
  repeated-turn latency is required.
- Deepgram Aura/Aura-2: REST and WebSocket TTS designed for realtime voice
  agents, with low-latency streaming and telephony-friendly formats.
- PlayHT: HTTP streaming TTS at `POST /api/v2/tts/stream`, including a newer
  turbo path for realtime text-in/audio-out use cases.
- OpenAI Audio/Realtimes APIs: `POST /v1/audio/speech` for TTS and Realtime API
  for speech-to-speech voice agents. Use this when Cloud already routes through
  OpenAI and conversation latency matters more than cloned-voice fidelity.

Adapter requirements before adding these providers:

- provider-specific env names and secret storage
- pricing snapshots or admin pricing overrides
- content-type/output-format normalization
- usage and billing source names in `ai-pricing` / `ai-billing`
- streaming tests that do not require live provider keys

## Required Storage

ElevenLabs music and Cloud image generation require the Worker R2 binding:

- `BLOB`
- Optional `R2_PUBLIC_HOST`

Fal and Suno-compatible music return provider-hosted URLs, but production apps
may still want an ingestion job that copies external media into R2 for
durability and takedown control.

## Worker / Parent-Agent Pattern

Spawned task workers should not receive provider keys. They should use the
parent-agent bridge:

```text
USE_SKILL parent-agent {"mode":"list-cloud-commands","query":"media"}
USE_SKILL parent-agent {"mode":"cloud-command","command":"media.music.generate","confirmed":true,"params":{"body":{"prompt":"City pop launch track","model":"fal-ai/minimax-music/v2.6","instrumental":true}}}
```

Paid media commands require `confirmed:true` after the parent/user approves the
model, prompt, app/account, and budget.

## Open Gaps

- Query Fal's pricing API during pricing refresh when Cloud has a server-side
  Fal key, instead of relying only on music snapshot prices.
- Add provider-native webhooks for long-running music jobs.
- Add an R2 copy/cache step for all provider-hosted audio and video URLs.
- Add provider contract tests for Fal MiniMax, ElevenLabs music/TTS, and any
  configured Suno-compatible provider.
