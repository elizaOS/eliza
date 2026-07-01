# Local model UX: one model, no picking (eliza-1)

**Status:** implementation in progress
**Issues:** [#8848](https://github.com/elizaOS/eliza/issues/8848) · [#8811](https://github.com/elizaOS/eliza/issues/8811) · [#8809](https://github.com/elizaOS/eliza/issues/8809) · [#8808](https://github.com/elizaOS/eliza/issues/8808) · [#8807](https://github.com/elizaOS/eliza/issues/8807)

## The principle

A consumer should never see a model name, a quantization, a HuggingFace repo, a
per-slot dropdown, or a routing policy. They make **one** decision — *where does
my agent think?* — and everything else is automatic:

> **Local** (private, on-device) · **Cloud** (fastest, Eliza-managed) · **Auto** (pick for me)

When they pick **Local**, they get **eliza-1** — a single, curated, all-in-one
model family that serves *every* modality (text, embeddings, speech-out,
speech-in, voice activity, vision). There is nothing to choose, search, or
assemble. When they pick **Cloud**, the same modalities route to Eliza Cloud.
**Auto** measures the device and routes per modality to whichever is better.

This document is the opposite of "surface real model selection" (#8808) and
"quant picker / HF auth UX" (#8807): those generic-model capabilities are no
longer part of the product setup path. Developer diagnostics may still inspect
external GGUF files behind explicit environment flags, but Settings, first-run,
and route defaults are curated Eliza-1 only.

## Why

The repo accreted four overlapping model-choice surfaces:
- **`RoutingMatrix`** (`packages/ui/src/components/local-inference/RoutingMatrix.tsx`,
  mounted at `ProviderSwitcher.tsx:291`) — a per-slot policy + preferred-provider
  grid across TEXT_SMALL/TEXT_LARGE/TEXT_EMBEDDING/TEXT_TO_SPEECH/TRANSCRIPTION.
- **`SlotAssignments`** — a per-slot installed-model dropdown.
- **HF / ModelScope search + download** of arbitrary GGUFs (#8808), with a quant
  picker and HF-token entry (#8807), which is now removed from product setup and
  preserved only as disabled compatibility shims / developer diagnostics.
- **The provider switcher** (Local/cloud subscriptions/keys).

A consumer faced with a 5×N routing grid, a model search box, and a quant
dropdown has already lost. Worse, the routing decision is **capability-blind**
(#8811) and the device-tier classifier is **dead code** — so the complexity buys
nothing. The simplest correct product is: **one local model, measured Auto,
everything else Advanced.**

## The one model: eliza-1

`eliza-1` is a *family*, not a single file. The consumer-facing local model is
**eliza-1 (2B)** — `eliza-1-2b`. We are **removing the 0.8B tier entirely** and
**2B is the floor** (`ELIZA_1_TIER_IDS` in
`packages/shared/src/local-inference/catalog.ts` starts at `eliza-1-2b`). Larger
tiers (4B/9B/27B) remain for servers/power-users but are **never surfaced as a
choice** to consumers — Auto/device-tier may pick a larger tier on a strong
device, silently.

One bundle, every modality (no separate downloads, no per-modality picking):

| Modality | Served by (local) | Notes |
|---|---|---|
| Text (small + large) | eliza-1 fused LLM | the same GGUF serves both slots |
| Embeddings | eliza-1 fused embed | |
| **Text-to-speech** | **Kokoro** (`ELIZA_1_VOICE_BACKENDS["eliza-1-2b"] = ["kokoro"]`) | bundled with the 2B tier |
| Transcription / STT | eliza-1 fused ASR | |
| Voice activity (VAD) | eliza-1 fused VAD | |
| Vision | eliza-1 fused vision | |

The user downloads **one thing** ("Eliza-1") and gets all six. There is no
"now also install a TTS model" step — Kokoro ships *inside* the eliza-1 local
bundle for 2B/4B.

## Status: implemented

- **First-run onboarding already does the simple choice** — a full-screen "How
  should Eliza run? · Eliza Cloud (recommended) · This device (private) ·
  Advanced", then "Where should it think? · Cloud inference · On-device". No model
  names. This is the consumer's first and main decision.
- **Settings → Models & Providers is now three purpose-grouped sections**
  (`ProviderSwitcher.tsx`), verified on desktop + mobile:
  1. **Intelligence** — the agent's brain: `Eliza Cloud` + `Local provider` chips
     and the main-reasoning model line.
  2. **Code orchestrator & workflows** — the subscription chips (Claude / ChatGPT /
     Gemini / z.ai / Kimi / DeepSeek), framed as powering coding + workflows,
     explicitly separate from the main intelligence.
  3. **Advanced** (collapsed) — custom API-key providers + small/large model
     overrides + per-slot routing.

## The settings surface

Replace the routing grid with a single **Intelligence** section:

```
┌─ Intelligence ───────────────────────────────┐
│  Where should your agent think?               │
│                                               │
│   ( ) Local      Private, on your device      │
│   (•) Cloud      Fastest · Eliza-managed      │
│   ( ) Auto       Pick the best for my device  │
│                                               │
│  Local model: Eliza-1 (2B)        [ Download ]│  ← only when Local/Auto
│   2.1 GB · runs offline · text, voice, vision │
└───────────────────────────────────────────────┘
```

- **Three radios, one model line.** No per-slot grid, no provider dropdown, no
  model search on this screen.
- **Local model line is read-only** — it always says "Eliza-1 (2B)". The only
  action is **Download** (one tap → the curated SHA-verified bundle) or
  **Downloaded ✓**.
- **Auto** shows the same eliza-1 line (it's the local half of Auto) plus a tiny
  "currently using: on-device / cloud per task" status, never a control.
- Cloud auth (sign in / API key / dev `eliza auth dev-login`) lives in its own
  **Cloud account** row, not mixed with model choice.

**Advanced (Developer mode) — collapsed by default**, keeps operational provider
controls for users who opt in:
- the `RoutingMatrix` per-slot policy grid,
- `SlotAssignments` per-slot installed-model dropdowns,
- diagnostic-only external model inventory when
  `ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN=1`.

Consumers never see it; power users flip one switch.

## Per-modality routing → one toggle + Auto (#8811)

#8811 asked for a per-modality local/cloud matrix. The consumer answer is **not a
matrix** — it's the single Local/Cloud/Auto control above, applied to all
modalities together, with **Auto** doing the per-modality decision *for* the user:

- **Auto** uses the now-wired `classifyDeviceTier()` capability signal (the
  `auto` `RoutingPolicy` added for #8811): strong device → modality runs local;
  weak device → that modality routes to cloud. This is the "measure the device
  and use on-device TTS/STT/ASR when it's strong enough" goal, with **zero UI**.
- Power users who genuinely want a per-modality matrix get the `RoutingMatrix`
  under Advanced. It is no longer the default surface.

So #8811's engine work (the `auto` policy, voice-on-the-router) stays and is what
powers **Auto**; only the *default UI* changes from a grid to one toggle.

## Install UX for the one model (#8807, consumer slice)

The consumer never touches HuggingFace. "Download" pulls the **curated eliza-1
bundle** — already resumable, SHA-verified, with live SSE progress/ETA/cancel.
The #8807 hardening that still matters for the product path is disk preflight,
retry/cancel/resume, bundle completeness, and integrity verification. There is
no HF token prompt, quant picker, generic Hub search, or arbitrary download in
consumer setup. Net install: one tap, one progress bar, done.

## How we measure what fits (the device-fit rule)

The measurement is one pure function — `selectBestEliza1Fit(freeRamGb)`
(`packages/shared/src/local-inference/device-fit.ts`), wrapped by
`selectBestEliza1FitForDevice(probe)`
(`plugins/plugin-local-inference/src/services/device-tier.ts`) which normalizes a
hardware probe to usable memory first:

- **Usable memory** — Apple-silicon: unified `totalRamGb`; discrete GPU:
  `max(vramGb, totalRamGb × 0.5)`; CPU-only: `totalRamGb × 0.5`. Mobile is capped
  at the 4B floor because the OS background-task model makes large local tiers
  unsafe no matter how much RAM the phone reports.
- **Always the biggest we can.** Tiers are sorted by RAM floor, largest first; we
  return the first whose floor fits. Every tier's `minRamGb` already includes
  the active 128k release floor under Gemma 4's stock `q8_0` KV cache, so
  "largest tier that fits" is identical to "biggest model that still gets 128k".
- **Every shrink is always on.** Weights are **TurboQuant** (the catalog `sizeGb`
  is the compressed GGUF), and the KV cache is stock **`q8_0`**. Gemma 4's MQA,
  SWA, and shared-KV geometry are already compact; the legacy QJL/PolarQuant
  head_dim=128 KV kernels do not apply to the active Gemma tiers.
- **128k is the target, context flexes only as a last resort.** When even 2B can't
  reach 128k on this device, we keep 2B and shrink the `q8_0` KV window to the
  largest that fits (KV scales ~linearly with tokens) — we never drop to a smaller
  or 0.8B model. If not even a minimal (8k) window fits, the function returns
  `null` and the modality routes to **Cloud** (AUTO).

So the device-fit answer is deterministic and consumer-invisible: the biggest
eliza-1 that fits, at 128k when possible, with TurboQuant + stock `q8_0` KV always
applied.

## Memory / fit (#8809) — invisible

#8809's memory work (LRU eviction telemetry, fit-to-RAM quant/context selection,
predictive preload) is **all backend** and *reinforces* the one-model story: with
a single known model family, "fit eliza-1 to this device" is a tractable, automatic
decision (pick the tier + quant + context that fits free RAM) rather than a user
choice. No UI; it makes Local/Auto "just work" on small devices. The consumer
never sees a quant or context-length setting.

## Removing 0.8B / 2B floor — implementation

- `ELIZA_1_TIER_IDS`, `ELIZA_1_VISION_TIER_IDS`, `ELIZA_1_MTP_TIER_IDS` start at
  `eliza-1-2b` (0.8B dropped from the catalog).
- The retired 0.8B product-path assignments and recommendations have been swept
  from recommendation ladders, configs, device-tier defaults, tests, and the
  local-model Remote catalog. Remaining mentions are historical
  provenance/evidence notes, not active recommendations.
- The device-tier "smallest tier" floor becomes 2B; weak devices that can't fit
  2B locally route that modality to **Cloud** (via Auto) instead of falling to
  0.8B.

## Implementation checklist (mapping to the issues)

1. **0.8B removal sweep** — product-path assignments and recommendations now
   start at `eliza-1-2b`; historical/provenance mentions are intentionally not
   active model choices. (#8808/#8809 adjacent)
2. **`auto` routing policy** — wire `classifyDeviceTier()` per modality (landed
   for #8811); this powers **Auto**.
3. **Consumer Intelligence section** — new Local/Cloud/Auto control; read-only
   "Eliza-1 (2B)" model line + one-tap curated download.
4. **Gate the picking surfaces** — keep `RoutingMatrix` / `SlotAssignments`
   advanced-only and remove HF search/quant/token/generic-GGUF from product
   setup. (#8808/#8807)
5. **Bundle completeness** — assert the eliza-1 2B bundle ships Kokoro + embed +
   VAD + ASR + vision so "Local" lights up every modality with one download.
6. **#8807 install hardening** — keep preflight/retry/cancel/resume/integrity for
   the curated Eliza-1 bundle; no HF-auth or quant UX in setup.
7. **#8809 backend** — fit-to-RAM + eviction telemetry stay backend; they make
   the single forced model fit small devices automatically.
