# Memory Arbiter — cross-plugin contract (WS1)

The **Memory Arbiter** is the single in-process owner of every model
handle in the local-inference stack (text, embedding, vision-language,
ASR, TTS, image generation). It lives in
`@elizaos/plugin-local-inference/services` and is the seam every other
plugin uses to acquire, run, and release a model.

This document is the integration contract for the plugins that will wire
into the arbiter in WS2–WS8:

- `plugin-vision` (WS2 — Qwen3-VL vision-describe)
- `plugin-image-gen` (WS3 — image generation; future plugin)
- `plugin-aosp-local-inference` (WS8 — AOSP bun:ffi backend)
- `plugin-computeruse` (WS9 — screen + OCR pipelines that may share the
  arbiter's vision-embedding cache)

If your plugin loads a model on its own, you are doing the wrong thing.
The arbiter exists so loading a vision model can unload the text model
gracefully and we don't get jetsam'd on iPhone or `lmkd`-killed on
Android.

## Why one arbiter

Before WS1, every plugin loaded its own models with no shared budget:

- `plugin-local-inference` owns text + voice GGUFs through
  `LocalInferenceEngine` + `SharedResourceRegistry`.
- `plugin-vision` loads its own TF.js / face-api models with no shared
  budget.
- `plugin-aosp-local-inference` runs its bun:ffi llama.cpp binding in
  its own world, no shared budget.

The result on a 6 GB iPhone or an 8 GB low-tier Android is the app gets
killed before the planner runs. The arbiter fixes this by owning the
eviction policy across modalities.

## The contract

### 1. Get the arbiter at boot

Your plugin's `init()` hook should pull the arbiter from the runtime:

```ts
import type {
  MemoryArbiter,
  ArbiterEvent,
} from "@elizaos/plugin-local-inference/services";

let arbiter: MemoryArbiter | null = null;

export const plugin: Plugin = {
  name: "plugin-vision",
  async init(_config, runtime) {
    const service = runtime.getService?.("localInferenceLoader") as
      | { getMemoryArbiter?: () => MemoryArbiter }
      | null;
    if (!service?.getMemoryArbiter) {
      // plugin-local-inference is not active. Your plugin must decide
      // whether to refuse to load or fall back to a non-shared loader
      // (NOT recommended — the OOM risk is real). Most plugins should
      // refuse and surface the dependency explicitly.
      logger.warn("[plugin-vision] memory-arbiter unavailable; refusing to enable vision capability");
      return;
    }
    arbiter = service.getMemoryArbiter();
    registerVisionCapability(arbiter);
  },
};
```

### 2. Register a capability handler

Each plugin registers exactly one handler per capability it owns. The
arbiter calls `load` on first acquire, `run` per request, and `unload`
when the role is evicted.

```ts
arbiter.registerCapability({
  capability: "vision-describe",        // see ArbiterCapability
  residentRole: "vision",                // RESIDENT_ROLE_PRIORITY[vision] = 20
  estimatedMb: 2_400,                    // best-effort; telemetry only
  async load(modelKey) {
    return await loadQwen3VL(modelKey);  // expensive — happens once per (capability, modelKey)
  },
  async unload(handle) {
    await handle.dispose();              // free GPU/VRAM and JS refs
  },
  async run(handle, request: VisionDescribeRequest) {
    return await handle.describe(request);
  },
});
```

**Important invariants**:

- `load` may be called concurrently with other capabilities' loads but
  the arbiter serializes per-`(capability, modelKey)`. Don't try to
  serialize yourself.
- `unload` MUST be idempotent. The arbiter will call it at most once per
  load, but a misbehaving consumer (or a shutdown path) may double-call.
- `run` MUST honour cancellation. Pass the caller's `AbortSignal`
  through if you accept one in the request.
- Do NOT keep long-lived state in `run` that survives `unload`. The
  arbiter's whole point is that it can swap your model out from under
  you.

### 3. Request work

Two ways to use the arbiter — pick the right one for your callsite:

**(a) One-shot request** — easy mode. The arbiter handles acquire,
queue, run, release.

```ts
const result = await arbiter.requestVisionDescribe<VisionDescribeRequest, VisionDescribeResult>({
  modelKey: "qwen3-vl-4b",
  payload: { imageBytes, prompt: "What's in this image?" },
});
```

**(b) Long-lived acquire** — for streaming generation, multi-turn
conversations, or anything that needs the same handle across multiple
calls.

```ts
const handle = await arbiter.acquire<Qwen3VLBackend>("vision-describe", "qwen3-vl-4b");
try {
  for await (const chunk of handle.backend.stream(request)) {
    yield chunk;
  }
} finally {
  await handle.release();
}
```

The handle is refcounted. While `refCount > 0` the arbiter will NOT
evict the role under memory pressure (the role yields its position to a
higher-priority eviction candidate). When `refCount == 0` the role
becomes evictable but stays warm; pressure or idle-eviction reclaims it.

### 4. Subscribe to events (optional)

The arbiter emits typed telemetry events. Observability layers and
diagnostic UIs subscribe via `onEvent`:

```ts
const unsubscribe = arbiter.onEvent((event: ArbiterEvent) => {
  switch (event.type) {
    case "model_load": logger.info(`loaded ${event.capability}/${event.modelKey} in ${event.loadMs}ms`); break;
    case "model_unload": logger.info(`unloaded ${event.capability}/${event.modelKey} (${event.reason})`); break;
    case "memory_pressure": logger.warn(`pressure=${event.level} source=${event.source}`); break;
    case "eviction": logger.warn(`evicted ${event.capability}/${event.modelKey} reason=${event.reason} ~${event.estimatedMb}MB`); break;
    case "capability_run": /* throughput tracking */ break;
  }
});
```

## Capability priority table

Eviction order (ascending priority — lowest evicts first) lives in
`voice/shared-resources.ts:RESIDENT_ROLE_PRIORITY`. The arbiter uses
this for both swap-on-conflict (same role, different modelKey) and
pressure-driven eviction.

| Role          | Priority | Typical capability       | Eviction cost                 |
| ------------- | -------- | ------------------------ | ----------------------------- |
| `drafter`     | 10       | DFlash speculative draft | Restart llama-server w/o -md  |
| `vision`      | 20       | `vision-describe`, `image-gen` | Unload weights, drop projector cache |
| `embedding`   | 25       | `embedding`              | Unload embedding model         |
| `vad`         | 35       | Voice VAD                 | madvise(DONTNEED) on weights  |
| `asr`         | 40       | `transcribe`             | madvise(DONTNEED) on weights  |
| `tts`         | 50       | `speak`                  | madvise(DONTNEED) on weights  |
| `text-target` | 100      | `text`                   | Unload text GGUF (never under pressure) |

Adding a new capability:

1. Pick the appropriate `ResidentModelRole` from the table above.
2. Extend `CAPABILITY_ROLE` in `memory-arbiter.ts` if you're adding a
   new `ArbiterCapability` (e.g. a future `re-ranker` capability that
   maps to `embedding` priority).
3. Document the eviction cost in this table.

## Memory pressure semantics

The arbiter receives pressure events from a `MemoryPressureSource`. The
default in `LocalInferenceService.getMemoryArbiter()` is a composite of:

- **`nodeOsPressureSource()`** — desktop polling on 5 s cadence. Uses
  `os.freemem() / os.totalmem()`. Two-level high-water marks:
  `lowWaterFraction=0.15`, `criticalWaterFraction=0.05`.

- **`capacitorPressureSource()`** — JS contract for the Capacitor native
  bridge. The native module (WS2/WS8) dispatches a level on:

  - **Android**: `ComponentCallbacks2.onTrimMemory(level)`.
    `TRIM_MEMORY_RUNNING_LOW` and `TRIM_MEMORY_BACKGROUND` → `low`;
    `TRIM_MEMORY_RUNNING_CRITICAL` and `TRIM_MEMORY_COMPLETE` →
    `critical`.

  - **iOS**: `UIApplicationDidReceiveMemoryWarningNotification` →
    `critical`. iOS does not give us a "low" warning before
    `didReceiveMemoryWarning`; the bridge MAY poll
    `os_proc_available_memory()` itself to derive a `low` level when
    available memory drops below a configurable threshold.

  The Capacitor host calls
  `localInferenceService.dispatchMobilePressure(level, freeMb?)` to
  forward the OS callback into the arbiter.

### Arbiter response

| Level      | Arbiter behaviour |
| ---------- | ----------------- |
| `nominal`  | No action; loads proceed freely. |
| `low`      | Purge expired vision-embedding cache entries; evict the lowest-priority resident role (refcount=0 only). |
| `critical` | Purge cache; evict every non-text resident role (refcount=0 only); reject new `acquire(capability, ...)` for non-text capabilities until pressure clears. |

Roles with `refCount > 0` are never evicted by pressure — the arbiter
will not yank a model out from under an active request. This is the
right answer for correctness but means a pathological case (every role
held by a leaked refcount) leaves nothing to evict. In that case the
arbiter logs a warning via `SharedResourceRegistry.evictLowestPriorityRole()`
returning null and the pressure handler returns; the OS will eventually
kill the process. This is intentional — silently dropping a held handle
would crash an in-flight request.

## Vision-embedding cache

The arbiter owns a `VisionEmbeddingCache` (LRU + TTL) for projected
vision-language tokens. Vision plugins should consult it before paying
the projector cost:

```ts
import { createHash } from "node:crypto";

function hashFrame(bytes: Uint8Array, modelFamily: string): string {
  return createHash("sha256")
    .update(modelFamily)
    .update(bytes)
    .digest("hex");
}

async function describeImage(req: VisionDescribeRequest): Promise<VisionDescribeResult> {
  const hash = hashFrame(req.imageBytes, "qwen3-vl");
  let projected = arbiter.getCachedVisionEmbedding(hash);
  if (!projected) {
    const tokens = await projector.run(req.imageBytes);
    arbiter.setCachedVisionEmbedding(hash, tokens);
    projected = { tokens: tokens.tokens, tokenCount: tokens.tokenCount, hiddenSize: tokens.hiddenSize, live: true };
  }
  return await decoder.runWithProjectedTokens(projected, req.prompt);
}
```

**Important**:

- The hash MUST include the model family identifier. The projected
  tokens are not interchangeable across families.
- The hash MUST be computed on normalized input bytes (downscaled to the
  model's input resolution, padded, channel order normalized). Two
  different JPEG encodings of the same image MUST hash to the same key.
- The cache is in-RAM only. It does not survive process restart.
- Default capacity is 32 entries; default TTL is 5 minutes. Override
  via the arbiter's `VisionEmbeddingCache` constructor if your workload
  needs it.

## What the arbiter does NOT do

- It does **not** download models, probe hardware, or render UI.
- It does **not** implement any loader. Loaders live in the plugin that
  owns the backend binding.
- It does **not** run on a worker thread. One process, one event loop.
- It does **not** evict roles with `refCount > 0`.
- It does **not** evict the `text-target` role under pressure.
- It does **not** cancel in-flight runs to make room for a swap; it
  waits for refcount to drain (with a 10 s timeout that surfaces a
  diagnostic).

## Validation status

- Unit tests cover registration, acquire/release, in-flight load
  sharing, same-role swap with refcount wait, pressure-driven eviction
  at `low`/`critical`, refcount-protected eviction, the request-queue
  error path, and shutdown. See `__tests__/memory-arbiter.test.ts`.
- The vision-embedding cache has unit tests for hit/miss, LRU
  eviction, TTL expiry, and `purgeExpired`.
- All three pressure sources have unit tests for the level transition
  table.
- The Capacitor native side is **not yet wired** (WS2 / WS8). The JS
  contract is final and stable; consumers can integrate today against
  the desktop-only pressure source and the Capacitor bridge will be
  populated transparently when the native modules ship.
- Apple Metal / CUDA GPU paths are **not validated on this host** (no
  NVIDIA GPU, no Apple Silicon). The arbiter does not contain any
  backend-specific code, so this is a downstream concern for the
  loader plugins (WS2 = Qwen3-VL, WS3 = image gen). When wiring those
  loaders, validate on a real GPU host that:
  - Loading a vision model evicts the text model gracefully (not
    via an OOM kill).
  - The projected-token cache hits across repeat frames in
    computer-use loops.
  - Pressure-triggered eviction reclaims VRAM, not just RAM.

## Migration checklist (for plugins integrating)

- [ ] Pull arbiter from runtime in `init()`; refuse to enable if absent.
- [ ] Register one `CapabilityRegistration` per capability you own.
- [ ] Replace every direct model-loader call site with
      `arbiter.requestX(...)` or `arbiter.acquire(...) + handle.release()`.
- [ ] If you own a vision projector, hash inputs and consult
      `arbiter.getCachedVisionEmbedding()` before running the projector.
- [ ] Subscribe to `arbiter.onEvent` if you need to react to
      load/eviction (rare — most consumers don't).
- [ ] Delete any private memory-pressure handling, idle-unload timers,
      or eviction state your plugin owns. The arbiter owns this now.
