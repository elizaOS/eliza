# Realtime voice UI wiring — manual test script

This branch (`feat/voice-realtime-ui`) wires the realtime voice-session client
(the WS path from PR #16062 / `feat/voice-realtime-slice`) into the EXISTING
chat voice UI, behind the same continuous-chat toggle. It is an ADDITIVE
enhancement: with the flag off (or no server mint), the mic runs the existing
batch ASR path completely unchanged.

## What lands

- `useRealtimeVoiceSession` — lifecycle-tied hook around
  `createVoiceSessionClient`. Mints (consent → mint → WSS → hello-first),
  exposes `{ available, active, status, transcriptPartial, transcriptFinal,
  agentSpeaking, paused, error, start, stop, bargeIn, unlock }`. iOS: resumes
  the AudioContext on the start gesture; visibility-hide surfaces `paused`.
- `useRealtimeVoiceMint` — resolves `agentId` (dedicated cloud agent UUID from
  the persisted active server) + `getConsentNonce` (POST
  `/api/v1/voice/session/consent` via the same `fetchWithCsrf` every other
  `/api/v1` call uses). A local/self-hosted runtime yields no UUID → realtime
  never arms.
- `useContinuousVoiceSession` — composes the batch continuous-chat engine with
  the realtime session; selects realtime when `available`, else batch UNCHANGED.
- `chat-view-hooks.tsx` — `useChatVoiceController` now creates the realtime
  session + composed surface, drives realtime on/off from the SAME continuous-
  chat toggle, and `disabled`s the batch passive capture while realtime owns the
  mic (no double mic / double STT).
- `ChatView.tsx` — the existing `ChatVoiceStatusBar` reads the composed
  `voiceSession` (realtime status/transcript when active, batch otherwise). A
  small "Live"/"Paused" pill + an actionable error pill are the only new
  affordances, in the existing design tokens (lucide `Radio`/`PauseCircle`/
  `AlertTriangle`, `bg-accent`/`bg-warn`/`bg-danger`).
- `ChatVoiceStatusBar.tsx` — new optional props `realtimeActive`,
  `realtimePaused`, `realtimeErrorMessage`. When false/absent the bar is
  byte-for-byte the existing batch bar.

## Flags

- Client: `VITE_VOICE_REALTIME_WS` = `1|true|yes|on` (default OFF).
- Server: `VOICE_REALTIME_WS_ENABLED` on the cloud worker (default OFF; a 404
  mint = feature disabled → the client falls back to batch, no error).

Both must be on AND a dedicated cloud agent UUID must resolve for the realtime
path to arm.

## Manual test — desktop Chrome

1. Build the PWA with the flag on and pointed at a cloud API that has the server
   flag + provider keys (Deepgram / Cerebras / Cartesia) configured:
   ```
   VITE_VOICE_REALTIME_WS=1 bun run --filter @elizaos/ui dev   # or the app build
   ```
2. Sign in so a **dedicated cloud agent** is the active runtime (the mint needs
   its UUID; a shared/local runtime won't arm realtime — that's the fallback
   case, verify it in step 8).
3. Open a chat. Turn the continuous-chat toggle to **vad-gated** or
   **always-on** (the same toggle as today).
4. Grant the mic permission prompt. Expect the status bar to show a **Live**
   pill (accent) + the status label cycling
   `Listening → Transcribing → Thinking → Speaking → Listening`.
5. Speak a sentence. Watch:
   - the interim transcript update live (from `stt_partial`),
   - the status flip to `Thinking` then `Speaking`,
   - the agent's voice play back (Cartesia audio via the WS downlink).
6. **Barge-in:** while the agent is speaking, tap the mic (or start talking).
   Audio should stop IMMEDIATELY (local playback flush, before the server ack),
   and the status returns to `Listening`.
7. **Network check (DevTools):** confirm a `POST /api/v1/voice/session/consent`
   (200, `{consentNonce}`), a `POST /api/v1/voice/session` (200, `{wsUrl,token}`),
   and one WSS connection to `…/api/v1/voice/session/ws`. The first WS frame is a
   JSON `hello` carrying the token. No provider key ever appears client-side.
8. **Fallback:** flip the SERVER flag off (or point at a build without it). The
   mint returns 404; the **Live** pill disappears, the mic runs the existing
   batch path (browser/cloud ASR → send → TTS) with NO error surface and NO
   behavior change. This is the critical non-regression.
9. Turn the continuous-chat toggle **off** → the WS session sends a clean `bye`
   and closes (WS close 1000 in DevTools); the mic goes idle.

## Manual test — iPhone PWA (installed to home screen)

1. Install the PWA (Share → Add to Home Screen) from a build with
   `VITE_VOICE_REALTIME_WS=1`.
2. Repeat steps 2–6 above. Extra iOS checks:
   - **Autoplay unlock:** the FIRST agent audio must be audible without a second
     tap — the session `start()` resumes the AudioContext on the start gesture.
   - **Background/foreground:** background the app mid-session; the status bar
     shows a **Paused** pill (not a dead/broken bar). Foreground it; the pill
     clears and capture resumes.
   - **AudioWorklet vs ScriptProcessor:** the client probes at runtime; both are
     covered. On the installed PWA the AudioWorklet path is expected.

## Evidence status (honest)

- Hook + component behavior is covered by real-hook + real-client tests driving
  the client's fake TRANSPORTS (60 tests green: `useRealtimeVoiceSession` 9,
  `useContinuousVoiceSession` 6, `useRealtimeVoiceMint` 7, `ChatVoiceStatusBar`
  17, `voice-session-client` 12, `voice-session-state` 9).
- Browser-level proof (screen recording + audio, both-side logs, real
  Deepgram/Cerebras/Cartesia round-trip) is the INTEGRATION-run's job on a real
  device against the deployed server — this branch does NOT claim device-tested.
