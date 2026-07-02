# #11335 — Pixel 6a on-device local chat turn through the bionic Vulkan host (VERIFIED)

End-to-end proof that the flat-model bundle staging fix (#11452 path-1 + #11505 path-2) lets the Android in-process bionic host load and serve the on-device model. Captured 2026-07-02 on the attached Pixel 6a (Tensor GS101 / Mali-G78), on a develop-based debug APK.

## The fix, running on-device

The device agent bundle carries the fix (`grep -c BIONIC_FLAT_BUNDLE files/agent/agent-bundle.js` = 2), and the fix materialized the exact bundle layout the native host globs (`eliza_pick_text_file` → `<bundle>/text/*.gguf`):

```
files/.eliza/local-inference/models/.bionic-bundles/eliza-1-2b-128k/text/
  eliza-1-2b-128k.gguf -> /data/data/ai.elizaos.app/files/.eliza/local-inference/models/eliza-1-2b-128k.gguf
```

## Real generated reply

Driven through the app's own agent transport (`window.Capacitor.Plugins.Agent.request` over CDP-over-adb, i.e. the exact path the chat UI uses), on a fresh conversation:

```
POST /api/conversations {title}          → conversation id
POST /api/conversations/<id>/messages {text:"What is the capital of Japan? One word.", channelType:"DM"}
→ status 200, 52.7 s (resident model, no reload)
→ reply: "Tokyo."
```

A correct, model-generated answer — not the pre-fix `"Sorry, I'm having a provider issue"`.

## Backend logs (bionic Vulkan host)

```
ElizaAgent: agent/arm64-v8a/libggml-vulkan.so present; delegating inference to the in-process bionic Vulkan host over UDS "eliza_bionic_infer_v1"
mobile-device-bridge: Registered capacitor-llama handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING at priority 0 (via bionic-host)
ElizaBionicInfer: GENERATE_STREAM from agent: 293 prompt chars, bundle=.../.bionic-bundles/eliza-1-2b-128k, drafter=(none)
ElizaBionicInfer: GENERATE result (resident): {"ok":true,"tokens":256,"ms":82030,"tokS":3.12,...}   ← first (cold)
ElizaBionicInfer: GENERATE_STREAM done (resident): 256 tok @ 4.88 tok/s                              ← warm
ElizaBionicInfer: EMBED from agent: 382 chars -> dim 2048                                            ← embeddings also served
```

- TEXT generate + TEXT_EMBEDDING (dim 2048) both served on-device through the Mali GPU host.
- Warm decode **~4.8 tok/s** on the Mali-G78 (thermal-throttled 6a); cold first-token includes the model load.

## Resource baseline (feeds #11352)

`dumpsys meminfo ai.elizaos.app` with the model resident on the GPU:

| metric | value |
|---|---|
| TOTAL PSS | ~2.60 GB |
| TOTAL RSS | ~2.46 GB |
| GL mtrack (Vulkan model on GPU) | ~2.25 GB |
| Native Heap | ~7 MB |

The ~2.25 GB GL-mtrack is the Q4 eliza-1-2b (1.2 GB GGUF) resident in Vulkan device memory — the dominant term, consistent with GPU offload.

## Notes

- Model used: `eliza-1-2b-128k.gguf` Q4 (1.2 GB) — the earlier-staged 4.9 GB E2B copy triggered `lowmemorykiller` on the 5.7 GB device, so it was replaced with the shipped Q4.
- The chat UI itself resets to onboarding across process restarts (tracked separately: #11506 process instability), so the turn was driven through the agent transport — the authoritative path the UI calls — rather than screen-tapping. The reply and backend logs are the proof.
