# Cerebras Qwen 3.8 migration — 2026-09-04

Branch: `nubsstableDONOTDELETE`. Initial runtime migration: `4782de2d705`.
This report records sampled behavior, not an exhaustive acceptance certificate.

## Model policy

- Default Cerebras text model: `qwen-3.8-27b`, including small/large, response handler, and action planner.
- Direct OpenAI-compatible and native Eliza Cloud plugin calls default this exact model to `reasoning_effort: none`. Explicit Qwen low/medium/high pins remain supported; thinking-off calls suppress reasoning.
- Existing Gemma and other provider support remains available. No regex intent routing, canned action acknowledgements, or planner completion shortcuts were introduced.
- Cartesia remains the separate speech-recognition/synthesis provider. Qwen does not provide audio output.
- Cloud catalog, model tiers, provider routing, plugin registration defaults, pricing, and staging voice model source configuration are aligned. This is **not** a deployment to managed Eliza Cloud or a migration of other tenants' saved settings.
- Published paid-tier pricing: $0.99/M input and $1.49/M output; paid context 131,072 and output 40,960 tokens. Free-tier limits differ. Source: [Cerebras Qwen docs](https://inference-docs.cerebras.ai/models/qwen-3.8-27b).

## Live evidence

| Surface / scenario | Observed result | Evidence |
| --- | --- | --- |
| Local browser chat | Generated a relevant ice-density explanation with Qwen; zero reasoning tokens | `step-1788556544006-hv82jh`; model stage 2,150 ms |
| Local Notes | Opened Notes and saved `Qwen migration QA` with the requested body | `step-1788556582097-zp9tz4`; note `note-388b59c8-2c4d-4a34-871c-67ef52d052f9` |
| Local Calendar | Opened Calendar and persisted `Qwen model QA`, Sep 5 noon–12:15 PM Eastern | `step-1788556612804-9kth5s`; queried Sep 5 calendar feed to confirm |
| Local Browser navigation | Opened example.com, with Example Domain visible | `step-1788556769204-fhuz3z` |
| Local Browser reading | Real BROWSER action; rendered reply identified the main heading as Example Domain | `step-1788556795161-k1wjjr`; Qwen model stages and successful BROWSER tool event |
| Local silent voice fixture | STT → real runtime → Cartesia PCM succeeded, one speaking start/end, no error | Session `69bb6ead-a36d-4198-be11-00b421a225b6`; transcript-final to first text 1,434 ms, then 112 ms to first audio |
| VPS silent voice fixture | Same pipeline and Qwen confirmed in trajectory, zero reasoning tokens | Session `f3fbd9f5-b898-43ed-a38b-ed682cf909fd`; transcript-final to first text 3,298 ms, then 163 ms to first audio; model stage 1,659 ms |
| VPS voice navigation fixture | Recognized “Open my calendar, please.” and emitted `/calendar` navigation plus usage | Session `d5688824-162e-4cde-8373-2e9949596c5d`; first audio 7,909 ms after transcript-final; trajectory `step-1788557175957-l37vi8` with successful VIEWS action |
| VPS browser Notes | Typed “Open notes, please.” visibly reached `https://bot.nubs.site/notes` and displayed a generated reply | `step-1788557296080-zgtxo6`; Qwen model stages, successful VIEWS action; total trajectory 14,991 ms |

Voice fixtures sent prerecorded PCM and inspected returned PCM without playing speakers. These are **not** physical microphone, speaker, Bluetooth, or Pixel acceptance tests. Their timing begins after transcript-final and does not include the user's speaking time. Direct tiny-prompt Cerebras checks from the VPS took 141–318 ms; these are not full app-turn timings.

## Known HOLDs

1. **Latency:** VPS navigation remains slow. The voice navigation model stages were 1,431 + 1,818 + 1,696 ms, retrieval 817 ms, action 102 ms, plus other runtime/delivery time. The browser Notes turn used a 41,470-token response-handler prompt. The model switch alone does not eliminate orchestration, prompt-processing, or delivery delays.
2. **Quota:** an actual local Calendar turn hit Cerebras 429s and retries. The observed key's token-per-minute limit was 150,000. Its tool stage took 17,581 ms, and fallback handling ran before successful persistence. Do not describe that turn as a clean all-Qwen or low-latency pass. No paid quota upgrade was performed.
3. **VPS browser cold loading:** the site serves a Vite development frontend and loaded a large module graph on cold entry. It eventually rendered after reload, with no recorded console errors. This is not a production-build load-performance pass.
4. **Physical acceptance:** no new Pixel artifact was built or installed and no physical audio test was performed in this migration pass. A VPS-connected client uses the updated server model, but that is not evidence of a new phone build.
5. **Managed Cloud rollout:** source is aligned, but hosted Cloud deployment and other existing agents' stored model overrides are not changed or proven.

## Verification

- Direct provider: reasoning-effort, Cerebras configuration, native tool calling, and SDK request-wire suites; typecheck and build.
- Core: pricing suite (45 tests), typecheck and Node build.
- Agent: model catalog/configuration/defaults/provider-switch suites (127 tests), cloud configuration (60 tests), typecheck.
- Cloud API: core stub suite (157 tests), chat-completions tool/reasoning validation suite (61 tests), TypeScript build.
- Cloud shared: catalog/default/model tiers (16 tests), routing surface (27), pricing/local Docker (25), inbound media (21), pricing fetch policy (3), typecheck.
- Cloud plugin: reasoning pins, native tool-call shape, and response-format suites; typecheck and Node/browser build.
- Targeted formatting and `git diff --check`.

These are focused suites, not a complete monorepo run. Offline mocked request tests prove wire contracts, while the live rows above separately prove sampled runtime behavior.

## Operator state

- Local frontend: `http://127.0.0.1:2138`; runtime: `31337`; voice gateway: `31338`.
- VPS runtime: `milady.service`; voice: `eliza-voice-gateway.service`.
- VPS persisted model configuration and service environment were backed up before mutation with suffix `.before-qwen-2026-09-04T21-20-18-180Z`.
- No credentials were committed or changed. Unrelated existing local/VPS worktree files were preserved.
- The two local Qwen QA data items remain available for inspection; existing user notes/events were not deleted.
