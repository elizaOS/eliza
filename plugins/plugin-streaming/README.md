# @elizaos/plugin-streaming

Unified RTMP streaming: Twitch, YouTube Live, X (Twitter), pump.fun, `streaming.customRtmp`, and `streaming.rtmpSources[]` for named extra ingests.

Default export: **`streamingPlugin`**. Preset factories: **`createTwitchDestination`**, **`createYoutubeDestination`**, **`createXStreamDestination`**, **`createPumpfunDestination`**. Helpers: **`createCustomRtmpDestination`**, **`createNamedRtmpDestination`**.

Stream keys still come from each platform’s studio/dashboard (no OAuth in this package).
