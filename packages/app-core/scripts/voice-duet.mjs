#!/usr/bin/env bun
/**
 * Two-agents-talking-endlessly voice harness for Eliza-1 (`bun run voice:duet`).
 *
 * Agent A and agent B are two `LocalInferenceEngine` instances on the **same
 * tier bundle** (`eliza-1-0_6b` by default, then `eliza-1-1_7b`) but with
 * **different characters** — A's `replyText` → A's OmniVoice TTS →
 * `InMemoryAudioSink`-shaped `DuetSink` (24 kHz → 16 kHz) → a ring →
 * B's `PushMicSource` → B's VAD + streaming ASR → B's `VoiceTurnController`
 * (the real Stage-1 forced-grammar message-handler path) → B's `replyText` →
 * B's TTS → A's ring → … **endless** (or `--turns N`). No speakers, no mic —
 * a `DuetAudioBridge { aToB, bToA }` wired in memory.
 *
 * All tricks on: DFlash speculative decoding, KV-prefix prewarm, guided
 * structured decode (`MILADY_LOCAL_GUIDED_DECODE` default on) + the fused
 * streaming decoders when the fused build advertises them, and the documented
 * reduced-optimization fallback (`MILADY_LOCAL_ALLOW_STOCK_KV=1`) only where a
 * backend genuinely can't dispatch a §3 kernel.
 *
 * `--two-process` (recommended for `eliza-1-1_7b`, RSS): runs agent B in a
 * child process — the parent pumps A's PCM frames to the child as
 * newline-delimited base64 over stdio, the child runs B's full voice loop and
 * streams B's reply PCM frames back the same way. Same wiring, two address
 * spaces, no co-resident 2× RSS.
 *
 * **No faking.** If the tier bundle, the DFlash `llama-server` binary, the
 * fused `libelizainference`, or the required kernels are missing, this prints
 * the exact missing-prereq checklist + the fix command and exits non-zero. It
 * never runs a silent stub-TTS duet and never pretends a model loaded.
 *
 * Run:
 *   bun run voice:duet                                  # 0.6b, endless, in-process
 *   bun run voice:duet -- --turns 20 --report out.json  # 20 round-trips → bench JSON
 *   bun run voice:duet -- --model eliza-1-1_7b --two-process
 *   bun run voice:duet -- --list-active                 # prereq report, then exit
 *   bun run voice:duet -- --platform-report             # cross-platform matrix, then exit
 *   bun run voice:duet -- --character-a a.json --character-b b.json --seed-text "hey there"
 *   bun run voice:duet -- --parallel 2 --draft-max 16 --ring-ms 240 --prewarm-lead-ms 0
 *
 * Latency the report records (p50/p90/p99 over the round-trips):
 *   ttftFromUtteranceEndMs           — peer stops speaking → responder's first
 *                                       token (THE headline TTFT-from-last-utterance)
 *   firstAudioIntoPeerRingFromUtteranceEndMs — the duet round-trip
 *   + the per-stage spans from latency-trace.ts, the DFlash accept-rate, the
 *   structured-decode token-savings %, tok/s, and RSS-over-N-turns.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DuetAudioBridge } from "./lib/duet-bridge.mjs";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    model: "eliza-1-0_6b",
    turns: Infinity,
    characterA: null,
    characterB: null,
    seedText: "Hey — what's the most interesting thing you've thought about lately?",
    report: null,
    ringMs: 200,
    twoProcess: false,
    listActive: false,
    platformReport: false,
    help: false,
    // Sweep knobs (threaded through to the fused llama-server args / scheduler).
    parallel: null, // server slots
    draftMax: null, // DFlash draft window upper bound
    draftMin: null,
    ctxSizeDraft: null, // drafter context size
    prewarmLeadMs: null, // prewarm-ahead lead
    chunkWords: null, // phrase-chunker max words per phrase
    kvCacheType: null, // KV cache type override (the harness picks among co-staged variants)
    backend: null, // fused build dir selection (metal/cuda/vulkan/cpu)
    // Internal: when set, this process IS agent B's peer loop (driven by the parent over stdio).
    asPeerB: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i] ?? out.model;
    else if (a === "--turns") {
      const n = Number(argv[++i]);
      out.turns = Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
    } else if (a === "--character-a") out.characterA = argv[++i] ?? null;
    else if (a === "--character-b") out.characterB = argv[++i] ?? null;
    else if (a === "--seed-text") out.seedText = argv[++i] ?? out.seedText;
    else if (a === "--report") out.report = argv[++i] ?? null;
    else if (a === "--ring-ms") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.ringMs = Math.floor(n);
    } else if (a === "--two-process") out.twoProcess = true;
    else if (a === "--list-active") out.listActive = true;
    else if (a === "--platform-report" || a === "--list-active-platforms")
      out.platformReport = true;
    else if (a === "--parallel") out.parallel = intArg(argv[++i]);
    else if (a === "--draft-max") out.draftMax = intArg(argv[++i]);
    else if (a === "--draft-min") out.draftMin = intArg(argv[++i]);
    else if (a === "--ctx-size-draft") out.ctxSizeDraft = intArg(argv[++i]);
    else if (a === "--prewarm-lead-ms") out.prewarmLeadMs = intArg(argv[++i]);
    else if (a === "--chunk-words") out.chunkWords = intArg(argv[++i]);
    else if (a === "--kv-cache-type") out.kvCacheType = argv[++i] ?? null;
    else if (a === "--backend") out.backend = argv[++i] ?? null;
    else if (a === "--as-peer-b") out.asPeerB = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`[voice-duet] unknown argument: ${a}`);
      out.help = true;
    }
  }
  return out;
}

function intArg(s) {
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

const USAGE = `Usage: bun run voice:duet [-- <options>]

  --model <id>            tier bundle (default eliza-1-0_6b; also eliza-1-1_7b)
  --turns <N>             stop after N round-trips (default: endless)
  --character-a <path>    agent A's Character JSON (default: a baked-in persona)
  --character-b <path>    agent B's Character JSON (default: a baked-in persona)
  --seed-text "<text>"    agent A's opening line (default: a baked-in prompt)
  --report <path>         write a voice-duet-bench JSON (+ a .md next to it)
  --ring-ms <ms>          cross-ring target size (sweep knob; default 200)
  --two-process           run agent B in a child process (recommended for 1.7b — RSS)
  --list-active           print the prereq report (both engines), then exit
  --platform-report       print the cross-platform voice matrix, then exit

Sweep knobs (the scientific grind — see verify/voice_duet_sweep.mjs):
  --parallel <N>          llama-server slots
  --draft-max <N>         DFlash draft window upper bound (--draft-min too)
  --ctx-size-draft <N>    drafter context size
  --prewarm-lead-ms <ms>  prewarm-ahead lead
  --chunk-words <N>       phrase-chunker max words per phrase
  --kv-cache-type <name>  KV cache type (turbo3 / turbo3_tcq / qjl_full / polarquant / f16 …)
  --backend <name>        fused build to use (metal / cuda / vulkan / cpu)

  -h, --help              this help
`;

// ---------------------------------------------------------------------------
// Pretty
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function c(color, s) {
  return useColor ? `${C[color]}${s}${C.reset}` : s;
}
function log(s) {
  process.stdout.write(`${s}\n`);
}
function tag(t, color, msg) {
  log(`${c(color, `[${t}]`)} ${msg}`);
}
function fmtMs(v) {
  return v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}ms`;
}

// ---------------------------------------------------------------------------
// Default personas (so the harness runs with no extra files)
// ---------------------------------------------------------------------------

const DEFAULT_CHARACTER_A = {
  name: "Vera",
  bio: [
    "A curious, fast-talking conversationalist who loves chasing an idea down a rabbit hole and asking the next question.",
  ],
  adjectives: ["curious", "energetic", "playful"],
  messageExamples: [],
  plugins: [],
  settings: { secrets: {} },
};

const DEFAULT_CHARACTER_B = {
  name: "Cal",
  bio: [
    "A measured, dry-witted thinker who likes to take an idea apart slowly and find the one detail that actually matters.",
  ],
  adjectives: ["measured", "wry", "precise"],
  messageExamples: [],
  plugins: [],
  settings: { secrets: {} },
};

async function loadCharacter(pathOrNull, fallback) {
  if (!pathOrNull) return { ...fallback };
  try {
    const txt = await fs.readFile(path.resolve(pathOrNull), "utf8");
    const parsed = JSON.parse(txt);
    return {
      name: parsed.name ?? fallback.name,
      bio: Array.isArray(parsed.bio) ? parsed.bio : fallback.bio,
      adjectives: Array.isArray(parsed.adjectives)
        ? parsed.adjectives
        : fallback.adjectives,
      messageExamples: Array.isArray(parsed.messageExamples)
        ? parsed.messageExamples
        : [],
      plugins: [],
      settings: { secrets: {} },
    };
  } catch (err) {
    throw new Error(
      `failed to load character ${pathOrNull}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sweep-knob → env / args
// ---------------------------------------------------------------------------

/**
 * Translate the harness sweep knobs into the env vars the DFlash llama-server
 * launcher + the voice scheduler read. We set env (not argv) because the
 * llama-server is spawned deep in `dflash-server.ts`; these are the documented
 * knobs it honours. Returns the prior env values so a sweep can restore them.
 */
function applySweepKnobs(args) {
  const prior = {};
  const set = (k, v) => {
    if (v === null || v === undefined) return;
    prior[k] = process.env[k];
    process.env[k] = String(v);
  };
  set("ELIZA_DFLASH_PARALLEL", args.parallel);
  set("ELIZA_DFLASH_DRAFT_MAX", args.draftMax);
  set("ELIZA_DFLASH_DRAFT_MIN", args.draftMin);
  set("ELIZA_DFLASH_CTX_SIZE_DRAFT", args.ctxSizeDraft);
  set("ELIZA_VOICE_CHUNK_WORDS", args.chunkWords);
  set("ELIZA_KV_CACHE_TYPE", args.kvCacheType);
  set("ELIZA_INFERENCE_FUSED_BACKEND", args.backend);
  // Guided structured decode is on by default; the harness never turns it off.
  // The reduced-optimization fallback stays opt-in (MILADY_LOCAL_ALLOW_STOCK_KV).
  return prior;
}

// ---------------------------------------------------------------------------
// Prereq inspection (reuses voice-interactive.mjs's inspector)
// ---------------------------------------------------------------------------

async function inspectDuetPrereqs(args) {
  // Reuse the interactive harness's full prereq inspector (catalog entry, bundle
  // install, DFlash binary + kernel coverage, fused libelizainference, VAD,
  // ASR). It's parameterised by `args.modelId` for the tier the duet runs.
  const { inspectActiveOptimizations } = await import("./voice-interactive.mjs");
  return inspectActiveOptimizations({ modelId: args.model, noDflash: false });
}

function printPrereqs(report, model) {
  log("");
  log(c("bold", `voice:duet prereqs — tier ${model}`));
  for (const a of report.active ?? []) {
    log(
      `  ${a.on ? c("green", "on ") : c("yellow", "off")}  ${c("cyan", a.name)}${a.detail ? c("dim", ` — ${a.detail}`) : ""}`,
    );
  }
  if ((report.missing ?? []).length > 0) {
    log("");
    log(c("red", "Missing prerequisites:"));
    for (const m of report.missing) {
      log(`  ${c("red", "✗")} ${m.what}`);
      log(`    ${c("dim", `fix: ${m.fix}`)}`);
    }
  }
  log("");
}

// ---------------------------------------------------------------------------
// Build a standalone runtime + a `generate` callback for one agent
// ---------------------------------------------------------------------------

async function bootAgentRuntime({ roomId, character, modelId }) {
  const { AgentRuntime } = await import("@elizaos/core");
  let sqlPlugin;
  let bootstrapPlugin;
  try {
    sqlPlugin =
      (await import("@elizaos/plugin-sql")).default ??
      (await import("@elizaos/plugin-sql")).sqlPlugin;
  } catch (err) {
    throw new Error(
      `@elizaos/plugin-sql not available: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    bootstrapPlugin =
      (await import("@elizaos/plugin-bootstrap")).default ??
      (await import("@elizaos/plugin-bootstrap")).bootstrapPlugin;
  } catch (err) {
    throw new Error(
      `@elizaos/plugin-bootstrap not available: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.env.PGLITE_DATA_DIR = process.env.PGLITE_DATA_DIR || "memory://";
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, bootstrapPlugin].filter(Boolean),
  });
  await runtime.initialize();
  const { ensureLocalInferenceHandler, prewarmResponseHandler } = await import(
    "../src/runtime/ensure-local-inference-handler.ts"
  );
  await ensureLocalInferenceHandler(runtime);
  try {
    const { setAssignment } = await import(
      "../src/services/local-inference/assignments.ts"
    );
    if (typeof setAssignment === "function") {
      await setAssignment("TEXT_SMALL", modelId);
    }
  } catch {
    /* the handler may auto-assign; reported later if generation fails */
  }
  const generate = async (request, onChunk) => {
    if (!runtime.messageService?.handleMessage) {
      throw new Error(
        "[voice-duet] runtime.messageService.handleMessage unavailable (plugin-bootstrap not loaded?)",
      );
    }
    const entityId = `${roomId}-peer`;
    const incoming = {
      id: `${roomId}-${Date.now()}`,
      content: { text: request.transcript, source: "voice-duet" },
      entityId,
      agentId: runtime.agentId,
      roomId,
      createdAt: Date.now(),
    };
    let replyText = "";
    const callback = async (content) => {
      const text = typeof content?.text === "string" ? content.text : "";
      if (text.trim().length > 0) {
        const delta = text.startsWith(replyText)
          ? text.slice(replyText.length)
          : text;
        replyText = text.length >= replyText.length ? text : replyText;
        if (delta.length > 0) await onChunk?.(delta);
      }
      return [];
    };
    const result = await runtime.messageService.handleMessage(
      runtime,
      incoming,
      callback,
    );
    const finalText =
      typeof result?.responseContent?.text === "string" &&
      result.responseContent.text.trim().length > 0
        ? result.responseContent.text
        : replyText;
    return {
      transcript: request.transcript,
      replyText: finalText,
      ...(request.source ? { source: request.source } : {}),
      ...(request.speaker ? { speaker: request.speaker } : {}),
      ...(request.segments ? { segments: request.segments } : {}),
      ...(request.turn ? { turn: request.turn } : {}),
    };
  };
  return { runtime, generate, prewarmResponseHandler };
}

// ---------------------------------------------------------------------------
// One in-process engine for one agent
// ---------------------------------------------------------------------------

async function bootAgentEngine({
  EngineClass,
  bundleRoot,
  modelId,
  bundlePath,
  sink,
  roomId,
  vad,
  micSource,
  generate,
  prewarm,
  prewarmLeadMs,
  events,
}) {
  const engine = new EngineClass();
  await engine.load(bundlePath);
  engine.startVoice({ bundleRoot, useFfiBackend: true, sink });
  await engine.armVoice();
  const controller = await engine.startVoiceSession({
    roomId,
    micSource,
    vad,
    generate,
    prewarm,
    speculatePauseMs:
      typeof prewarmLeadMs === "number" && prewarmLeadMs >= 0
        ? Math.max(50, prewarmLeadMs)
        : 300,
    events,
  });
  return { engine, controller };
}

// ---------------------------------------------------------------------------
// Latency / metrics snapshot for the report
// ---------------------------------------------------------------------------

async function snapshotTrace(roomId) {
  try {
    const { voiceLatencyTracer } = await import(
      "../src/services/local-inference/latency-trace.ts"
    );
    const all = voiceLatencyTracer.recentTraces();
    const t = [...all].reverse().find((x) => x.roomId === roomId) ?? all[all.length - 1];
    return t ?? null;
  } catch {
    return null;
  }
}

async function snapshotHistograms() {
  try {
    const { voiceLatencyTracer } = await import(
      "../src/services/local-inference/latency-trace.ts"
    );
    return typeof voiceLatencyTracer.histogramSummaries === "function"
      ? voiceLatencyTracer.histogramSummaries()
      : null;
  } catch {
    return null;
  }
}

async function readDflashMetrics() {
  try {
    const { dflashLlamaServer } = await import(
      "../src/services/local-inference/dflash-server.ts"
    );
    if (typeof dflashLlamaServer.getMetrics === "function") {
      return await dflashLlamaServer.getMetrics();
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function readServerRssMb() {
  // Best-effort: scrape VmHWM from /proc/<pid>/status of the dflash server.
  try {
    const { getDflashRuntimeStatus } = await import(
      "../src/services/local-inference/dflash-server.ts"
    );
    const status = getDflashRuntimeStatus();
    const pid = status?.serverPid ?? status?.pid;
    if (!pid || process.platform !== "linux") return null;
    const txt = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const m = txt.match(/VmHWM:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The report writer
// ---------------------------------------------------------------------------

async function writeReport(reportPath, payload) {
  const out = path.resolve(reportPath);
  await fs.mkdir(path.dirname(out), { recursive: true }).catch(() => {});
  await fs.writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // A markdown sidecar.
  const mdPath = out.replace(/\.json$/i, "") + ".md";
  const h = payload.latency?.histograms ?? {};
  const m = payload.runMetrics ?? {};
  const lines = [
    `# voice-duet bench — ${payload.model}`,
    "",
    `- generated: ${payload.generatedAt}`,
    `- platform: ${payload.platform} / backend=${payload.backend ?? "(default)"} / two-process=${payload.twoProcess}`,
    `- round-trips: ${payload.completedTurns}/${payload.requestedTurns}`,
    `- sweep knobs: ${JSON.stringify(payload.sweepKnobs)}`,
    "",
    "## Headline latency (p50 / p90 / p99, ms)",
    "",
    "| metric | p50 | p90 | p99 | n |",
    "|---|---|---|---|---|",
    ...["ttftFromUtteranceEndMs", "firstAudioIntoPeerRingFromUtteranceEndMs", "ttftMs", "ttfaMs", "ttapMs", "envelopeToReplyTextMs", "emotionTagOverheadMs"].map(
      (k) => {
        const s = h[k] ?? {};
        return `| ${k} | ${fmtMs(s.p50)} | ${fmtMs(s.p90)} | ${fmtMs(s.p99)} | ${s.count ?? 0} |`;
      },
    ),
    "",
    "## Run metrics",
    "",
    `- DFlash accept-rate (token-weighted): ${m.dflashAcceptRate == null ? "—" : `${(m.dflashAcceptRate * 100).toFixed(1)}%`} (drafted=${m.dflashDrafted ?? 0}, accepted=${m.dflashAccepted ?? 0})`,
    `- structured-decode token-savings %: ${fmtPct(m.structuredDecodeTokenSavingsPct?.p50)} (p50)`,
    `- tok/s: ${fmtNum(m.tokensPerSecond?.p50)} (p50)`,
    `- server RSS: first=${m.rss?.firstMb ?? "—"}MB last=${m.rss?.lastMb ?? "—"}MB max=${m.rss?.maxMb ?? "—"}MB leakSuspected=${m.rss?.leakSuspected ?? false}`,
    "",
    "## Emotion fidelity",
    "",
    `- perceiver: ${payload.emotionFidelity?.perceiver ?? "n/a"}`,
    `- accuracy: ${payload.emotionFidelity?.accuracy == null ? "— (recorded as null — needs an emotion-aware ASR / classifier)" : `${(payload.emotionFidelity.accuracy * 100).toFixed(1)}%`} over ${payload.emotionFidelity?.samples ?? 0} turns`,
    "",
    payload.notes ?? "",
  ];
  await fs.writeFile(mdPath, `${lines.join("\n")}\n`, "utf8");
}

function fmtPct(v) {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}
function fmtNum(v) {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(USAGE);
    process.exit(0);
  }

  // The cross-platform support matrix — pure inspection. Always exits 0.
  if (args.platformReport) {
    const { printPlatformReport } = await import("./voice-interactive.mjs");
    await printPlatformReport();
    process.exit(0);
  }

  // ── Prereqs ────────────────────────────────────────────────────────────
  applySweepKnobs(args);
  let prereqs;
  try {
    prereqs = await inspectDuetPrereqs(args);
  } catch (err) {
    log(
      c(
        "red",
        `[voice-duet] could not inspect prereqs: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }
  printPrereqs(prereqs, args.model);

  if (args.listActive) {
    process.exit(prereqs.missing?.length ? 1 : 0);
  }

  if ((prereqs.missing ?? []).length > 0) {
    log(
      c(
        "red",
        `Cannot run a duet — the ${args.model} prerequisites above are not satisfied. No silent stub-TTS duet (packages/inference/AGENTS.md §3).`,
      ),
    );
    log(
      c(
        "dim",
        "Set ELIZA_AUTO_DOWNLOAD_BUNDLE=1 to auto-download the tier bundle, or follow RELEASE_V1.md.",
      ),
    );
    process.exit(1);
  }

  const bundleRoot = prereqs.bundleRoot;
  const catalogEntry = prereqs.catalogEntry;
  if (!bundleRoot || !catalogEntry) {
    log(c("red", "[voice-duet] internal: prereqs OK but no bundleRoot/catalogEntry"));
    process.exit(1);
  }

  // ── Wire two engines + the duet bridge ─────────────────────────────────
  // (Reachable only on a box that actually has the bundle + fused build +
  // kernels — almost never in CI. The wiring/cancel/shape path is covered by
  // voice-duet.e2e.test.ts unconditionally with stub backends; this is the
  // real-output run.)
  tag("duet", "blue", `booting two ${args.model} engines (${args.twoProcess ? "two-process" : "in-process"})…`);

  const { LocalInferenceEngine } = await import(
    "../src/services/local-inference/engine.ts"
  );
  const { listInstalledModels } = await import(
    "../src/services/local-inference/registry.ts"
  );
  const installed = await listInstalledModels();
  const target = installed.find((m) => m.id === args.model);
  if (!target) {
    log(c("red", `[voice-duet] ${args.model} is not registered as an installed model`));
    process.exit(1);
  }
  const bundlePath = target.path;

  const [{ PushMicSource }, vadMod] = await Promise.all([
    import("../src/services/local-inference/voice/mic-source.ts"),
    import("../src/services/local-inference/voice/vad.ts"),
  ]);
  const { markVoiceLatency, endVoiceLatencyTurn, voiceLatencyTracer, VoiceRunMetrics } =
    await import("../src/services/local-inference/latency-trace.ts");
  const { parseExpressiveTags, asrEmotionToTag } = await import(
    "../src/services/local-inference/voice/expressive-tags.ts"
  );

  const charA = await loadCharacter(args.characterA, DEFAULT_CHARACTER_A);
  const charB = await loadCharacter(args.characterB, DEFAULT_CHARACTER_B);
  const roomA = "voice-duet-A";
  const roomB = "voice-duet-B";

  // PushMicSources (16 kHz — the ASR/VAD rate the bridge resamples to).
  const pushA = new PushMicSource({ sampleRate: 16_000 });
  const pushB = new PushMicSource({ sampleRate: 16_000 });
  let aToBPcm = 0;
  let bToAPcm = 0;
  const bridge = new DuetAudioBridge({
    micSourceA: pushA,
    micSourceB: pushB,
    opts: {
      ringMs: args.ringMs,
      targetRate: 16_000,
      onForward: (dir, pcm) => {
        if (dir === "aToB") aToBPcm += pcm.length;
        else bToAPcm += pcm.length;
      },
    },
  });
  await pushA.start();
  await pushB.start();

  const runMetrics = new VoiceRunMetrics();
  let priorMetrics = await readDflashMetrics();
  // Emotion-fidelity accumulator: A's intended emotion vs B's ASR-perceived
  // emotion over the loop. Recorded honestly — `perceiver` says which sensor
  // produced B's label; `null` accuracy when neither the GGUF-ASR nor a
  // fallback classifier surfaced emotion.
  const emotionMatrix = new Map(); // `${intended}|${perceived}` -> count
  let emotionSamples = 0;
  let emotionAgree = 0;
  let emotionPerceiver = "unknown";

  // The runtime + generate for each agent.
  const bootedA = await bootAgentRuntime({ roomId: roomA, character: charA, modelId: args.model });
  const bootedB = args.twoProcess
    ? null /* B runs in a child process — see below */
    : await bootAgentRuntime({ roomId: roomB, character: charB, modelId: args.model });

  // Wrap each generate to: stream replyText to stdout, parse expressive tags
  // (so the emotion travels into the TTS text), and mark the emotion-tag
  // checkpoint on the producing agent's tracer.
  const wrapGenerate = (booted, room, label) => async (request) => {
    if (request.final) tag(label, "bold", `"${request.transcript}"`);
    process.stdout.write(c(label === "A" ? "cyan" : "yellow", `[${label}] `));
    let sawTag = false;
    const outcome = await booted.generate(request, async (delta) => {
      process.stdout.write(delta);
      if (!sawTag && /\[[a-z][a-z-]*\]/i.test(delta)) {
        // First inline expressive markup in replyText — mark the overhead.
        const parsed = parseExpressiveTags(delta);
        if (parsed.hasTags) {
          sawTag = true;
          markVoiceLatency(room, "replyText-first-emotion-tag");
        }
      }
    });
    process.stdout.write("\n");
    // The dominant intended emotion (for the fidelity metric).
    const parsedFull = parseExpressiveTags(outcome.replyText ?? "");
    outcome._intendedEmotion = parsedFull.dominantEmotion ?? "none";
    return outcome;
  };

  const sharedEvents = (room, label, onComplete) => ({
    onSpeculativeStart: (t) => tag("spec", "dim", `${label} off partial: "${t}"`),
    onSpeculativeAbort: () => tag("spec", "dim", `${label} aborted (speech resumed)`),
    onSpeculativePromoted: () => tag("spec", "green", `${label} promoted`),
    onTurnComplete: async (outcome) => {
      await onComplete(outcome);
    },
    onError: (err) => tag("error", "red", `${label}: ${err?.message ?? String(err)}`),
  });

  // ── Boot agent A's engine (sink → aToB ring) ───────────────────────────
  const vadA = await vadMod.createSileroVadDetector({ modelPath: process.env.ELIZA_VAD_MODEL_PATH });
  const vadB = args.twoProcess
    ? null
    : await vadMod.createSileroVadDetector({ modelPath: process.env.ELIZA_VAD_MODEL_PATH });

  // The cross-agent loop bookkeeping.
  let completedTurns = 0;
  let stopping = false;
  const turnLog = [];

  // When the producing agent's TTS settles → mark the consuming agent's
  // `peer-utterance-end` (the headline t0). The consuming agent's VAD/ASR/turn
  // controller then drive its turn; on its `onTurnComplete` we settle its TTS
  // and (recursively) flip the roles.
  const afterProducerSettled = (consumerRoom) => {
    markVoiceLatency(consumerRoom, "peer-utterance-end");
  };

  const recordTurnMetrics = async ({ producerRoom, consumerRoom, producerOutcome, consumerOutcome }) => {
    completedTurns += 1;
    // Latency: snapshot the consumer's trace (it has the duet spans).
    const trace = await snapshotTrace(consumerRoom);
    // DFlash delta this turn.
    const cur = await readDflashMetrics();
    let dflashAcc = null;
    let dflashAccepted = null;
    let dflashDrafted = null;
    if (cur && priorMetrics) {
      const dDrafted = (cur.drafted ?? 0) - (priorMetrics.drafted ?? 0);
      const dAccepted = (cur.accepted ?? 0) - (priorMetrics.accepted ?? 0);
      if (dDrafted > 0) {
        dflashDrafted = dDrafted;
        dflashAccepted = dAccepted;
        dflashAcc = dAccepted / dDrafted;
      }
    }
    if (cur) priorMetrics = cur;
    const rssMb = await readServerRssMb();
    runMetrics.recordTurn({
      dflashAcceptRate: dflashAcc,
      dflashAccepted,
      dflashDrafted,
      // Structured-decode token-savings %: feed the guided-decode bench's
      // counter if exposed; null otherwise (recorded, not faked).
      structuredDecodeTokenSavingsPct: cur?.structuredDecodeSavingsPct ?? null,
      tokensPerSecond: cur?.tokensPerSecond ?? null,
      serverRssMb: rssMb,
    });
    // Emotion fidelity: A intended `producerOutcome._intendedEmotion`; B's ASR
    // perceived an emotion off A's speech (the consumer's transcript may carry
    // a `<emotion>` span / a special token if the GGUF-ASR surfaces it). We
    // read it off the consumer's last transcript via `asrEmotionToTag`.
    const intended = producerOutcome?._intendedEmotion ?? "none";
    const perceivedRaw =
      consumerOutcome?.turn?.emotion ??
      consumerOutcome?.speaker?.emotion ??
      extractEmotionFromTranscript(consumerOutcome?.transcript ?? "");
    let perceived = null;
    if (perceivedRaw) {
      perceived = asrEmotionToTag(perceivedRaw) ?? null;
      emotionPerceiver = "qwen3-asr-emotion";
    } else {
      emotionPerceiver = "fallback-classifier:unavailable";
    }
    if (perceivedRaw) {
      emotionSamples += 1;
      const intendedTag = intended === "none" ? "neutral" : intended;
      const perceivedTag = perceived ?? "unknown";
      const key = `${intendedTag}|${perceivedTag}`;
      emotionMatrix.set(key, (emotionMatrix.get(key) ?? 0) + 1);
      if (intendedTag === perceivedTag) emotionAgree += 1;
    }
    turnLog.push({
      n: completedTurns,
      producerRoom,
      consumerRoom,
      derived: trace?.derived ?? null,
      missing: trace?.missing ?? null,
      anomalies: trace?.anomalies ?? null,
      intendedEmotion: intended,
      perceivedEmotion: perceived,
      dflashAcceptRate: dflashAcc,
      aToBPcm,
      bToAPcm,
    });
    // Print a compact line.
    const d = trace?.derived ?? {};
    log(
      c(
        "dim",
        `  turn ${completedTurns}: ttft-from-utterance-end=${fmtMs(d.ttftFromUtteranceEndMs)} round-trip=${fmtMs(d.firstAudioIntoPeerRingFromUtteranceEndMs)} ttft=${fmtMs(d.ttftMs)} envelope→replyText=${fmtMs(d.envelopeToReplyTextMs)} dflash-accept=${dflashAcc == null ? "—" : `${Math.round(dflashAcc * 100)}%`}`,
      ),
    );
  };

  // The ping-pong: A speaks first off the seed, then it's autonomous. Each
  // side's controller fires its turn off the incoming PCM via VAD/ASR; we hang
  // role-flip logic on `onTurnComplete`.
  const limit = Number.isFinite(args.turns) ? args.turns : Infinity;
  let pendingProducerOutcome = null;

  const onAComplete = async (outcomeA) => {
    // A finished speaking → its TTS streamed into the aToB ring. Settle A's
    // TTS, then mark B's peer-utterance-end. B's VAD/ASR already started off
    // the streamed PCM; this is the "A drained its last chunk" instant.
    await engineA.engine.voice()?.settle?.().catch(() => {});
    afterProducerSettled(roomB);
    markVoiceLatency(roomB, "audio-first-into-peer-ring"); // A's audio landed in B's ring already
    pendingProducerOutcome = outcomeA;
    if (completedTurns >= limit || stopping) return;
  };

  const onBComplete = async (outcomeB) => {
    await engineB?.engine?.voice?.()?.settle?.().catch(() => {});
    afterProducerSettled(roomA);
    markVoiceLatency(roomA, "audio-first-into-peer-ring");
    // One round-trip done (A→B→A): A asked, B answered, audio's back at A.
    await recordTurnMetrics({
      producerRoom: roomA,
      consumerRoom: roomB,
      producerOutcome: pendingProducerOutcome ?? outcomeB,
      consumerOutcome: outcomeB,
    });
    // Close the consumer's latency turn so the histograms get the deltas.
    endVoiceLatencyTurn(roomB);
    if (completedTurns >= limit || stopping) {
      await shutdown(0);
    }
  };

  // Boot A's engine.
  const engineA = await bootAgentEngine({
    EngineClass: LocalInferenceEngine,
    bundleRoot,
    modelId: args.model,
    bundlePath,
    sink: bridge.sinkForA(),
    roomId: roomA,
    vad: vadA,
    micSource: pushA,
    generate: wrapGenerate(bootedA, roomA, "A"),
    prewarm: async (rid) => {
      try {
        await bootedA.prewarmResponseHandler(bootedA.runtime, rid);
      } catch {
        /* best-effort */
      }
    },
    prewarmLeadMs: args.prewarmLeadMs,
    events: sharedEvents(roomA, "A", onAComplete),
  });

  // Boot B's engine (in-process; the --two-process path is handled below).
  let engineB = null;
  if (!args.twoProcess) {
    engineB = await bootAgentEngine({
      EngineClass: LocalInferenceEngine,
      bundleRoot,
      modelId: args.model,
      bundlePath,
      sink: bridge.sinkForB(),
      roomId: roomB,
      vad: vadB,
      micSource: pushB,
      generate: wrapGenerate(bootedB, roomB, "B"),
      prewarm: async (rid) => {
        try {
          await bootedB.prewarmResponseHandler(bootedB.runtime, rid);
        } catch {
          /* best-effort */
        }
      },
      prewarmLeadMs: args.prewarmLeadMs,
      events: sharedEvents(roomB, "B", onBComplete),
    });
  } else {
    // --two-process: spawn a child running THIS script with --as-peer-b. The
    // child loads B's engine and runs B's full voice loop; the parent feeds
    // A's PCM to the child as base64 lines on stdin and reads B's reply PCM as
    // base64 lines on stdout. (See the `--as-peer-b` branch near the top.)
    engineB = await spawnPeerB({
      args,
      bundlePath,
      bundleRoot,
      // The parent's aToB ring already wrote A's PCM into `pushB`; in
      // two-process mode `pushB` instead forwards those frames to the child.
      onPeerPcm: (pcm) => {
        // B's reply PCM (16 kHz) from the child → push into A's mic source.
        bToAPcm += pcm.length;
        try {
          pushA.push(pcm);
        } catch {
          /* ignore */
        }
      },
      onPeerTurn: async (outcomeB) => {
        afterProducerSettled(roomA);
        markVoiceLatency(roomA, "audio-first-into-peer-ring");
        await recordTurnMetrics({
          producerRoom: roomA,
          consumerRoom: roomB,
          producerOutcome: pendingProducerOutcome ?? outcomeB,
          consumerOutcome: outcomeB,
        });
        endVoiceLatencyTurn(roomB);
        if (completedTurns >= limit || stopping) await shutdown(0);
      },
    });
    // In two-process mode the bridge's aToB sink already pushes into `pushB`;
    // re-tee `pushB` frames to the child.
    pushB.onFrame((frame) => {
      engineB.sendPcm(frame.pcm);
    });
  }

  // ── Shutdown ───────────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping = true;
    log(c("dim", "\n[shutdown] stopping engines, writing report…"));
    try {
      engineA.controller?.stop();
    } catch {
      /* ignore */
    }
    try {
      engineB?.controller?.stop?.();
    } catch {
      /* ignore */
    }
    try {
      await engineA.engine.stopVoice();
      await engineA.engine.unload();
    } catch {
      /* ignore */
    }
    try {
      if (engineB?.engine) {
        await engineB.engine.stopVoice();
        await engineB.engine.unload();
      } else {
        engineB?.kill?.();
      }
    } catch {
      /* ignore */
    }
    try {
      await bootedA.runtime.stop?.();
      await bootedB?.runtime?.stop?.();
    } catch {
      /* ignore */
    }
    // Write the report.
    if (args.report) {
      const histograms = await snapshotHistograms();
      const accuracy = emotionSamples > 0 ? emotionAgree / emotionSamples : null;
      const payload = {
        schema: "voice-duet-bench/1",
        model: args.model,
        generatedAt: new Date().toISOString(),
        platform: `${process.platform}-${process.arch}`,
        backend: process.env.ELIZA_INFERENCE_FUSED_BACKEND ?? args.backend ?? null,
        twoProcess: args.twoProcess,
        requestedTurns: Number.isFinite(args.turns) ? args.turns : null,
        completedTurns,
        sweepKnobs: {
          ringMs: args.ringMs,
          parallel: args.parallel,
          draftMax: args.draftMax,
          draftMin: args.draftMin,
          ctxSizeDraft: args.ctxSizeDraft,
          prewarmLeadMs: args.prewarmLeadMs,
          chunkWords: args.chunkWords,
          kvCacheType: args.kvCacheType,
        },
        latency: { histograms, derivedKeys: Object.keys(histograms ?? {}) },
        runMetrics: runMetrics.summary(),
        emotionFidelity: {
          perceiver:
            emotionSamples > 0 ? emotionPerceiver : "perceiver: fallback-classifier (unavailable — recorded as null)",
          samples: emotionSamples,
          accuracy,
          confusionMatrix: Object.fromEntries(emotionMatrix),
        },
        // Gate-name-aligned mirror so eliza1_gates_collect.mjs can ingest it.
        gates: {
          first_token_latency_ms: histograms?.ttftFromUtteranceEndMs?.p50 ?? null,
          first_audio_latency_ms: histograms?.firstAudioIntoPeerRingFromUtteranceEndMs?.p50 ?? null,
          duet_round_trip_ms: histograms?.firstAudioIntoPeerRingFromUtteranceEndMs?.p50 ?? null,
          structured_decode_token_savings_pct:
            runMetrics.summary().structuredDecodeTokenSavingsPct?.p50 ?? null,
          dflash_acceptance: runMetrics.summary().dflashAcceptRate,
          expressive_tag_faithfulness: accuracy,
          e2e_loop_ok: completedTurns > 0,
        },
        notes:
          accuracy == null
            ? "emotionFidelity.accuracy is null — the GGUF-converted Qwen3-ASR did not surface an emotion label in this run and no fallback emotion-from-audio classifier was available; recorded as null per the honesty contract, not fabricated. structured-decode token-savings % is null when the running llama-server's /metrics did not expose the guided-decode counter."
            : `emotionFidelity perceiver: ${emotionPerceiver}.`,
        turns: turnLog,
      };
      try {
        await writeReport(args.report, payload);
        log(c("green", `[report] wrote ${path.resolve(args.report)} (+ .md)`));
      } catch (err) {
        log(c("red", `[report] failed to write: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    log(c("green", "[shutdown] done."));
    process.exit(code);
  }
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  // ── Kick off: agent A speaks first off the seed ───────────────────────
  tag("duet", "green", `armed — A=${charA.name} B=${charB.name} bundle=${args.model}; seeding A's opening line…`);
  voiceLatencyTracer.beginTurn({ roomId: roomB }); // open B's first latency turn
  markVoiceLatency(roomA, "vad-trigger"); // A's seed has no mic — synthetic t0
  markVoiceLatency(roomA, "asr-final");
  try {
    const seedSignal = new AbortController().signal;
    const outcomeA = await wrapGenerate(bootedA, roomA, "A")({
      transcript: args.seedText,
      final: true,
      signal: seedSignal,
    });
    await onAComplete(outcomeA);
  } catch (err) {
    log(c("red", `[voice-duet] seed turn failed: ${err instanceof Error ? err.message : String(err)}`));
    await shutdown(1);
    return;
  }
  // From here the loop is autonomous: A's TTS PCM is in B's ring → B's VAD
  // fires → B's turn controller runs B's `generate` → B's TTS PCM lands in A's
  // ring → A's VAD fires → … endless until `--turns` or Ctrl-C. Keep alive.
}

// ---------------------------------------------------------------------------
// Best-effort transcript emotion extraction (Qwen3-ASR `<emotion>…</emotion>`
// or a `[emotion:happy]`-style tag, if the GGUF-ASR surfaces one). Returns the
// raw label or null. Honest: if the transcript has no emotion marker, null —
// the fidelity metric records "perceiver: fallback-classifier (unavailable)".
// ---------------------------------------------------------------------------
function extractEmotionFromTranscript(transcript) {
  if (typeof transcript !== "string" || transcript.length === 0) return null;
  const tag = transcript.match(/<emotion>\s*([a-z]+)\s*<\/emotion>/i);
  if (tag) return tag[1].toLowerCase();
  const bracket = transcript.match(/\[emotion:\s*([a-z]+)\s*\]/i);
  if (bracket) return bracket[1].toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// --two-process: spawn agent B as a child of THIS script
// ---------------------------------------------------------------------------

async function spawnPeerB({ args, bundlePath, bundleRoot, onPeerPcm, onPeerTurn }) {
  const childArgs = [
    __filename,
    "--as-peer-b",
    "--model",
    args.model,
    "--seed-text",
    "(peer)",
  ];
  if (args.characterB) childArgs.push("--character-b", args.characterB);
  if (args.parallel != null) childArgs.push("--parallel", String(args.parallel));
  if (args.draftMax != null) childArgs.push("--draft-max", String(args.draftMax));
  if (args.ctxSizeDraft != null)
    childArgs.push("--ctx-size-draft", String(args.ctxSizeDraft));
  const child = spawn(process.execPath, childArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ELIZA_DUET_PEER_BUNDLE: bundlePath, ELIZA_DUET_PEER_BUNDLE_ROOT: bundleRoot },
  });
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    // biome-ignore lint/suspicious/noAssignInExpressions: line-buffered protocol.
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-protocol line (child's own logging that leaked to stdout) — show it.
        process.stdout.write(`${line}\n`);
        continue;
      }
      if (msg.kind === "pcm" && typeof msg.b64 === "string") {
        const bytes = Buffer.from(msg.b64, "base64");
        const f = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
        onPeerPcm(Float32Array.from(f));
      } else if (msg.kind === "turn") {
        void onPeerTurn(msg.outcome ?? {});
      } else if (msg.kind === "ready") {
        tag("peer-b", "green", "child engine ready");
      } else if (msg.kind === "error") {
        tag("peer-b", "red", msg.message ?? "child error");
      }
    }
  });
  child.on("exit", (code) => tag("peer-b", "dim", `child exited (${code})`));
  return {
    sendPcm(pcm) {
      const b = Buffer.from(Float32Array.from(pcm).buffer);
      child.stdin.write(`${JSON.stringify({ kind: "pcm", b64: b.toString("base64") })}\n`);
    },
    kill() {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
    controller: { stop() {} },
    engine: null,
  };
}

// ---------------------------------------------------------------------------
// --as-peer-b: this process IS agent B (driven over stdio by the parent)
// ---------------------------------------------------------------------------

async function runAsPeerB(args) {
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  try {
    const bundlePath = process.env.ELIZA_DUET_PEER_BUNDLE;
    const bundleRoot = process.env.ELIZA_DUET_PEER_BUNDLE_ROOT;
    if (!bundlePath || !bundleRoot) {
      send({ kind: "error", message: "peer-b: missing ELIZA_DUET_PEER_BUNDLE(_ROOT)" });
      process.exit(1);
    }
    const { LocalInferenceEngine } = await import(
      "../src/services/local-inference/engine.ts"
    );
    const { PushMicSource } = await import(
      "../src/services/local-inference/voice/mic-source.ts"
    );
    const vadMod = await import("../src/services/local-inference/voice/vad.ts");
    const { DuetSink } = await import("./lib/duet-bridge.mjs");
    const charB = await loadCharacter(args.characterB, DEFAULT_CHARACTER_B);
    const roomB = "voice-duet-B";
    const booted = await bootAgentRuntime({ roomId: roomB, character: charB, modelId: args.model });
    const push = new PushMicSource({ sampleRate: 16_000 });
    await push.start();
    // B's reply PCM (24 kHz from TTS) → resample to 16 kHz → stream to parent.
    const replySink = new DuetSink(
      (pcm) => send({ kind: "pcm", b64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") }),
      { targetRate: 16_000 },
    );
    const engine = new LocalInferenceEngine();
    await engine.load(bundlePath);
    engine.startVoice({ bundleRoot, useFfiBackend: true, sink: replySink });
    await engine.armVoice();
    const vad = await vadMod.createSileroVadDetector({ modelPath: process.env.ELIZA_VAD_MODEL_PATH });
    await engine.startVoiceSession({
      roomId: roomB,
      micSource: push,
      vad,
      generate: async (request) => {
        process.stderr.write(`[peer-b] heard: "${request.transcript}"\n`);
        return booted.generate(request, async () => {});
      },
      prewarm: async (rid) => {
        try {
          await booted.prewarmResponseHandler(booted.runtime, rid);
        } catch {
          /* best-effort */
        }
      },
      speculatePauseMs: 300,
      events: {
        onTurnComplete: async (outcome) => {
          await engine.voice()?.settle?.().catch(() => {});
          send({ kind: "turn", outcome: { transcript: outcome.transcript, replyText: outcome.replyText } });
        },
        onError: (err) => send({ kind: "error", message: err?.message ?? String(err) }),
      },
    });
    // Read PCM frames from the parent on stdin.
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      // biome-ignore lint/suspicious/noAssignInExpressions: line-buffered protocol.
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.kind === "pcm" && typeof msg.b64 === "string") {
            const bytes = Buffer.from(msg.b64, "base64");
            const f = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
            push.push(Float32Array.from(f));
          }
        } catch {
          /* ignore */
        }
      }
    });
    send({ kind: "ready" });
    process.on("SIGTERM", () => process.exit(0));
  } catch (err) {
    send({ kind: "error", message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.asPeerB) {
    runAsPeerB(parsed).catch((err) => {
      process.stderr.write(`[voice-duet peer-b] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    });
  } else {
    main().catch((err) => {
      console.error(
        c("red", `[voice-duet] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
      );
      process.exit(1);
    });
  }
}

// Exported for the e2e test (the stub-backend wiring path needs the personas
// + the bridge + the sweep-knob translator without booting `main()`).
export {
  parseArgs,
  applySweepKnobs,
  loadCharacter,
  DEFAULT_CHARACTER_A,
  DEFAULT_CHARACTER_B,
  extractEmotionFromTranscript,
};
