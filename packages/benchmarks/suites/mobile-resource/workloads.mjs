/**
 * Canonical mobile profiling workloads.
 *
 * A fixed synthetic script (not session traces) so runs are reproducible across
 * devices and commits — the workbench's job is regression detection, which needs
 * a stable input. Each workload declares the phases the runner drives and the
 * resource-sampling cadence used while it runs.
 *
 * Workloads map to the acceptance criteria in issue #8800:
 *   - cold-load     → cold model load: peak RSS at load, no generation.
 *   - single-turn   → one short chat: TTFT + prefill/decode tok/s, single-turn RSS.
 *   - sustained-chat→ N-turn chat: RSS-leak window + thermal-creep timeline + battery drain.
 *   - voice-loop    → full voice round-trips (tied to #8785 / #8786): voice TTFT.
 */

/** Prompts kept short + deterministic; mobile token cap is 256 (see capacitor adapter). */
const SHORT_PROMPTS = [
  "In one sentence, what is the capital of France?",
  "Reply with a single word: the opposite of hot.",
  "What is 17 plus 25? Answer with just the number.",
  "Name one primary color.",
  "Say hello.",
];

export const WORKLOADS = [
  {
    id: "cold-load",
    title: "Cold model load",
    description:
      "Load the tier's model from cold and sample peak RSS during load. No generation.",
    kind: "load-only",
    turns: 0,
    sampleIntervalMs: 500,
    // Sampling window after issuing load until the model reports ready / timeout.
    maxDurationMs: 120_000,
  },
  {
    id: "single-turn",
    title: "Single short chat",
    description:
      "One short prompt → measure TTFT, prefill/decode tok/s, and single-turn RSS.",
    kind: "chat",
    turns: 1,
    prompts: SHORT_PROMPTS.slice(0, 1),
    sampleIntervalMs: 500,
    maxDurationMs: 90_000,
  },
  {
    id: "sustained-chat",
    title: "Sustained N-turn chat",
    description:
      "A run of short turns to expose RSS leaks, thermal creep, and battery drain over a fixed window.",
    kind: "chat",
    turns: 24,
    prompts: SHORT_PROMPTS,
    sampleIntervalMs: 1000,
    maxDurationMs: 900_000,
  },
  {
    id: "idle-reclaim",
    title: "Idle inference-memory reclaim",
    description:
      "After prior workloads loaded + used the model, sit idle past the device's " +
      "inference idle-unload window (#11760) and sample RSS. The tail RSS must drop " +
      "below maxPostIdleUnloadRssMb — a regression here means the idle-unload policy " +
      "stopped reclaiming the resident model weights + KV cache and the app is back " +
      "to being lmkd's standing target. Shorten the on-device window for CI via " +
      "`adb shell setprop debug.eliza.inference.idle_unload_ms 60000` (+ app restart).",
    kind: "idle-watch",
    turns: 0,
    sampleIntervalMs: 2000,
    // Must exceed the (debug-prop-shortened) idle-unload window + one policy tick.
    maxDurationMs: 180_000,
  },
  {
    id: "voice-loop",
    title: "Full voice loop",
    description:
      "Voice round-trips (ASR → LLM → TTS) for voice TTFT + decode under the full pipeline. Tied to #8785 / #8786.",
    kind: "voice",
    turns: 6,
    prompts: SHORT_PROMPTS.slice(0, 3),
    sampleIntervalMs: 1000,
    maxDurationMs: 600_000,
    // Requires the voice pipeline to be reachable on-device; runner records
    // "skipped" with a reason when it is not, rather than fabricating numbers.
    requiresVoice: true,
  },
];

export function workloadById(id) {
  return WORKLOADS.find((w) => w.id === id) ?? null;
}

/** Default workload selection when --workloads is not passed (voice opt-in).
 * `idle-reclaim` runs last on purpose: the preceding chat workloads leave the
 * model warm, which is exactly the state the idle-unload policy must reclaim. */
export const DEFAULT_WORKLOAD_IDS = [
  "cold-load",
  "single-turn",
  "sustained-chat",
  "idle-reclaim",
];
