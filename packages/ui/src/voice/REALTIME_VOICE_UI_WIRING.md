# Realtime voice UI wiring — manual test script

The realtime voice-session client is wired into the persistent chat shell's
existing Talk control. It is an additive enhancement: with the flag off (or no
server mint), the mic runs the existing batch ASR path completely unchanged.

## What lands

- `useRealtimeVoiceSession` — lifecycle-tied hook around
  `createVoiceSessionClient`. Mints (consent → mint → WSS → hello-first),
  exposes `{ available, active, status, transcriptPartial, transcriptFinal,
  agentSpeaking, paused, error, start, stop, bargeIn, unlock }`. iOS: resumes
  the AudioContext on the start gesture; visibility-hide surfaces `paused`.
- `useRealtimeVoiceMint` — resolves `agentId` (dedicated cloud agent UUID from
  the persisted active server) + `getConsentNonce` (POST
  `/api/v1/voice/session/consent` via the same `fetchWithCsrf` every other
  `/api/v1` call uses). The client obtains a fresh one-use nonce immediately
  before every initial or reconnect mint. A production self-hosted build may
  instead arm against a paired runtime only after its same-origin
  voice-session health route succeeds; the runtime binds its fixed identity
  server-side.
- `useContinuousVoiceSession` — composes the batch continuous-chat engine with
  the realtime session; tries realtime when eligible, else batch UNCHANGED.
  Eligibility is not proof that mint or WebSocket setup has succeeded.
- `useShellController.ts` — the always-mounted app shell owns the realtime
  session behind the same Talk control. It disables batch capture while
  realtime owns the mic (no double mic / double STT) and requests canonical
  conversation reconciliation when the gateway commits a voice turn.
- `ChatOverlay.tsx` — realtime words and phase replace the normal textarea lane
  inside the existing composer while Talk is active. Starting Talk opens that
  same conversation to the reading detent; completed user and assistant turns
  remain in the normal conversation history. There is no second floating card
  and no separate client-only transcript store.
- `ChatView.tsx` — legacy embedded chat surfaces retain the existing
  `ChatVoiceStatusBar`; the persistent application surface is `ChatOverlay`.
- `ChatVoiceStatusBar.tsx` — new optional props `realtimeActive`,
  `realtimePaused`, `realtimeErrorMessage`. When false/absent the bar is
  byte-for-byte the existing batch bar.

## Flags

- Client: `VITE_VOICE_REALTIME_WS` = `1|true|yes|on` (default OFF for builds;
  the local dev gateway defaults it ON unless explicitly configured).
- Self-hosted client capability: `VITE_VOICE_REALTIME_SELF_HOSTED` =
  `1|true|yes|on` (default OFF). It still requires a paired `remote` runtime and
  a successful same-origin `/api/v1/voice/session/health` probe.
- Server: `VOICE_REALTIME_WS_ENABLED` on the cloud worker (default OFF; a 404
  mint = feature disabled → the client falls back to batch, no error).

Both must be on AND either a dedicated cloud agent UUID must resolve or the
self-hosted capability and health-probe contract must pass.

- Debug: `VITE_VOICE_REALTIME_FORCE` = `1|true|yes|on` (default OFF). A
local-verification debug affordance only — it force-arms the realtime path
when normal resolution would not, so a developer can exercise the client
wiring without a fully configured cloud. Never set it in a deployed build.

## Local runtime + Cartesia provider loop

The dev app can exercise the same server-side voice session while keeping chat
on a local elizaOS runtime. Start the runtime on `31337`, then run:

```bash
CARTESIA_API_KEY=… \
ELIZA_LOCAL_VOICE_GATEWAY_PORT=31338 \
bun run --cwd packages/cloud/api voice:local-gateway

ELIZA_LOCAL_VOICE_GATEWAY_PORT=31338 \
bun run --cwd packages/app dev
```

Vite sends only `/api/v1/voice/session` HTTP and WebSocket traffic to the
loopback gateway; all other `/api` traffic remains on `31337`. The provider
loop is Cartesia Ink 2 STT → local runtime/model route → Cartesia Sonic 3.5 TTS.
The Cartesia key remains in the gateway process and is never exposed to Vite or
the browser. In dev-server mode, configuring `ELIZA_LOCAL_VOICE_GATEWAY_PORT`
defaults both the staged realtime client and self-hosted capability flags on.
The self-hosted path still requires a paired remote runtime and a successful
same-origin health probe. Explicit `VITE_VOICE_REALTIME_WS` and
`VITE_VOICE_REALTIME_SELF_HOSTED` values still win, the diagnostic
`VITE_VOICE_REALTIME_FORCE` bypass remains explicit-only, and production/mobile
builds keep their existing staged defaults.

## Flag retirement

These flags exist only while realtime voice is staged. When realtime voice
graduates from staging to the default voice path:

- The batch-vs-realtime branching in `chat-view-hooks.tsx` / `ChatView.tsx`
  collapses to the realtime path, and the build-time
  `VITE_VOICE_REALTIME_WS` flag is removed along with the batch branch.
- `VITE_VOICE_REALTIME_FORCE` is removed together with the staging flag at
  graduation — with no branch left to force, it has no purpose.
- The server-side `VOICE_REALTIME_WS_ENABLED` gate flips to default-ON (or is
  removed) as part of the same graduation change.

## Manual test — desktop Chrome

1. Build the PWA with the flag on and pointed at a cloud API that has the server
   flag + Cartesia and Cerebras/Eliza bridge credentials configured:
   ```
   VITE_VOICE_REALTIME_WS=1 bun run --filter @elizaos/ui dev   # or the app build
   ```
2. Sign in so a **dedicated cloud agent** is the active runtime (the mint needs
   its UUID; a shared/local runtime won't arm realtime — that's the fallback
   case, verify it in step 8).
3. Open a chat. Turn the continuous-chat toggle to **vad-gated** or
   **always-on** (the same toggle as today).
4. Grant the mic permission prompt. Expect the chat sheet to open and the
   composer's text lane to cycle
   `Listening → Transcribing → Thinking → Speaking → Listening`.
5. Speak a sentence. Watch:
   - the interim transcript update live (from `stt_partial`),
   - the status flip to `Thinking` then `Speaking`,
   - the committed user and assistant turns appear in the same chat history,
   - the agent's voice play back (Cartesia audio via the WS downlink).
6. **Barge-in:** while the agent is speaking, tap the mic (or start talking).
   Audio should stop IMMEDIATELY (local playback flush, before the server ack),
   and the status returns to `Listening`.
7. **Network check (DevTools):** confirm a `POST /api/v1/voice/session/consent`
   (200, `{consentNonce}`), a `POST /api/v1/voice/session` (200, `{wsUrl,token}`),
   and one WSS connection to `…/api/v1/voice/session/ws`. The first WS frame is a
   JSON `hello` carrying the token. No provider key ever appears client-side.
8. **Fallback:** flip the SERVER flag off (or point at a build without it). The
   mint returns 404; the realtime composer state disappears, the mic runs the existing
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
  - **Background/foreground:** backgrounding may let the app render a
    **Paused** pill, but iOS can also suspend the WebView before JS runs and
    kill the JS/WS session outright. On foreground, expect reconnect/re-mint;
    if the turn was interrupted before final STT, re-speak that turn.
   - **AudioWorklet vs ScriptProcessor:** the client probes at runtime; both are
     covered. On the installed PWA the AudioWorklet path is expected.

## Evidence status (honest)

- Hook + component behavior is covered by real-hook + real-client tests driving
  the client's fake TRANSPORTS. The focused suite includes manual-vs-continuous
  session intent, agent/conversation re-minting, user-activation ordering,
  actionable autoplay unlock, mint/trace correlation, fallback, barge-in, and
  reconnect/cancellation coverage. The deploy workflow also has an executable
  fail-closed contract for staging provider/bridge secrets and production auth
  isolation. Production realtime is explicitly off, so any legacy Worker
  authorization remains inert; before enabling production, ops must configure
  the dedicated `VOICE_REALTIME_ELIZA_AUTHORIZATION`, provider secrets, the
  Cartesia voice ID, and the production Eliza endpoint, then run a managed
  deploy that overwrites the stale value. The workflow contract fails an
  enabled production deploy when any of those values are absent.
- Browser-level proof (screen recording + audio, both-side logs, real
  Cartesia Ink/Cerebras/Cartesia Sonic round-trip) is the INTEGRATION-run's job on a real
  device against the deployed server — this branch does NOT claim device-tested.
