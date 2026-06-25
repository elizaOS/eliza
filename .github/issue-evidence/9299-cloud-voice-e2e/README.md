# Cloud voice end-to-end — STT + Cerebras + TTS, streaming (#9299)

Validates the full cloud voice turn against **real services**, exercising the
same shape the agent's cloud voice loop runs
(`packages/core/src/services/message.ts` → `wrappedOnStreamChunk` fires
`useModel(TEXT_TO_SPEECH)` on the first sentence while the LLM is still
streaming):

```
"Tell me about Paris."
   ── ElevenLabs TTS  ─▶ question.mp3  (real audio)
   ── ElevenLabs STT (scribe_v1) ─▶ "Tell me about Paris." (100% recall)
   ── Cerebras gpt-oss-120b, STREAMING ─▶ 7 content deltas
        first sentence complete @296ms ─▶ ElevenLabs TTS ─▶ reply.mp3
        …2 more deltas keep streaming until @755ms (stream done)
   ── ElevenLabs STT (reply.mp3) ─▶ matches the reply (100% recall)
```

## Result — all legs PASS (live)

| Leg | Result | Detail |
|---|---|---|
| `tts(question)` | ✅ | 25,539 B valid MP3 (ElevenLabs `eleven_turbo_v2_5`) |
| `stt(question)` | ✅ | "Tell me about Paris." — 100% token recall (`scribe_v1`) |
| `cerebras(stream)` | ✅ | **7 content deltas**, 3 distinct arrival times, done@755ms |
| `cerebras(reply)` | ✅ | 3-sentence reply about Paris |
| `tts(first-sentence) mid-stream` | ✅ | sentence-1 ready **@296ms with 2 more deltas after it** → first-sentence TTS runs *while the LLM is still streaming* (the streaming-voice property) |
| `stt(reply)` | ✅ | reply MP3 transcribes back at 100% recall |

Cerebras stream timeline (ms into the stream): `+291 "Paris"`, `+296 " is"`, `+296 " the"`, `+296 " capital"`, `+296 "… Eiffel Tower and Notre-Dame. It is famed for"`, `+755 "… Montmartre. … river cruises"`, `+755 "."` — genuine token-by-token streaming, with sentence 1 synthesizable long before the reply finished.

## Artifacts

- `question.mp3` — real ElevenLabs TTS of the spoken question.
- `reply.mp3` — real ElevenLabs TTS of the agent's first reply sentence (the chunk the streaming voice loop emits first).
- `voice-e2e-run.log` — full run output.

Both MP3s are valid (ID3) and round-trip through STT at 100% recall, proving the bytes are real, playable speech.

## Providers / cost

- **STT + TTS:** ElevenLabs (`scribe_v1` / `eleven_turbo_v2_5`).
- **LLM:** Cerebras `gpt-oss-120b` @ `https://api.cerebras.ai/v1` — the model #9299 targets, on its real endpoint.
- **TTS quota:** the run spends only the question + first reply sentence (~125 chars); the rest of the reply is never sent to TTS.

## Reproduce

```bash
ELEVENLABS_API_KEY=$ELEVENLABS_XI_API_KEY CEREBRAS_API_KEY=csk-… \
  bun run --cwd packages/scenario-runner test:real-service:voice -- --out /tmp/voice
```

CI-safe: SKIPs (exit 0) without both keys or on an auth error; exit 1 only on a
real authenticated wrong/invalid result.
