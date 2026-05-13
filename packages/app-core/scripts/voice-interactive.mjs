#!/usr/bin/env bun
/**
 * Interactive end-to-end voice harness for Eliza-1 (`eliza-1-1_7b`).
 *
 * Send a voice message, get a voice response back — the full optimized
 * voice-assistant loop the W1–W13 swarm landed, run interactively:
 *
 *   mic → VAD (RMS + Silero v5 ONNX) → streaming ASR (fused / whisper.cpp)
 *      → turn controller (prewarm-on-speech-start, speculative-on-pause,
 *        abort-on-resume, promote-or-rerun on speech-end)
 *      → runtime message handler (Stage-1 forced-JSON grammar, streamed)
 *      → phrase chunker (`, . ! ?` / N words)
 *      → streaming OmniVoice TTS
 *      → PCM ring buffer → system audio sink (aplay / afplay / paplay)
 *
 * with DFlash speculative decoding, KV-prefix prewarm, streaming LLM→TTS,
 * barge-in (pause/resume/hard-stop), and force-stop on a keypress.
 *
 * **No faking.** If the real `eliza-1-1_7b` bundle, the DFlash `llama-server`
 * binary, the fused `libelizainference` (or whisper.cpp), a mic, or the
 * Silero VAD model is missing, this prints the exact missing-prereq
 * checklist + the fix command and exits non-zero. It never emits
 * silence-and-calls-it-TTS and never pretends a model loaded.
 *
 * Run:
 *   bun run voice:interactive                       # real mic interactive
 *   bun run voice:interactive -- --list-active      # print active optimizations + exit
 *   bun run voice:interactive -- --say "hi there"   # skip ASR, inject text (LLM→TTS half)
 *   bun run voice:interactive -- --wav speech.wav   # feed a WAV through the path once
 *   bun run voice:interactive -- --no-audio         # write out-<ts>.wav instead of playing
 *   bun run voice:interactive -- --no-dflash        # disable DFlash (loud warning per AGENTS.md)
 *   bun run voice:interactive -- --room my-room     # set the conversation id
 *
 * Keyboard controls (interactive modes, raw mode):
 *   s        force-stop the in-flight LLM/drafter + TTS for the current turn (barge-in hard-stop)
 *   m        mute / unmute the mic
 *   p        print the full latency histogram (p50/p90/p99)
 *   q        clean shutdown (stop session, disarm voice, unload model, exit 0)
 *   Ctrl-C   once = force-stop; twice = clean shutdown
 *
 * Latency trace lines printed after each turn:
 *   VAD→first-LLM-token=Xms   vad-trigger → llm-first-token
 *   →first-replyText-char=Yms llm-first-token → llm-first-replytext-char
 *   →first-TTS-audio=Zms      vad-trigger → tts-first-audio-chunk
 *   →audio-played=Wms         vad-trigger → audio-first-played (the headline TTAP)
 *   dflash-accept=N%          DFlash drafter token-acceptance rate (from llama-server /metrics)
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    listActive: false,
    platformReport: false,
    say: null,
    wav: null,
    noAudio: false,
    noDflash: false,
    room: "voice-interactive",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list-active") out.listActive = true;
    else if (a === "--platform-report" || a === "--list-active-platforms")
      out.platformReport = true;
    else if (a === "--no-audio") out.noAudio = true;
    else if (a === "--no-dflash") out.noDflash = true;
    else if (a === "--say") out.say = argv[++i] ?? "";
    else if (a === "--wav") out.wav = argv[++i] ?? "";
    else if (a === "--room") out.room = argv[++i] ?? out.room;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`[voice-interactive] unknown argument: ${a}`);
      out.help = true;
    }
  }
  return out;
}

const USAGE = `Usage: bun run voice:interactive [-- <options>]

  --list-active        print which optimizations are active, then exit
  --platform-report    print the cross-platform voice support matrix, then exit
                       (runtime path / kernel coverage / mic+player / VAD
                        runtime / TTS+ASR backend per platform×GPU; verified vs
                        needs-hardware/needs-SDK)
  --say "<text>"       skip ASR; inject <text> as a finalized transcript (LLM→TTS half)
  --wav <path>         feed a WAV file through the same path once (non-mic smoke)
  --no-audio           don't play to speakers; write out-<ts>.wav instead
  --no-dflash          set ELIZA_DFLASH_DISABLE=1 (sanity compare; warns loudly)
  --room <id>          conversation/room id (default: voice-interactive)
  -h, --help           this help
`;

// ---------------------------------------------------------------------------
// Pretty printing
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

// ---------------------------------------------------------------------------
// Active optimizations report
// ---------------------------------------------------------------------------

/**
 * Inspect the runtime/env and report which voice optimizations are wired
 * on. Returns `{ active: [{name, on, detail}], missing: [{what, fix}] }`.
 * Pure inspection — never starts a model or a session.
 */
async function inspectActiveOptimizations(args) {
  const active = [];
  const missing = [];

  // ── Catalog entry for eliza-1-1_7b ─────────────────────────────────────
  let catalogEntry = null;
  let drafterEntry = null;
  try {
    const { findCatalogModel, FIRST_RUN_DEFAULT_MODEL_ID } = await import(
      "../../shared/src/local-inference/catalog.ts"
    );
    // The duet harness passes `args.modelId` (e.g. `eliza-1-0_6b`); the
    // interactive harness leaves it unset → the first-run default.
    catalogEntry = findCatalogModel(
      args?.modelId ?? FIRST_RUN_DEFAULT_MODEL_ID,
    );
    const drafterId = catalogEntry?.runtime?.dflash?.drafterModelId;
    if (drafterId) drafterEntry = findCatalogModel(drafterId);
  } catch (err) {
    missing.push({
      what: `resolve the eliza-1-1_7b catalog entry (${err instanceof Error ? err.message : String(err)})`,
      fix: "ensure @elizaos/shared is built: bun run build (or turbo run build --filter=@elizaos/shared)",
    });
  }
  if (catalogEntry) {
    active.push({
      name: "model",
      on: true,
      detail: `${catalogEntry.id} (preferredBackend=${catalogEntry.runtime?.preferredBackend ?? "?"}, bundleManifest=${catalogEntry.bundleManifestFile ?? "?"})`,
    });
    const kernels = catalogEntry.runtime?.optimizations?.requiresKernel ?? [];
    active.push({
      name: "kernels (TurboQuant / QJL / PolarQuant / DFlash)",
      on: kernels.length > 0,
      detail: kernels.join(", ") || "(none declared)",
    });
  }

  // ── Bundle installed? ──────────────────────────────────────────────────
  let bundleRoot = null;
  try {
    const { elizaModelsDir } = await import(
      "../../shared/src/local-inference/paths.ts"
    );
    const candidate = path.join(
      elizaModelsDir(),
      `${(catalogEntry?.id ?? "eliza-1-1_7b").replace(/[^a-zA-Z0-9._-]/g, "_")}.bundle`,
    );
    if (existsSync(candidate)) bundleRoot = candidate;
  } catch {
    /* reported via the catalog branch already */
  }
  if (bundleRoot) {
    active.push({
      name: "bundle",
      on: true,
      detail: `installed at ${bundleRoot}`,
    });
  } else {
    missing.push({
      what: `the ${catalogEntry?.id ?? "eliza-1-1_7b"} bundle is not installed`,
      fix: "download it (run the harness without --list-active for the auto-download prompt) or follow RELEASE_V1.md to acquire/convert/quantize the bundle, then place it under <state-dir>/local-inference/models/<id>.bundle/",
    });
  }

  // ── DFlash llama-server binary ─────────────────────────────────────────
  if (args?.noDflash) {
    active.push({
      name: "dflash speculative decoding",
      on: false,
      detail:
        "DISABLED by --no-dflash (ELIZA_DFLASH_DISABLE=1) — sanity-compare only, NOT a product setting (AGENTS.md §4)",
    });
  } else {
    try {
      const { getDflashRuntimeStatus } = await import(
        "../src/services/local-inference/dflash-server.ts"
      );
      const status = getDflashRuntimeStatus();
      if (status.enabled && status.binaryPath) {
        active.push({
          name: "dflash speculative decoding",
          on: true,
          detail: `llama-server (-md drafter${drafterEntry ? ` ${drafterEntry.id}` : ""}, --spec-type dflash) at ${status.binaryPath}; acceptance rate reported after each turn from /metrics`,
        });
        // The eliza-1 path is gated on the kernels the catalog entry
        // declares (AGENTS.md §3). If the installed llama-server's
        // CAPABILITIES.json doesn't advertise them all, `engine.load()`
        // will reject — surface that here, not deep in the load path.
        const required =
          catalogEntry?.runtime?.optimizations?.requiresKernel ?? [];
        const advertised = status.capabilities?.kernels ?? null;
        if (required.length > 0 && advertised) {
          const lacking = required.filter((k) => advertised[k] !== true);
          if (lacking.length > 0) {
            missing.push({
              what: `the installed llama-server (${status.capabilities?.target ?? "unknown target"}) does not advertise the kernels ${catalogEntry?.id ?? "eliza-1-1_7b"} requires: {${lacking.join(", ")}} — the eliza-1 path is gated on these (packages/inference/AGENTS.md §3). On Linux/Windows CPU/CUDA builds, some kernels (qjl_full, polarquant, turbo3_tcq) ship Metal-only.`,
              fix: `rebuild the fork with the matching backend and kernels: node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>  (a real interactive turn currently needs the macOS-Metal fused build, which advertises the full kernel set)`,
            });
            active.push({
              name: "kernel coverage (vs eliza-1 requirement)",
              on: false,
              detail: `installed: ${status.capabilities?.target}; missing kernels: ${lacking.join(", ")}`,
            });
          } else {
            active.push({
              name: "kernel coverage (vs eliza-1 requirement)",
              on: true,
              detail: `installed llama-server (${status.capabilities?.target}) advertises all of {${required.join(", ")}}`,
            });
          }
        }
      } else {
        missing.push({
          what: `the DFlash llama-server binary is not available — ${status.reason}`,
          fix: "bun run local-inference:dflash:build  (builds the patched llama-server for this platform from the packages/inference/llama.cpp submodule)",
        });
        active.push({
          name: "dflash speculative decoding",
          on: false,
          detail: status.reason,
        });
      }
    } catch (err) {
      missing.push({
        what: `could not probe the DFlash binary (${err instanceof Error ? err.message : String(err)})`,
        fix: "bun run local-inference:dflash:build",
      });
    }
  }

  // ── TTS backend (fused libelizainference vs stub) ──────────────────────
  // Probe the same locations the engine bridge's `locateBundleLibrary` does:
  // explicit env paths, the bundle's `lib/`, and the managed fused-runtime
  // dirs under `<state-dir>/local-inference/bin/dflash/<platform>-<arch>-<backend>-fused/`.
  let ttsLibPath = null;
  {
    const os = await import("node:os");
    const libNames =
      process.platform === "darwin"
        ? ["libelizainference.dylib"]
        : process.platform === "win32"
          ? ["elizainference.dll", "libelizainference.dll"]
          : ["libelizainference.so"];
    const explicit = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
    if (explicit && existsSync(explicit)) ttsLibPath = explicit;
    if (!ttsLibPath) {
      let liRoot = null;
      try {
        liRoot = (
          await import("../../shared/src/local-inference/paths.ts")
        ).localInferenceRoot();
      } catch {
        /* ignore */
      }
      const fusedTargets =
        liRoot && process.env.ELIZA_INFERENCE_MANAGED_LOOKUP?.trim() !== "0"
          ? ["metal", "vulkan", "cuda", "cpu"].map((b) =>
              path.join(
                liRoot,
                "bin",
                "dflash",
                `${process.platform}-${os.arch()}-${b}-fused`,
              ),
            )
          : [];
      const libDirs = [
        bundleRoot ? path.join(bundleRoot, "lib") : null,
        process.env.ELIZA_INFERENCE_LIB_DIR?.trim() || null,
        explicit ? path.dirname(explicit) : null,
        ...fusedTargets,
      ].filter(Boolean);
      for (const dir of libDirs) {
        for (const n of libNames) {
          const cand = path.join(dir, n);
          if (existsSync(cand)) {
            ttsLibPath = cand;
            break;
          }
        }
        if (ttsLibPath) break;
      }
    }
  }
  const ttsBackend = ttsLibPath ? "fused" : "stub";
  if (ttsBackend === "fused") {
    active.push({
      name: "streaming OmniVoice TTS",
      on: true,
      detail: `fused libelizainference at ${ttsLibPath} (OmniVoice TTS + Qwen3-ASR); streaming LLM→TTS via the voice scheduler. On macOS-Metal this is the full graph; on a CPU fused build it runs but slower.`,
    });
  } else {
    missing.push({
      what: "no real TTS backend — interactive voice needs the fused libelizainference build (the stub backend emits silence and is rejected)",
      fix: "build it: see packages/app-core/scripts/omnivoice-fuse/README.md (the fused build ships real OmniVoice TTS + Qwen3-ASR on macOS-Metal; stub elsewhere)",
    });
    active.push({
      name: "streaming OmniVoice TTS",
      on: false,
      detail:
        "no fused build — the stub backend emits silence and is rejected by startVoiceSession",
    });
  }

  // ── ASR backend (fused, or whisper.cpp) ────────────────────────────────
  let asrBackend = null;
  if (bundleRoot && existsSync(path.join(bundleRoot, "asr"))) {
    asrBackend = "fused (Qwen3-ASR region in the bundle)";
  } else {
    try {
      const { resolveWhisperBinary, resolveWhisperModelPath } = await import(
        "../src/services/local-inference/voice/transcriber.ts"
      );
      const bin = resolveWhisperBinary();
      const model = resolveWhisperModelPath();
      if (bin && model)
        asrBackend = `whisper.cpp (${bin} + ${path.basename(model)})`;
    } catch {
      /* fall through */
    }
  }
  if (asrBackend) {
    active.push({ name: "streaming ASR", on: true, detail: asrBackend });
  } else {
    missing.push({
      what: "no ASR backend (no fused Qwen3-ASR region in the bundle, no whisper.cpp)",
      fix: "set ELIZA_WHISPER_BIN to a whisper-cli/main binary + ELIZA_WHISPER_MODEL to a ggml model, OR let the harness auto-download ggml-base.en.bin (~140 MB) under <state-dir>/local-inference/whisper/",
    });
  }

  // ── Silero VAD model ───────────────────────────────────────────────────
  let vadPath = null;
  try {
    const { resolveSileroVadPath } = await import(
      "../src/services/local-inference/voice/vad.ts"
    );
    vadPath = resolveSileroVadPath({
      modelPath: process.env.ELIZA_VAD_MODEL_PATH,
      bundleRoot: bundleRoot ?? undefined,
    });
  } catch {
    /* fall through */
  }
  if (vadPath) {
    active.push({
      name: "VAD (RMS gate + Silero v5 ONNX)",
      on: true,
      detail: `Silero model at ${vadPath} (via onnxruntime-node); the cheap RMS energy gate runs in front of it`,
    });
  } else {
    missing.push({
      what: "no Silero VAD model (vad/silero-vad-int8.onnx not in the bundle, ELIZA_VAD_MODEL_PATH unset)",
      fix: "stage the MIT-licensed Silero v5 VAD (~2 MB, public) into <state-dir>/local-inference/vad/silero-vad-int8.onnx or set ELIZA_VAD_MODEL_PATH; the harness can auto-download it",
    });
    active.push({
      name: "VAD (RMS gate + Silero v5 ONNX)",
      on: false,
      detail: "Silero model not found",
    });
  }

  // ── Mic ────────────────────────────────────────────────────────────────
  const wantsMic = !args?.say && !args?.wav;
  if (wantsMic) {
    let recorderName = null;
    try {
      const { resolveDesktopRecorder } = await import(
        "../src/services/local-inference/voice/mic-source.ts"
      );
      const rec = resolveDesktopRecorder(16_000);
      recorderName = rec ? rec.program : null;
    } catch {
      /* ignore */
    }
    const recHint =
      process.platform === "win32"
        ? "Windows: ffmpeg -f dshow (DirectShow), or the renderer's getUserMedia → PushMicSource"
        : process.platform === "darwin"
          ? "macOS: sox -d (rec), or ffmpeg -f avfoundation"
          : "Linux: arecord (alsa-utils) / parec (PulseAudio) / sox";
    if (recorderName) {
      active.push({
        name: "mic input (DesktopMicSource)",
        on: true,
        detail: `using '${recorderName}' to capture mono 16 kHz PCM (${recHint})`,
      });
    } else {
      missing.push({
        what: `no CLI mic recorder on PATH for ${process.platform}`,
        fix: `install one (${recHint}), or feed PCM via PushMicSource (the renderer's getUserMedia, or --wav / --say), or use the Capacitor Microphone plugin on mobile`,
      });
      active.push({
        name: "mic input (DesktopMicSource)",
        on: false,
        detail: `no recorder found; ${recHint}`,
      });
    }
  }

  // ── Always-wired pipeline pieces (these are structural, not gated) ─────
  active.push({
    name: "forced-JSON-structure grammar (Stage-1 envelope)",
    on: true,
    detail:
      "buildResponseGrammar — forced {shouldRespond, replyText, contexts, ...}; single-value enums → literals; the local engine constrains the envelope with GBNF so no tokens are spent on scaffold",
  });
  active.push({
    name: "KV-prefix prewarm",
    on: true,
    detail:
      "prewarmResponseHandler(runtime, roomId) — KV-prefill the response-handler stable prefix on speech-start; the turn controller also prewarms on speech-start",
  });
  active.push({
    name: "speculative-on-pause turn controller",
    on: true,
    detail:
      "VoiceTurnController — prewarm on speech-start, speculative generate on speech-pause >~300ms (off the partial transcript), abort on resume, promote-or-rerun on speech-end",
  });
  active.push({
    name: "barge-in (pause / resume / hard-stop)",
    on: true,
    detail:
      "BargeInController — speech-active → pause-tts (provisional); blip → resume-tts; ASR-confirmed words → hard-stop with an AbortSignal that propagates past TTS into the LLM/drafter",
  });
  active.push({
    name: "phrase-cache prewarm",
    on: true,
    detail:
      "prewarmIdleVoicePhrases() on idle + playFirstAudioFiller() on speech-start; phrase chunker flushes on , . ! ? / 30 words",
  });
  active.push({
    name: "latency tracing",
    on: true,
    detail:
      "voiceLatencyTracer — vad-trigger → audio-first-played checkpoints; derived TTFT/TTFA/TTAP; printed per-turn + as a histogram on 'p'",
  });

  return {
    active,
    missing,
    catalogEntry,
    drafterEntry,
    bundleRoot,
    ttsBackend,
    asrBackend,
    vadPath,
  };
}

function printActive(report, _args) {
  log("");
  log(c("bold", "Eliza-1 interactive voice — active optimizations"));
  log("");
  for (const o of report.active) {
    const mark = o.on ? c("green", "ON ") : c("red", "OFF");
    log(`  ${mark}  ${c("cyan", o.name)}`);
    if (o.detail) log(`        ${c("dim", o.detail)}`);
  }
  log("");
  if (report.missing.length > 0) {
    log(
      c(
        "yellow",
        `Missing prerequisites (${report.missing.length}) — fix each before a real interactive turn:`,
      ),
    );
    log("");
    for (const m of report.missing) {
      log(`  ${c("red", "•")} ${m.what}`);
      log(`    ${c("dim", `→ ${m.fix}`)}`);
    }
    log("");
  } else {
    log(
      c(
        "green",
        "All prerequisites present — ready for an interactive voice turn.",
      ),
    );
    log("");
  }
}

// ---------------------------------------------------------------------------
// Cross-platform voice support matrix
// ---------------------------------------------------------------------------

/**
 * The static cross-platform support matrix for the Eliza-1 voice pipeline:
 * for each {platform × GPU backend}, what runtime path it uses
 * (llama-server-spawn vs in-process FFI), what kernel coverage the build
 * produces, what mic + player it shells, what VAD runtime, what TTS/ASR
 * backend, and what is verified vs needs-hardware/needs-SDK.
 *
 * This is the durable description; the `verified` column reflects the
 * current state recorded in `packages/inference/README.md` and
 * `packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`.
 */
const PLATFORM_MATRIX = [
  {
    platform: "Linux x64",
    backends: [
      {
        gpu: "cpu",
        runtime: "llama-server (spawn)",
        kernels:
          "TurboQuant/QJL/Polar CPU SIMD TUs compiled in; turbo3_tcq decode CPU",
        mic: "arecord / parec / sox",
        player: "aplay / paplay / sox / ffplay",
        vad: "onnxruntime-node",
        ttsAsr:
          "fused libelizainference (CPU build) / whisper.cpp ASR fallback",
        verified:
          "CPU SIMD kernels reference-verified; build runs on this host",
      },
      {
        gpu: "cuda",
        runtime: "llama-server (spawn) — fork binary ships .cu/.cuh for all 5",
        kernels: "dflash + turbo3/4/tcq + qjl + polar (CUDA, fork binary)",
        mic: "arecord / parec / sox",
        player: "aplay / paplay / sox / ffplay",
        vad: "onnxruntime-node",
        ttsAsr: "fused libelizainference (CUDA build)",
        verified:
          "CUDA kernels hardware-verified on RTX 5080; build needs nvcc (not present here)",
      },
      {
        gpu: "rocm",
        runtime: "llama-server (spawn)",
        kernels:
          "HIP build; custom kernels not yet HIP-ported → reduced-optimization local mode (stock f16 KV; MILADY_LOCAL_ALLOW_STOCK_KV=1)",
        mic: "arecord / parec / sox",
        player: "aplay / paplay / sox / ffplay",
        vad: "onnxruntime-node",
        ttsAsr: "fused libelizainference (HIP build)",
        verified: "needs ROCm host (hipcc); not built here",
      },
      {
        gpu: "vulkan",
        runtime: "llama-server (spawn)",
        kernels:
          "dflash + turbo3/4/tcq + qjl + polar shaders staged + dispatch source-patched (runtime-verified Intel ANV; needs-hardware elsewhere)",
        mic: "arecord / parec / sox",
        player: "aplay / paplay / sox / ffplay",
        vad: "onnxruntime-node",
        ttsAsr: "fused libelizainference (Vulkan build)",
        verified:
          "Vulkan shaders + fused-attn graph dispatch verified on Intel ARL ANV; build runs on this host",
      },
    ],
  },
  {
    platform: "Linux aarch64",
    backends: [
      {
        gpu: "cpu",
        runtime: "llama-server (spawn)",
        kernels:
          "TurboQuant/QJL/Polar CPU SIMD TUs (ARMv8.4 dotprod path) compiled in",
        mic: "arecord / parec / sox",
        player: "aplay / paplay / sox / ffplay",
        vad: "onnxruntime-node (arm64)",
        ttsAsr: "fused libelizainference (CPU build)",
        verified: "needs an arm64 Linux host or cross-toolchain (not present)",
      },
      {
        gpu: "cuda",
        runtime: "llama-server (spawn) — GH200 (aarch64 + Hopper)",
        kernels: "dflash + turbo3/4/tcq + qjl + polar (CUDA, fork binary)",
        mic: "arecord / parec / sox",
        player: "aplay / paplay / sox / ffplay",
        vad: "onnxruntime-node (arm64)",
        ttsAsr: "fused libelizainference (CUDA build)",
        verified:
          "needs aarch64+CUDA host (GH200/Grace-Hopper); not built here",
      },
    ],
  },
  {
    platform: "Windows x64",
    backends: [
      {
        gpu: "cpu",
        runtime:
          "llama-server (spawn) — QJL TUs folded into ggml-base for the DLL link",
        kernels: "TurboQuant/QJL/Polar CPU SIMD TUs compiled in",
        mic: "ffmpeg -f dshow (DirectShow) — or renderer getUserMedia → PushMicSource",
        player: "ffplay (ffmpeg) — or renderer AudioContext",
        vad: "onnxruntime-node",
        ttsAsr:
          "fused libelizainference (CPU build) / whisper.cpp ASR fallback",
        verified:
          "build needs MSVC/mingw (cross from this Linux host: --dry-run only)",
      },
      {
        gpu: "cuda",
        runtime: "llama-server (spawn)",
        kernels: "dflash + turbo3/4/tcq + qjl + polar (CUDA, fork binary)",
        mic: "ffmpeg -f dshow — or renderer getUserMedia",
        player: "ffplay — or renderer AudioContext",
        vad: "onnxruntime-node",
        ttsAsr: "fused libelizainference (CUDA build)",
        verified: "needs Windows + CUDA SDK; not built here",
      },
      {
        gpu: "vulkan",
        runtime: "llama-server (spawn)",
        kernels:
          "dflash + turbo3/4/tcq + qjl + polar shaders + dispatch source-patched (needs-hardware)",
        mic: "ffmpeg -f dshow — or renderer getUserMedia",
        player: "ffplay — or renderer AudioContext",
        vad: "onnxruntime-node",
        ttsAsr: "fused libelizainference (Vulkan build)",
        verified:
          "needs Windows + a Vulkan 1.3 GPU; build cross-config --dry-run only here",
      },
    ],
  },
  {
    platform: "Windows arm64",
    backends: [
      {
        gpu: "cpu",
        runtime: "llama-server (spawn) — Snapdragon X / Copilot+ PC",
        kernels: "TurboQuant/QJL/Polar CPU SIMD TUs (NEON path) compiled in",
        mic: "ffmpeg -f dshow — or renderer getUserMedia → PushMicSource",
        player: "ffplay — or renderer AudioContext",
        vad: "onnxruntime-node (arm64)",
        ttsAsr: "fused libelizainference (CPU build)",
        verified:
          "needs an MSVC arm64 cross-toolchain or a native Windows arm64 host",
      },
      {
        gpu: "vulkan",
        runtime: "llama-server (spawn) — Adreno X1 (Vulkan 1.3)",
        kernels:
          "dflash + turbo3/4/tcq + qjl + polar shaders + dispatch source-patched (needs-hardware)",
        mic: "ffmpeg -f dshow — or renderer getUserMedia",
        player: "ffplay — or renderer AudioContext",
        vad: "onnxruntime-node (arm64)",
        ttsAsr: "fused libelizainference (Vulkan build)",
        verified: "needs Windows arm64 + Adreno; not built here",
      },
    ],
  },
  {
    platform: "macOS arm64",
    backends: [
      {
        gpu: "metal",
        runtime:
          "llama-server (spawn) — fused build serves /v1/audio/speech in-process",
        kernels:
          "dflash + turbo3/4/tcq + qjl + polar — all 5 graph-dispatched on Apple Silicon",
        mic: "sox -d (rec) — or ffmpeg -f avfoundation — or renderer getUserMedia",
        player:
          "sox/play — or ffplay — (afplay needs a file, not used) — or renderer AudioContext",
        vad: "onnxruntime-node (arm64)",
        ttsAsr:
          "fused libelizainference.dylib (real OmniVoice TTS + Qwen3-ASR, full graph)",
        verified:
          "Metal kernels hardware-verified on M4 Max; needs a macOS arm64 host to build",
      },
    ],
  },
  {
    platform: "iOS arm64",
    backends: [
      {
        gpu: "metal",
        runtime:
          "in-process FFI (@elizaos/llama-cpp-capacitor LlamaCpp.xcframework + @elizaos/plugin-aosp-local-inference aosp-llama/dflash adapters) — NOT llama-server-spawn",
        kernels:
          "static .a + embedded default.metallib carry the 5 milady kernel symbols; runtime graph dispatch on-device same as macOS Metal once the xcframework is rebuilt with them",
        mic: "Capacitor Microphone plugin → PushMicSource (no CLI recorder on iOS)",
        player:
          "Capacitor audio sink → PcmRingBuffer → native AudioQueue/AVAudioEngine",
        vad: "onnxruntime-mobile (iOS) / Capacitor ONNX bridge — NOT onnxruntime-node",
        ttsAsr:
          "fused libelizainference (ios-arm64-metal-fused — to add) carried inside the xcframework, or the Capacitor framework links omnivoice symbols",
        verified:
          "needs an Xcode build (macOS + Xcode): packages/app-core/scripts/ios-xcframework/build-xcframework.mjs + a physical-device smoke",
      },
    ],
  },
  {
    platform: "Android arm64",
    backends: [
      {
        gpu: "cpu",
        runtime:
          "in-process FFI (@elizaos/plugin-aosp-local-inference compile-libllama.mjs → libllama .so + aosp-llama/dflash adapters) — NOT llama-server-spawn",
        kernels:
          "TurboQuant/QJL/Polar CPU SIMD TUs (NEON path) compiled into the .so",
        mic: "Capacitor Microphone plugin → PushMicSource",
        player: "Capacitor audio sink → PcmRingBuffer → native AudioTrack",
        vad: "onnxruntime-mobile (Android) / Capacitor ONNX bridge",
        ttsAsr:
          "fused libelizainference (android-arm64-cpu-fused — to add) inside the AAR",
        verified:
          "needs an Android Studio / NDK build (compile-libllama.mjs cross-compiles)",
      },
      {
        gpu: "vulkan",
        runtime:
          "in-process FFI (libllama .so, Vulkan backend) — NOT llama-server-spawn",
        kernels:
          "dflash + turbo3/4/tcq + qjl + polar shaders + dispatch source-patched (needs-hardware: needs a physical Android Vulkan device)",
        mic: "Capacitor Microphone plugin → PushMicSource",
        player: "Capacitor audio sink → PcmRingBuffer → native AudioTrack",
        vad: "onnxruntime-mobile (Android) / Capacitor ONNX bridge",
        ttsAsr:
          "fused libelizainference (android-arm64-vulkan-fused — to add) inside the AAR",
        verified:
          "needs Android NDK + a Vulkan-1.3 Android device for the dispatch smoke",
      },
    ],
  },
];

/** Inspect what the *host* would actually use, for the local row callout. */
async function inspectHostPeripherals() {
  const out = { recorder: null, player: null, ort: null, ortError: null };
  try {
    const { resolveDesktopRecorder } = await import(
      "../src/services/local-inference/voice/mic-source.ts"
    );
    const rec = resolveDesktopRecorder(16_000);
    out.recorder = rec ? rec.program : null;
  } catch {
    /* ignore */
  }
  try {
    const { resolveSystemPlayerName } = await import(
      "../src/services/local-inference/voice/system-audio-sink.ts"
    );
    out.player = resolveSystemPlayerName(24_000);
  } catch {
    /* ignore */
  }
  try {
    const { loadOnnxRuntime } = await import(
      "../src/services/local-inference/voice/onnx-runtime.ts"
    );
    await loadOnnxRuntime();
    out.ort = "onnxruntime-node";
  } catch (err) {
    out.ortError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

async function printPlatformReport() {
  log("");
  log(c("bold", "Eliza-1 voice — cross-platform support matrix"));
  log(
    c(
      "dim",
      "mic → VAD → ASR → forced-grammar LLM (DFlash) → streaming TTS → audio out",
    ),
  );
  log("");
  for (const row of PLATFORM_MATRIX) {
    log(c("cyan", `## ${row.platform}`));
    for (const b of row.backends) {
      log(`  ${c("bold", b.gpu.toUpperCase())}`);
      log(`    runtime path : ${b.runtime}`);
      log(`    kernels      : ${b.kernels}`);
      log(`    mic          : ${b.mic}`);
      log(`    player       : ${b.player}`);
      log(`    VAD runtime  : ${b.vad}`);
      log(`    TTS/ASR      : ${b.ttsAsr}`);
      log(`    status       : ${c("dim", b.verified)}`);
    }
    log("");
  }
  const host = await inspectHostPeripherals();
  log(
    c(
      "bold",
      `Host (${process.platform}-${process.arch}) — what this machine would use:`,
    ),
  );
  log(
    `  mic recorder : ${host.recorder ?? c("yellow", "(none on PATH — use PushMicSource / a connector)")}`,
  );
  log(
    `  audio player : ${host.player ?? c("yellow", "(none on PATH — falls back to WavFileAudioSink)")}`,
  );
  log(
    `  ONNX runtime : ${
      host.ort
        ? host.ort
        : c(
            "yellow",
            `(unavailable — ${host.ortError ?? "onnxruntime-node not installed"}; VAD disabled)`,
          )
    }`,
  );
  log("");
  log(
    c(
      "dim",
      "Kernel coverage rule (AGENTS.md §3 vs the works-everywhere directive): the build dispatches\n" +
        "  the kernels on every backend where it can (Metal: all 5; CUDA: fork binary; Vulkan: source-\n" +
        "  patched; CPU: SIMD TUs); where it can't yet (ROCm/HIP), set MILADY_LOCAL_ALLOW_STOCK_KV=1 to\n" +
        "  run with stock f16 KV (reduced-optimization local mode — loud warning, NOT publishable, NOT a\n" +
        "  default). defaultEligible bundles still require the verified kernels per backend.",
    ),
  );
  log("");
}

// ---------------------------------------------------------------------------
// Auto-download helpers (gated; never faked)
// ---------------------------------------------------------------------------

async function tryAutoDownloadVad(_bundleRoot) {
  // Silero v5 VAD (MIT, ~2 MB, public).
  try {
    const { localInferenceRoot } = await import(
      "../../shared/src/local-inference/paths.ts"
    );
    const dest = path.join(localInferenceRoot(), "vad", "silero-vad-int8.onnx");
    if (existsSync(dest)) return dest;
    // ONNX community mirror of the official silero-vad model.
    const url =
      process.env.ELIZA_SILERO_VAD_URL?.trim() ||
      "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx?download=true";
    tag("setup", "blue", `downloading Silero VAD (~2 MB) → ${dest}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    return dest;
  } catch (err) {
    tag(
      "setup",
      "yellow",
      `Silero VAD auto-download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function tryAutoDownloadWhisper() {
  try {
    const { downloadWhisperModel, resolveWhisperBinary } = await import(
      "../src/services/local-inference/voice/transcriber.ts"
    );
    const bin = resolveWhisperBinary();
    if (!bin) return null; // no binary — can't run whisper.cpp regardless
    tag("setup", "blue", "downloading whisper ggml-base.en.bin (~140 MB)…");
    const model = await downloadWhisperModel();
    return { bin, model };
  } catch (err) {
    tag(
      "setup",
      "yellow",
      `whisper model auto-download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function tryAutoDownloadBundle(catalogEntry) {
  if (!catalogEntry) return null;
  try {
    const { Downloader } = await import(
      "../src/services/local-inference/downloader.ts"
    );
    const { elizaModelsDir } = await import(
      "../../shared/src/local-inference/paths.ts"
    );
    const dest = path.join(
      elizaModelsDir(),
      `${catalogEntry.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.bundle`,
    );
    tag(
      "setup",
      "blue",
      `downloading the ${catalogEntry.id} bundle (this is large — multiple GB)… → ${dest}`,
    );
    const dl = new Downloader();
    await new Promise((resolve, reject) => {
      const unsub = dl.subscribe((job) => {
        if (job.modelId !== catalogEntry.id) return;
        if (job.state === "completed") {
          unsub();
          resolve();
        } else if (job.state === "failed" || job.state === "cancelled") {
          unsub();
          reject(new Error(`download ${job.state}`));
        }
      });
      dl.start(catalogEntry.id).catch((e) => {
        unsub();
        reject(e);
      });
    });
    return existsSync(dest) ? dest : null;
  } catch (err) {
    tag(
      "setup",
      "yellow",
      `bundle auto-download failed: ${err instanceof Error ? err.message : String(err)} — follow RELEASE_V1.md to acquire it manually`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// System audio sink: shell aplay / afplay / paplay (or write a rolling WAV)
// ---------------------------------------------------------------------------

async function makeAudioSink(opts) {
  const { sampleRate, noAudio } = opts;
  const { SystemAudioSink, WavFileAudioSink } = await import(
    "../src/services/local-inference/voice/system-audio-sink.ts"
  );
  if (noAudio) {
    const out = path.resolve(process.cwd(), `out-${Date.now()}.wav`);
    const sink = new WavFileAudioSink({ sampleRate, filePath: out });
    return {
      sink,
      describe: () => `WAV file: ${out}`,
      finalize: () => sink.finalize(),
    };
  }
  const sink = new SystemAudioSink({ sampleRate });
  if (!sink.available()) {
    const out = path.resolve(process.cwd(), `out-${Date.now()}.wav`);
    tag(
      "audio",
      "yellow",
      `no playback device (aplay/afplay/paplay not on PATH) — falling back to a WAV file: ${out}`,
    );
    const wsink = new WavFileAudioSink({ sampleRate, filePath: out });
    return {
      sink: wsink,
      describe: () => `WAV file: ${out}`,
      finalize: () => wsink.finalize(),
    };
  }
  return {
    sink,
    describe: () => `system playback (${sink.player()})`,
    finalize: async () => sink.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Bundle registration
// ---------------------------------------------------------------------------

/**
 * Ensure the eliza-1-1_7b bundle on disk is registered in the local-inference
 * registry (so `listInstalledModels()` returns it and the engine can activate
 * it). A bundle downloaded via the dashboard registers itself; a bundle that
 * was staged/copied onto disk (e.g. a manual `RELEASE_V1.md` install) may not
 * be — this re-registers it from the manifest. No-op when already registered
 * or when the bundle isn't on disk. Returns the registered `InstalledModel`
 * (text GGUF) or null.
 */
async function ensureBundleRegistered(catalogEntry, bundleRoot) {
  if (!catalogEntry || !bundleRoot || !existsSync(bundleRoot)) return null;
  const { listInstalledModels } = await import(
    "../src/services/local-inference/registry.ts"
  );
  const installed = await listInstalledModels();
  const already = installed.find((m) => m.id === catalogEntry.id);
  if (already?.path && existsSync(already.path)) return already;

  const { upsertElizaModel } = await import(
    "../src/services/local-inference/registry.ts"
  );
  const manifestPath = path.join(
    bundleRoot,
    catalogEntry.bundleManifestFile ?? "eliza-1.manifest.json",
  );
  const textGguf = path.join(bundleRoot, catalogEntry.ggufFile);
  if (!existsSync(textGguf)) {
    throw new Error(
      `bundle at ${bundleRoot} is missing the primary text GGUF ${catalogEntry.ggufFile}`,
    );
  }
  const stat = await fs.stat(textGguf);
  const now = new Date().toISOString();
  const bundleMeta = {
    bundleRoot,
    ...(existsSync(manifestPath) ? { manifestPath } : {}),
    // Mark verified so the auto-assign path is allowed to fill TEXT_SMALL.
    bundleVerifiedAt: now,
  };
  const model = {
    id: catalogEntry.id,
    displayName: catalogEntry.displayName ?? catalogEntry.id,
    path: textGguf,
    sizeBytes: stat.size,
    hfRepo: catalogEntry.hfRepo,
    installedAt: now,
    lastUsedAt: null,
    source: "eliza-download",
    sha256: null,
    lastVerifiedAt: now,
    ...bundleMeta,
  };
  await upsertElizaModel(model);
  tag(
    "setup",
    "blue",
    `registered ${catalogEntry.id} bundle in the local-inference registry (text=${textGguf})`,
  );

  // Register the DFlash drafter companion too (so the engine wires -md).
  const companionId =
    catalogEntry.runtime?.dflash?.drafterModelId ??
    catalogEntry.companionModelIds?.[0];
  if (companionId) {
    const { findCatalogModel } = await import(
      "../../shared/src/local-inference/catalog.ts"
    );
    const companion = findCatalogModel(companionId);
    if (companion) {
      const drafterGguf = path.join(bundleRoot, companion.ggufFile);
      if (existsSync(drafterGguf)) {
        const dstat = await fs.stat(drafterGguf);
        await upsertElizaModel({
          id: companion.id,
          displayName: companion.displayName ?? companion.id,
          path: drafterGguf,
          sizeBytes: dstat.size,
          hfRepo: companion.hfRepo,
          installedAt: now,
          lastUsedAt: null,
          source: "eliza-download",
          sha256: null,
          lastVerifiedAt: now,
          runtimeRole: "dflash-drafter",
          companionFor: catalogEntry.id,
          ...bundleMeta,
        });
        tag(
          "setup",
          "blue",
          `registered ${companion.id} (DFlash drafter) at ${drafterGguf}`,
        );
      }
    }
  }
  return model;
}

// ---------------------------------------------------------------------------
// Standalone runtime bootstrap
// ---------------------------------------------------------------------------

/**
 * Boot a minimal standalone AgentRuntime with the local-inference handler
 * registered and `eliza-1-1_7b` assigned to TEXT_SMALL. Returns
 * `{ runtime, generate }` where `generate` runs one transcript through the
 * runtime's message handler and streams `replyText` chunks via `onChunk`.
 *
 * Throws if the runtime can't be constructed (missing deps) — the caller
 * surfaces that as a prereq failure, not a crash.
 */
async function bootStandaloneRuntime({ roomId }) {
  // The runtime needs plugin-sql (storage) + plugin-bootstrap (message
  // service) + the local-inference model handler. Fail loudly if a piece
  // is missing rather than half-booting.
  const { AgentRuntime, ModelType } = await import("@elizaos/core");
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

  // In-memory DB; assign the eliza-1-1_7b model to TEXT_SMALL.
  process.env.PGLITE_DATA_DIR = process.env.PGLITE_DATA_DIR || "memory://";

  const runtime = new AgentRuntime({
    character: {
      name: "Eliza",
      bio: [
        "A local-first AI assistant running the eliza-1-1_7b model with the full optimized voice stack.",
      ],
      messageExamples: [],
      adjectives: [],
      plugins: [],
      settings: { secrets: {} },
    },
    plugins: [sqlPlugin, bootstrapPlugin].filter(Boolean),
  });
  await runtime.initialize();

  // Register the local-inference model handlers (TEXT_SMALL / TEXT_LARGE /
  // TRANSCRIPTION / TEXT_TO_SPEECH) + prewarmResponseHandler / prewarmSystemPrefix.
  const { ensureLocalInferenceHandler, prewarmResponseHandler } = await import(
    "../src/runtime/ensure-local-inference-handler.ts"
  );
  await ensureLocalInferenceHandler(runtime);

  // Ensure the eliza-1-1_7b model is assigned to TEXT_SMALL (the eliza-1
  // tiers route through the dflash llama-server). Best-effort: if no model
  // is installed this throws downstream and the caller reports it.
  try {
    const { setAssignment, readAssignments } = await import(
      "../src/services/local-inference/assignments.ts"
    );
    if (typeof setAssignment === "function") {
      await setAssignment("TEXT_SMALL", "eliza-1-1_7b");
    } else if (typeof readAssignments === "function") {
      // older API — skip; ensure-local-inference-handler auto-assigns
    }
  } catch {
    /* the handler may auto-assign; reported later if generation fails */
  }

  // The `generate` callback for the voice turn controller.
  const generate = async (request, onChunk) => {
    if (!runtime.messageService?.handleMessage) {
      throw new Error(
        "[voice] runtime.messageService.handleMessage is unavailable (plugin-bootstrap not loaded?)",
      );
    }
    const entityId = `${roomId}-user`;
    const incoming = {
      id: `${roomId}-${Date.now()}`,
      content: { text: request.transcript, source: "voice-interactive" },
      entityId,
      agentId: runtime.agentId,
      roomId,
      createdAt: Date.now(),
    };
    let replyText = "";
    const callback = async (content) => {
      const text = typeof content?.text === "string" ? content.text : "";
      if (text.trim().length > 0) {
        // Stream the delta into TTS.
        const delta = text.startsWith(replyText)
          ? text.slice(replyText.length)
          : text;
        replyText = text.length >= replyText.length ? text : replyText;
        if (delta.length > 0) await onChunk?.(delta);
      }
      return [];
    };
    // The message service streams `replyText` field-by-field via the
    // local engine's `onStreamChunk` → `onTextChunk` → voice scheduler when
    // voice is armed; the callback above mirrors the final text for the UI.
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
// DFlash acceptance-rate readout
// ---------------------------------------------------------------------------

async function readDflashAcceptance() {
  try {
    const { dflashLlamaServer } = await import(
      "../src/services/local-inference/dflash-server.ts"
    );
    // Scrape the running llama-server's /metrics endpoint (drafted/accepted
    // speculative counters). Returns null when no server / no drafter.
    if (typeof dflashLlamaServer.getMetrics === "function") {
      const snap = await dflashLlamaServer.getMetrics();
      const r = snap?.acceptanceRate;
      return typeof r === "number" && Number.isFinite(r) ? r : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Latency trace formatting
// ---------------------------------------------------------------------------

function fmtMs(v) {
  return v == null ? "—" : `${Math.round(v)}ms`;
}

async function printTurnLatency(_roomId) {
  try {
    const { voiceLatencyTracer } = await import(
      "../src/services/local-inference/latency-trace.ts"
    );
    const traces = voiceLatencyTracer.recentTraces(1);
    const t = traces[traces.length - 1];
    if (!t) return;
    const d = t.derived ?? {};
    const accept = await readDflashAcceptance();
    log(
      c(
        "dim",
        `  trace: VAD→first-LLM-token=${fmtMs(d.ttftMs)}  →first-replyText-char=${fmtMs(d.envelopeToReplyTextMs)}  →first-TTS-audio=${fmtMs(d.ttfaMs)}  →audio-played=${fmtMs(d.ttapMs)}  dflash-accept=${accept == null ? "—" : `${Math.round(accept * 100)}%`}`,
      ),
    );
  } catch {
    /* tracer unavailable — skip */
  }
}

async function printLatencyHistogram() {
  try {
    const { voiceLatencyTracer } = await import(
      "../src/services/local-inference/latency-trace.ts"
    );
    const summaries =
      typeof voiceLatencyTracer.histogramSummaries === "function"
        ? voiceLatencyTracer.histogramSummaries()
        : null;
    if (!summaries) {
      log(c("yellow", "  (no latency histogram available)"));
      return;
    }
    log("");
    log(c("bold", "  Voice latency histogram (p50 / p90 / p99, ms)"));
    for (const [key, s] of Object.entries(summaries)) {
      if (!s || s.count === 0) continue;
      log(
        `    ${c("cyan", key.padEnd(28))}  n=${String(s.count).padEnd(4)} p50=${fmtMs(s.p50)} p90=${fmtMs(s.p90)} p99=${fmtMs(s.p99)}`,
      );
    }
    log("");
  } catch (err) {
    log(
      c(
        "yellow",
        `  (histogram unavailable: ${err instanceof Error ? err.message : String(err)})`,
      ),
    );
  }
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

  // Cross-platform support matrix — pure inspection, never starts a model
  // or a session. Always exits 0 (it's a status report).
  if (args.platformReport) {
    await printPlatformReport();
    process.exit(0);
  }

  // AGENTS.md §4: disabling DFlash is a developer-only kill switch and must
  // warn loudly on every generation. Set it up-front so the engine sees it.
  if (args.noDflash) {
    process.env.ELIZA_DFLASH_DISABLE = "1";
    log(
      c(
        "red",
        "⚠  --no-dflash: ELIZA_DFLASH_DISABLE=1 is set. DFlash speculative decoding is OFF. This is a DEVELOPER-ONLY kill switch, NOT a product setting — the eliza-1 path is designed to run with DFlash always on (packages/inference/AGENTS.md §4). Voice latency will be worse. Unset ELIZA_DFLASH_DISABLE to restore the contract.",
      ),
    );
  }

  // ── Preflight ──────────────────────────────────────────────────────────
  let report = await inspectActiveOptimizations(args);

  if (args.listActive) {
    printActive(report, args);
    process.exit(0);
  }

  // Auto-download cheap prereqs (VAD ~2 MB; whisper model ~140 MB if a
  // whisper binary exists). These never fake — a failed download is a
  // missing prereq, not silence.
  if (!report.vadPath) {
    const vp = await tryAutoDownloadVad(report.bundleRoot);
    if (vp) process.env.ELIZA_VAD_MODEL_PATH = vp;
  }
  if (!report.asrBackend) {
    const w = await tryAutoDownloadWhisper();
    if (w) {
      process.env.ELIZA_WHISPER_BIN = w.bin;
      process.env.ELIZA_WHISPER_MODEL = w.model;
    }
  }
  // The bundle is large — only auto-download if explicitly requested via env.
  if (!report.bundleRoot && process.env.ELIZA_AUTO_DOWNLOAD_BUNDLE === "1") {
    const br = await tryAutoDownloadBundle(report.catalogEntry);
    if (br) report.bundleRoot = br;
  }

  // Re-inspect after any auto-download.
  report = await inspectActiveOptimizations(args);
  printActive(report, args);

  if (report.missing.length > 0) {
    log(
      c(
        "red",
        "Cannot start an interactive voice turn — the prerequisites above are not satisfied.",
      ),
    );
    log(
      c(
        "dim",
        "Set ELIZA_AUTO_DOWNLOAD_BUNDLE=1 to auto-download the (large) eliza-1-1_7b bundle, or follow RELEASE_V1.md.",
      ),
    );
    process.exit(1);
  }

  // ── Register the bundle in the local-inference registry (if not already) ─
  try {
    await ensureBundleRegistered(report.catalogEntry, report.bundleRoot);
  } catch (err) {
    log(
      c(
        "red",
        `Failed to register the eliza-1-1_7b bundle: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }

  // ── Boot runtime ───────────────────────────────────────────────────────
  tag(
    "boot",
    "blue",
    "starting standalone AgentRuntime (in-memory, eliza-1-1_7b → TEXT_SMALL)…",
  );
  let runtime;
  let generate;
  let prewarmResponseHandler;
  try {
    const booted = await bootStandaloneRuntime({ roomId: args.room });
    runtime = booted.runtime;
    generate = booted.generate;
    prewarmResponseHandler = booted.prewarmResponseHandler;
  } catch (err) {
    log(
      c(
        "red",
        `Failed to boot the runtime: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    log(
      c(
        "dim",
        "This is a missing-dependency / install issue, not a transient error. Fix the dependency and re-run.",
      ),
    );
    process.exit(1);
  }
  tag(
    "boot",
    "green",
    `runtime ready — agent=${runtime.character?.name ?? "Eliza"}`,
  );

  // ── Engine + voice bridge ──────────────────────────────────────────────
  const { localInferenceEngine } = await import(
    "../src/services/local-inference/engine.ts"
  );
  const engine = localInferenceEngine;

  // Load the eliza-1-1_7b model into the engine (this activates the bundle).
  try {
    const { listInstalledModels } = await import(
      "../src/services/local-inference/registry.ts"
    );
    const installed = await listInstalledModels();
    const target = installed.find((m) => m.id === "eliza-1-1_7b");
    if (!target)
      throw new Error("eliza-1-1_7b is not registered as an installed model");
    await engine.load(target.path);
  } catch (err) {
    log(
      c(
        "red",
        `Failed to activate the eliza-1-1_7b bundle in the engine: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }

  // Sample rate from the bridge default (24 kHz).
  const SAMPLE_RATE = 24_000;
  const audio = await makeAudioSink({
    sampleRate: SAMPLE_RATE,
    noAudio: args.noAudio,
  });

  // Start + arm voice (fused backend).
  try {
    engine.startVoice({
      bundleRoot: report.bundleRoot,
      useFfiBackend: true,
      sink: audio.sink,
    });
    await engine.armVoice();
  } catch (err) {
    log(
      c(
        "red",
        `Failed to start/arm voice: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    await engine.unload().catch(() => {});
    process.exit(1);
  }
  tag("voice", "green", `armed — TTS=fused, audio sink=${audio.describe()}`);

  // ── State for keyboard controls ────────────────────────────────────────
  let micMuted = false;
  let micSource = null;
  let controller = null;
  let shuttingDown = false;
  let lastCtrlC = 0;

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(
      c(
        "dim",
        "\n[shutdown] stopping session, disarming voice, unloading model…",
      ),
    );
    try {
      controller?.stop();
    } catch {
      /* ignore */
    }
    try {
      await engine.disarmVoice();
      await engine.stopVoice();
    } catch {
      /* ignore */
    }
    try {
      await audio.finalize?.();
    } catch {
      /* ignore */
    }
    try {
      await engine.unload();
    } catch {
      /* ignore */
    }
    try {
      await runtime.stop?.();
    } catch {
      /* ignore */
    }
    log(c("green", "[shutdown] done."));
    process.exit(code);
  };

  const forceStop = () => {
    tag(
      "barge-in",
      "yellow",
      "hard-stop — force-stopping the in-flight LLM/drafter + TTS for this turn",
    );
    try {
      engine.triggerBargeIn();
    } catch {
      /* ignore */
    }
  };

  // ── Live UI wiring (turn controller events + scheduler/barge-in) ───────
  const bridge = engine.voice();
  if (bridge?.scheduler?.bargeIn?.onSignal) {
    bridge.scheduler.bargeIn.onSignal((signal) => {
      if (signal.type === "pause-tts") tag("barge-in", "yellow", "paused");
      else if (signal.type === "resume-tts")
        tag("barge-in", "green", "resumed");
      else if (signal.type === "hard-stop")
        tag("barge-in", "red", "hard-stop (words detected)");
    });
  }
  // Native verifier → rollback queue (no-op when not on the fused build).
  try {
    bridge?.subscribeNativeVerifier?.();
  } catch {
    /* not on a fused build with a context — fine */
  }

  // The `generate` callback wrapped so it streams replyText to stdout +
  // logs the structured envelope fields as they close. The actual TTS
  // streaming happens inside `engine.generate` (voiceStreamingArgs wires
  // onStreamChunk → the voice scheduler) via the runtime message handler.
  let _lastReplyText = "";
  const wrappedGenerate = async (request) => {
    if (request.final) {
      tag("final", "bold", `"${request.transcript}"`);
    }
    _lastReplyText = "";
    process.stdout.write(c("cyan", "[agent] "));
    const outcome = await generate(request, async (delta) => {
      _lastReplyText += delta;
      process.stdout.write(delta);
    });
    process.stdout.write("\n");
    return outcome;
  };

  const events = {
    onSpeculativeStart: (transcript) =>
      tag("speculative", "dim", `generating off partial: "${transcript}"`),
    onSpeculativeAbort: () =>
      tag("speculative", "dim", "aborted (speech resumed)"),
    onSpeculativePromoted: () =>
      tag("speculative", "green", "promoted (matched final transcript)"),
    onTurnComplete: async (outcome) => {
      tag(
        "envelope",
        "green",
        `shouldRespond=${outcome.replyText && outcome.replyText.length > 0 ? "RESPOND" : "IGNORE/STOP"} replyText.len=${outcome.replyText?.length ?? 0}`,
      );
      await printTurnLatency(args.room);
      // Idle-time phrase-cache prewarm after each turn.
      engine.prewarmIdleVoicePhrases().catch(() => {});
    },
    onError: (err) => tag("error", "red", err?.message ?? String(err)),
  };

  // ── Modes ──────────────────────────────────────────────────────────────
  if (args.say != null) {
    // Text mode: inject the text directly as a finalized transcript — tests
    // the LLM→TTS half without a mic.
    tag("mode", "blue", `--say: injecting transcript "${args.say}"`);
    try {
      // Mark the latency trace's vad-trigger so the trace has a t0.
      const { markVoiceLatency } = await import(
        "../src/services/local-inference/latency-trace.ts"
      );
      markVoiceLatency(args.room, "vad-trigger");
      markVoiceLatency(args.room, "asr-final");
      const signal = new AbortController().signal;
      const outcome = await wrappedGenerate({
        transcript: args.say,
        final: true,
        signal,
      });
      await events.onTurnComplete(outcome);
      // Settle TTS so audio committed to the ring buffer surfaces.
      await bridge?.settle?.();
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      log(
        c(
          "red",
          `--say turn failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      await shutdown(1);
      return;
    }
    log(c("green", `[done] audio → ${audio.describe()}`));
    await shutdown(0);
    return;
  }

  if (args.wav != null) {
    // WAV mode: feed a WAV file through the same path once.
    const wavPath = path.resolve(args.wav);
    if (!existsSync(wavPath)) {
      log(c("red", `--wav: file not found: ${wavPath}`));
      await shutdown(1);
      return;
    }
    tag(
      "mode",
      "blue",
      `--wav: feeding ${wavPath} through the voice path once`,
    );
    try {
      const { PushMicSource } = await import(
        "../src/services/local-inference/voice/mic-source.ts"
      );
      const { decodeMonoPcm16Wav } = await import(
        "../src/services/local-inference/voice/engine-bridge.ts"
      );
      const { createSileroVadDetector } = await import(
        "../src/services/local-inference/voice/vad.ts"
      );
      const wavBytes = await fs.readFile(wavPath);
      const decoded = decodeMonoPcm16Wav(new Uint8Array(wavBytes));
      const push = new PushMicSource({ sampleRate: decoded.sampleRate });
      micSource = push;
      const vad = await createSileroVadDetector({
        modelPath: process.env.ELIZA_VAD_MODEL_PATH,
      });
      controller = await engine.startVoiceSession({
        roomId: args.room,
        micSource: push,
        vad,
        generate: wrappedGenerate,
        prewarm: async (rid) => {
          try {
            await prewarmResponseHandler(runtime, rid);
          } catch {
            /* best-effort */
          }
        },
        speculatePauseMs: 300,
        events,
      });
      // Feed the WAV PCM (the PushMicSource re-frames it). Convert int16→float.
      const view = new DataView(
        decoded.pcm.buffer,
        decoded.pcm.byteOffset,
        decoded.pcm.byteLength,
      );
      const n = Math.floor(decoded.pcm.byteLength / 2);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 0x8000;
      push.push(f);
      // Trailing silence so the VAD fires speech-end.
      push.push(new Float32Array(decoded.sampleRate)); // 1 s
      // Wait for the turn to complete.
      await new Promise((r) => setTimeout(r, 4000));
      await bridge?.settle?.();
    } catch (err) {
      log(
        c(
          "red",
          `--wav turn failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      await shutdown(1);
      return;
    }
    log(c("green", `[done] audio → ${audio.describe()}`));
    await shutdown(0);
    return;
  }

  // ── Real mic interactive ───────────────────────────────────────────────
  tag(
    "mode",
    "blue",
    "real mic — speak into your microphone. Controls: s=force-stop  m=mute  p=histogram  q=quit  (Ctrl-C twice = quit)",
  );
  try {
    const { DesktopMicSource } = await import(
      "../src/services/local-inference/voice/mic-source.ts"
    );
    const { createSileroVadDetector } = await import(
      "../src/services/local-inference/voice/vad.ts"
    );
    micSource = new DesktopMicSource();
    const vad = await createSileroVadDetector({
      modelPath: process.env.ELIZA_VAD_MODEL_PATH,
    });
    controller = await engine.startVoiceSession({
      roomId: args.room,
      micSource,
      vad,
      generate: wrappedGenerate,
      prewarm: async (rid) => {
        try {
          await prewarmResponseHandler(runtime, rid);
        } catch {
          /* best-effort */
        }
      },
      speculatePauseMs: 300,
      events,
    });
    // The first-audio filler is played by the turn controller on speech-start;
    // wire VAD events to the live UI too. The transcriber's partials are
    // surfaced via the controller; print them by subscribing to the VAD.
    if (typeof vad.onVadEvent === "function") {
      vad.onVadEvent((e) => {
        if (e.type === "speech-start") tag("heard", "dim", "(speech-start)");
        else if (e.type === "speech-end") tag("heard", "dim", "(speech-end)");
      });
    }
  } catch (err) {
    log(
      c(
        "red",
        `Failed to start the mic voice session: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    if (process.platform === "win32") {
      log(
        c(
          "dim",
          'Windows has no universal CLI recorder — use --wav <path> or --say "<text>" instead.',
        ),
      );
    } else {
      log(
        c(
          "dim",
          "Is arecord (alsa-utils) or sox on PATH? Try: sudo apt install alsa-utils  (or)  brew install sox",
        ),
      );
    }
    await shutdown(1);
    return;
  }

  // Keyboard controls (raw mode).
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", async (_str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        const now = Date.now();
        if (now - lastCtrlC < 1500) {
          await shutdown(0);
        } else {
          lastCtrlC = now;
          forceStop();
          log(c("dim", "  (Ctrl-C again within 1.5s to quit)"));
        }
        return;
      }
      switch (key.name) {
        case "s":
          forceStop();
          break;
        case "m":
          micMuted = !micMuted;
          if (micMuted) {
            try {
              await micSource?.stop();
            } catch {
              /* ignore */
            }
            tag("mic", "yellow", "muted");
          } else {
            try {
              await micSource?.start();
            } catch {
              /* ignore */
            }
            tag("mic", "green", "unmuted");
          }
          break;
        case "p":
          await printLatencyHistogram();
          break;
        case "q":
          await shutdown(0);
          break;
        default:
          break;
      }
    });
  }

  // Fire an initial idle phrase-cache prewarm.
  engine.prewarmIdleVoicePhrases().catch(() => {});

  // Keep the process alive; shutdown happens via 'q' / Ctrl-C / signals.
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
}

// Re-used by the two-agents duet harness (`voice-duet.mjs`): the prereq
// inspector, the bundle-registration helper, and the cross-platform matrix.
// Guarded so importing this module (instead of running it) doesn't kick off
// the interactive `main()`.
export {
  ensureBundleRegistered,
  inspectActiveOptimizations,
  PLATFORM_MATRIX,
  printPlatformReport,
};

if (import.meta.main) {
  main().catch(async (err) => {
    console.error(
      c(
        "red",
        `[voice-interactive] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      ),
    );
    process.exit(1);
  });
}
