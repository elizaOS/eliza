# @elizaos/voice-evidence-harness

Real-provider, Definition-of-Done evidence capture for the realtime voice-session
WebSocket pipeline (Deepgram Flux STT → streaming LLM → Cartesia Sonic 3.5 TTS).

This harness exists because this repo's maintainer **closes voice PRs that lack
real-provider / real-device evidence** (see
`eliza-fleet/DEFINITION-OF-DONE-COMPLIANCE.md` and tonight's four closures:
16014, 16011, 15960, 15931). It is how every voice PR gets its DoD-compliant
proof from now on:

> One command drives a REAL WS voice turn against a locally-started server wired
> to the **merged provider adapters** with **LIVE** Deepgram + Cartesia keys, and
> captures every artifact the DoD demands — WS transcript, input+output audio,
> both-side logs, stage timings, the post-interrupt zero-frame assertion, domain
> rows, and an inline-ready MP4 — into an evidence dir OUTSIDE the repo, indexed
> with SHA-256s.

**This is a test harness, not a second production voice service.** See
`src/reference/` — the reference server is clearly marked harness-only; it exists
solely so the provider legs are proven real NOW, before the production
`feat/voice-session-ws-phase1` server branch is assembled. When that branch
lands, point the harness client at its real mint route + WS endpoint and the
scenarios run unchanged (the harness speaks the exact §7 wire contract from
`VOICE-INTEGRATION-DECISION-2026-07-10.md`).

## What it proves is REAL

| leg | reality |
| --- | --- |
| STT | **LIVE Deepgram Flux** `/v2/listen` via the merged adapter `packages/cloud/api/v1/voice/stt/providers/deepgram-flux.ts` (#15950). Real transcript. |
| TTS | **LIVE Cartesia Sonic 3.5** WebSocket via the merged adapter `packages/cloud/shared/src/lib/services/cartesia-sonic-tts.ts` (#15949). Real PCM audio out. |
| LLM (§LLM-leg) | Real streaming LLM over OpenRouter, **standing in for** Cerebras `gemma-4-31b` reached via the Eliza SSE bridge in production. Real network, real token-by-token SSE, real first-text latency, **real AbortSignal cancellation** (the barge-in path). NOT a mock. Swap `HARNESS_LLM_MODEL` / the bridge URL for the funded staging Eliza SSE endpoint and nothing else changes (funded-org blocker: decision §12). |

Nothing in the provider legs is mocked. There is no stub socket. The reference
server drives the same adapter code the production server will.

## Usage

```bash
cd packages/tools/voice-evidence-harness
bun install
# keys are read from ~/.moltbot/secrets/{deepgram,cartesia}.json and $OPENROUTER_API_KEY
bun run src/cli.ts --scenario=all         # baseline + bargein + error-auth
bun run src/cli.ts --scenario=baseline
bun run src/cli.ts --scenario=bargein
bun run src/cli.ts --scenario=error-auth
bun run src/cli.ts --scenario=baseline --fixture=fixtures/turn_human.wav

# --target selects what is under test (default: reference):
bun run src/cli.ts --scenario=all --target=reference   # harness §7 reference server
bun run src/cli.ts --scenario=all --target=real        # REAL Phase-1 voice-session server
```

**`--target=real`** boots the ACTUAL production Phase-1 server code (mint
consent+JWT precondition chain → `attachVoiceWsHandler` → `VoiceSession` → merged
Deepgram/Cartesia adapters) on a node WS transport shim, with
`VOICE_REALTIME_WS_ENABLED=true`, and drives the same 3 scenarios against LIVE
providers. The shim is transport-only (WebSocketPair→node `ws`, Workers outbound
upgrade→header-preserving `ws` factory, Redis→MOCK_REDIS, JWKS→test keypair, mint
auth/tenancy→fixed authed user); every jwt/consent/registry/metering/reframer/
provider-socket path runs unmodified. See
`packages/cloud/api/v1/voice/session/lib/harness-real-server.ts` for the exact
REAL-vs-SHIMMED boundary, and `eliza-fleet/SLICE-EVIDENCE-REPORT.md` for the live
run + the server bugs it surfaced and fixed. Real-target evidence lands in
`.../voice-e2e/<timestamp>-real-server/`.

Evidence lands in
`~/.moltbot/projects/eliza-fleet/evidence/voice-e2e/<timestamp>[-real-server]/<scenario>/`.
The harness **exits non-zero** if any required stage/artifact is missing — there
is NO path that turns absent data into a healthy zero (the 16011 closure cited
exactly that).

## Scenarios

- **baseline** — full happy-path turn: mint → hello → ready → real STT final →
  LLM first text → Cartesia first frame → speaking_end. Captures the complete
  stage-timing ledger.
- **bargein** — the agent is provably mid-speech, then the client fires
  `barge_in`. Asserts `interrupted` fires and **post-interrupt downlink frame
  count == 0** (the merged Cartesia adapter's no-post-cancel-output guarantee,
  proven against the live provider).
- **error-auth** — a deliberately-bad Deepgram key. Asserts the session surfaces
  a provider/auth error, never reaches `ready`, and produces **no** TTS audio
  (no silent success, no fabricated output).
- (mid-stream-disconnect fault is wired in the reference server via
  `faultInjection: "mid-stream-disconnect"` for manual soak testing.)

## Artifacts per scenario

- `input.wav` — the spoken fixture streamed in (see `fixtures/PROVENANCE.md`).
- `output-tts.wav` — the real Cartesia audio out (playable, `pcm_s16le` 16 kHz).
- `ws-transcript.json` — every WS control/audio event, **tokens redacted**.
- `server.log.json` / `client.log.json` / `all.log.json` — both-side structured logs.
- `timing-report.json` — stage marks + deltas, with explicit `not_reached` for
  any missing stage.
- `interrupt-assertion.json` — the post-interrupt zero-frame assertion.
- `domain-rows.json` — `voice_sessions` + `voice_transcripts` rows the server
  produced, pretty-printed.
- `walkthrough.mp4` — input+output audio over a rendered timeline card,
  GitHub-inline-ready.
- `README.md` — the per-scenario index with SHA-256s, ready to paste into a PR body.

## Findings surfaced against LIVE providers (real bugs this harness caught)

1. **Deepgram Flux adapter sends an unsupported `channels` query param.**
   `buildDeepgramFluxListenUrl()` in the merged `deepgram-flux.ts` appends
   `channels=1`; LIVE `/v2/listen` rejects it with
   `INVALID_QUERY_PARAMETER: Unknown query parameters: channels` and closes 1002
   before any audio flows. **This blocks the real server, not just the harness.**
   Verified fix: drop the `channels` param (Flux is mono, inferred from
   `encoding=linear16`) → clean 101 upgrade. The harness strips it at the
   transport boundary and logs the strip loudly so the pipeline can be proven
   today; the adapter still needs the one-line fix.
2. **Deepgram Flux adapter does not model the benign `Connected` handshake
   frame.** Flux sends `{"type":"Connected",...}` first; the adapter maps it to a
   `malformed_event` error. Non-fatal, but noisy — the adapter should recognize
   `Connected` as a session-start ack rather than an error.
3. **Bun's native `WebSocket` drops custom request headers** (auth never reaches
   the provider → 1002). The harness uses the `ws` package for the provider
   sockets. Any production Bun/worker code opening these provider sockets must
   confirm header delivery on its runtime.

## LLM leg — why OpenRouter, not Cerebras

Production routes the middle leg through the existing Eliza conversation SSE to
Cerebras `gemma-4-31b` (decision §7/§9). A laptop can't reach a funded
Cerebras/Eliza-cloud org (decision §12 flags the funded-staging blocker), so the
harness substitutes an equivalent **real** streaming LLM to exercise the real
provider contract that actually matters for this pipeline: incremental token
deltas feeding phrase-aggregated TTS, and a real `AbortSignal` that stops
generation on barge-in. It is a different real model, not a mock. Repoint
`src/reference/llm-bridge.ts` at the staging Eliza SSE endpoint when the funded
org lands.
