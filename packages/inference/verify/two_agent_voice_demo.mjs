#!/usr/bin/env node
/*
 * two_agent_voice_demo.mjs — two Eliza agents talking through the same
 * local-model voice loop.
 *
 * The harness records the dynamics the product demo needs:
 *
 *   agent A text -> TTS audio -> agent B ASR -> schema-prefilled tool call
 *     -> text generation/DFlash metrics -> TTS audio -> agent A ASR -> ...
 *
 * `--backend synthetic` is deterministic and CI-safe. It verifies the
 * orchestration, metrics shape, and schema-prefill accounting without
 * claiming model/hardware evidence. `--backend real` bridges to the
 * app-core voice-duet harness, which owns the live in-memory
 * TTS -> ASR -> agent-tool loop.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_REPORT_DIR = path.join(
  __dirname,
  "reports",
  "two-agent-voice",
);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const VOICE_DUET = path.join(
  REPO_ROOT,
  "packages",
  "app-core",
  "scripts",
  "voice-duet.mjs",
);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function usage() {
  return [
    "Usage: node packages/inference/verify/two_agent_voice_demo.mjs [options]",
    "",
    "Options:",
    "  --backend synthetic|real   Backend to exercise (default: synthetic)",
    "  --turns <n>                Number of agent turns (default: 6)",
    "  --model-id <id>            Shared model id (default: eliza-1-1_7b)",
    "  --bundle <dir>             Bundle directory for real backend checks",
    "  --bin-dir <dir>            Fused runtime bin dir for real backend checks",
    "  --real-timeout-ms <ms>     Max wall time for real voice-duet bridge (default: 300000)",
    "  --agent-a <name>           Agent A name (default: ada)",
    "  --agent-b <name>           Agent B name (default: bea)",
    "  --seed <n>                 Deterministic synthetic seed (default: 42)",
    "  --report <path>            JSON report path",
    "  --json                     Print full JSON report",
    "  --quiet                    Suppress human summary",
    "  --help, -h                 Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    backend: process.env.ELIZA_TWO_AGENT_BACKEND || "synthetic",
    turns: Number.parseInt(process.env.ELIZA_TWO_AGENT_TURNS || "6", 10),
    modelId: process.env.ELIZA_TWO_AGENT_MODEL_ID || "eliza-1-1_7b",
    bundle: process.env.ELIZA_TWO_AGENT_BUNDLE || "",
    binDir: process.env.ELIZA_TWO_AGENT_BIN_DIR || "",
    realTimeoutMs: Number.parseInt(
      process.env.ELIZA_TWO_AGENT_REAL_TIMEOUT_MS || "300000",
      10,
    ),
    agentA: process.env.ELIZA_TWO_AGENT_A || "ada",
    agentB: process.env.ELIZA_TWO_AGENT_B || "bea",
    seed: Number.parseInt(process.env.ELIZA_TWO_AGENT_SEED || "42", 10),
    report: process.env.ELIZA_TWO_AGENT_REPORT || "",
    json: process.env.ELIZA_TWO_AGENT_JSON === "1",
    quiet: process.env.ELIZA_TWO_AGENT_QUIET === "1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--backend") args.backend = next();
    else if (a === "--turns") args.turns = Number.parseInt(next(), 10);
    else if (a === "--model-id") args.modelId = next();
    else if (a === "--bundle" || a === "--bundle-dir") args.bundle = next();
    else if (a === "--bin-dir") args.binDir = next();
    else if (a === "--real-timeout-ms") {
      args.realTimeoutMs = Number.parseInt(next(), 10);
    }
    else if (a === "--agent-a") args.agentA = next();
    else if (a === "--agent-b") args.agentB = next();
    else if (a === "--seed") args.seed = Number.parseInt(next(), 10);
    else if (a === "--report") args.report = next();
    else if (a === "--json") args.json = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!["synthetic", "real"].includes(args.backend)) {
    throw new Error("--backend must be synthetic or real");
  }
  if (!Number.isFinite(args.turns) || args.turns < 1) {
    throw new Error("--turns must be a positive integer");
  }
  if (!Number.isFinite(args.seed)) {
    throw new Error("--seed must be an integer");
  }
  if (!Number.isFinite(args.realTimeoutMs) || args.realTimeoutMs < 1000) {
    throw new Error("--real-timeout-ms must be at least 1000");
  }
  if (!args.report) {
    args.report = path.join(
      DEFAULT_REPORT_DIR,
      `two-agent-voice-${args.backend}-${timestamp()}.json`,
    );
  }
  return args;
}

function stateRoot() {
  return process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
}

function platformTag() {
  const sys =
    { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform] ||
    process.platform;
  const arch = { arm64: "arm64", x64: "x64" }[process.arch] || process.arch;
  return `${sys}-${arch}`;
}

function libName() {
  if (process.platform === "darwin") return "libelizainference.dylib";
  if (process.platform === "win32") return "libelizainference.dll";
  return "libelizainference.so";
}

function defaultBundle(modelId) {
  return path.join(
    stateRoot(),
    "local-inference",
    "models",
    `${modelId}.bundle`,
  );
}

function defaultBinDir() {
  return path.join(
    stateRoot(),
    "local-inference",
    "bin",
    "dflash",
    `${platformTag()}-metal-fused`,
  );
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function escapeJsonStringValue(text) {
  return JSON.stringify(text).slice(1, -1);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return value;
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function schemaToolCallMetrics({ speaker, listener, turnIndex, reply }) {
  const fullCall = JSON.stringify({
    toolCalls: [
      {
        name: "RESPOND",
        args: {
          speaker,
          listener,
          voice: "eliza-default",
          format: "voice",
          turnIndex,
          reply,
        },
      },
    ],
  });
  const prefill =
    `{"toolCalls":[{"name":"RESPOND","args":{"speaker":${JSON.stringify(speaker)},` +
    `"listener":${JSON.stringify(listener)},"voice":"eliza-default",` +
    `"format":"voice","turnIndex":${turnIndex},"reply":"`;
  const suffix = `"}}]}`;
  const generatedOnly = escapeJsonStringValue(reply);
  const baselineTokens = estimateTokens(fullCall);
  const optimizedGeneratedTokens = estimateTokens(generatedOnly);
  const prefillLoadedTokens = estimateTokens(prefill + suffix);
  const savedTokens = Math.max(0, baselineTokens - optimizedGeneratedTokens);

  return {
    toolName: "RESPOND",
    onlyToolCallsSupported: true,
    prefillStartsAt: '<parameter": "reply">',
    prefill,
    suffix,
    inferredFields: [
      "toolCalls[0].name",
      "toolCalls[0].args.speaker",
      "toolCalls[0].args.listener",
      "toolCalls[0].args.voice",
      "toolCalls[0].args.format",
      "toolCalls[0].args.turnIndex",
      "JSON object shape",
      "enum constraints",
    ],
    baseline: {
      json: fullCall,
      bytes: Buffer.byteLength(fullCall),
      estimatedTokens: baselineTokens,
    },
    optimized: {
      generatedValue: generatedOnly,
      generatedBytes: Buffer.byteLength(generatedOnly),
      generatedEstimatedTokens: optimizedGeneratedTokens,
      prefillLoadedEstimatedTokens: prefillLoadedTokens,
    },
    savedEstimatedTokens: savedTokens,
    savingsRatio: baselineTokens > 0 ? savedTokens / baselineTokens : 0,
  };
}

class SyntheticBackend {
  constructor(seed) {
    this.rng = mulberry32(seed);
  }

  jitter(ms) {
    return (this.rng() - 0.5) * ms;
  }

  async tts({ text }) {
    const tokens = estimateTokens(text);
    const audioDurationMs = Math.max(520, 92 * tokens + this.jitter(24));
    const firstAudioMs = Math.max(18, 36 + this.jitter(10));
    const totalMs = Math.max(firstAudioMs, 48 + tokens * 4.8 + this.jitter(16));
    return {
      sampleRateHz: 24000,
      audioDurationMs: round(audioDurationMs),
      firstAudioMs: round(firstAudioMs),
      totalMs: round(totalMs),
      rtf: round(totalMs / audioDurationMs, 5),
      pcmBytes: Math.round((audioDurationMs / 1000) * 24000 * 2),
    };
  }

  async asr({ expectedText, audioDurationMs }) {
    const tokens = estimateTokens(expectedText);
    const latencyMs = Math.max(24, 34 + tokens * 3.1 + audioDurationMs * 0.018 + this.jitter(12));
    return {
      transcript: expectedText,
      latencyMs: round(latencyMs),
      transcriptTokens: tokens,
      wer: 0,
    };
  }

  async generate({ speaker, listener, transcript, turnIndex }) {
    const short = transcript
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 74);
    const reply =
      turnIndex === 0
        ? `${listener}, I heard you. I will answer with one concise tool-call response and keep the loop moving.`
        : `${listener}, continuing from "${short}", I will keep latency low and hand the next voice turn back.`;
    const generatedTokens = estimateTokens(reply);
    const firstTokenMs = Math.max(18, 42 + this.jitter(12));
    const decodeMs = Math.max(30, generatedTokens * 8.7 + this.jitter(22));
    const draftedTokens = Math.ceil(generatedTokens * (1.25 + this.rng() * 0.22));
    const acceptedDraftTokens = Math.min(
      draftedTokens,
      Math.max(generatedTokens, Math.round(draftedTokens * (0.74 + this.rng() * 0.14))),
    );
    return {
      reply,
      generatedTokens,
      firstTokenMs: round(firstTokenMs),
      decodeMs: round(decodeMs),
      tokensPerSecond: round(generatedTokens / (decodeMs / 1000), 3),
      dflash: {
        draftedTokens,
        acceptedDraftTokens,
        rejectedDraftTokens: draftedTokens - acceptedDraftTokens,
        acceptanceRate: round(acceptedDraftTokens / draftedTokens, 5),
      },
    };
  }
}

function validateRealBackend(args) {
  const bundle = args.bundle || defaultBundle(args.modelId);
  const binDir = args.binDir || defaultBinDir();
  const dylib = path.join(binDir, libName());
  const server = path.join(binDir, "llama-server");
  const reasons = [];
  if (!fs.existsSync(bundle)) reasons.push(`bundle missing: ${bundle}`);
  if (!fs.existsSync(path.join(bundle, "eliza-1.manifest.json"))) {
    reasons.push(`manifest missing: ${path.join(bundle, "eliza-1.manifest.json")}`);
  }
  if (!fs.existsSync(dylib)) reasons.push(`fused FFI library missing: ${dylib}`);
  if (!fs.existsSync(server)) reasons.push(`fused llama-server missing: ${server}`);
  return { bundle, binDir, dylib, server, ok: reasons.length === 0, reasons };
}

function envForRealBridge(args, real) {
  const env = { ...process.env };
  if (args.binDir) {
    env.ELIZA_INFERENCE_LIBRARY = real.dylib;
    env.ELIZA_INFERENCE_LIB_DIR = real.binDir;
    env.ELIZA_DFLASH_LLAMA_SERVER = real.server;
  }
  const defaultBundlePath = defaultBundle(args.modelId);
  if (args.bundle && path.resolve(args.bundle) !== path.resolve(defaultBundlePath)) {
    const suffix = path.join(
      "local-inference",
      "models",
      `${args.modelId}.bundle`,
    );
    const normalized = path.resolve(args.bundle);
    if (normalized.endsWith(suffix)) {
      env.ELIZA_STATE_DIR = normalized.slice(0, -suffix.length - 1);
    } else {
      env.ELIZA_TWO_AGENT_BUNDLE_UNSUPPORTED_BY_DUET = args.bundle;
    }
  }
  return env;
}

function executableForBunHarness() {
  if (process.versions?.bun) return process.execPath;
  return process.env.BUN_EXE || "bun";
}

function bridgeReportPath(args) {
  const parsed = path.parse(args.report);
  return path.join(parsed.dir, `${parsed.name}.voice-duet.json`);
}

function tail(text, max = 4000) {
  return text.length <= max ? text : text.slice(-max);
}

function runVoiceDuetBridge(args, real, reportPath) {
  return new Promise((resolve) => {
    const childArgs = [
      VOICE_DUET,
      "--model",
      args.modelId,
      "--turns",
      String(args.turns),
      "--report",
      reportPath,
    ];
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(executableForBunHarness(), childArgs, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: envForRealBridge(args, real),
    });
    child.stdout.on("data", (chunk) => {
      stdout = tail(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(stderr + chunk.toString("utf8"));
    });
    child.on("error", (err) => {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        wallMs: Date.now() - started,
        stdout,
        stderr: tail(`${stderr}\n${err.message}`),
        report: null,
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* child may already be gone */
      }
    }, args.realTimeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      let bridgeReport = null;
      try {
        if (fs.existsSync(reportPath)) {
          bridgeReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        }
      } catch {
        /* partial or invalid report */
      }
      resolve({
        code,
        signal,
        timedOut,
        wallMs: Date.now() - started,
        stdout,
        stderr,
        report: bridgeReport,
      });
    });
  });
}

function realBridgeStatus(result) {
  if (result.timedOut) return "real-voice-duet-timeout";
  if (result.code === 0 && (result.report?.completedTurns ?? 0) > 0) {
    return "pass";
  }
  if (result.code === 0) return "real-voice-duet-no-turns";
  return "real-voice-duet-failed";
}

function realBridgeReason(status, result) {
  if (status === "pass") {
    return "Real fused assets were present and the app-core voice-duet harness completed live TTS->ASR->agent turns.";
  }
  if (status === "real-voice-duet-timeout") {
    return `The app-core voice-duet bridge did not complete within ${result.wallMs}ms. Inspect the bridge stdout/stderr tail for the stage that stalled.`;
  }
  if (status === "real-voice-duet-no-turns") {
    return "The app-core voice-duet bridge exited successfully but did not record a completed round-trip; inspect the bridge report for missing latency/turn data.";
  }
  return "The app-core voice-duet bridge exited non-zero; stdout/stderr include the concrete missing prerequisite or native runtime failure.";
}

async function runSynthetic(args) {
  const backend = new SyntheticBackend(args.seed);
  const agents = [
    { id: "agent-a", name: args.agentA, voice: "eliza-default-a" },
    { id: "agent-b", name: args.agentB, voice: "eliza-default-b" },
  ];
  let spokenText =
    `${agents[0].name}, start the voice loop by asking for one concrete next step.`;
  const turns = [];

  for (let turnIndex = 0; turnIndex < args.turns; turnIndex += 1) {
    const speaker = agents[turnIndex % 2];
    const listener = agents[(turnIndex + 1) % 2];
    const outboundTts = await backend.tts({ text: spokenText });
    const asr = await backend.asr({
      expectedText: spokenText,
      audioDurationMs: outboundTts.audioDurationMs,
    });
    const llm = await backend.generate({
      speaker: listener.name,
      listener: speaker.name,
      transcript: asr.transcript,
      turnIndex,
    });
    const schema = schemaToolCallMetrics({
      speaker: listener.name,
      listener: speaker.name,
      turnIndex,
      reply: llm.reply,
    });
    const replyTts = await backend.tts({ text: llm.reply });
    const totalTurnMs =
      outboundTts.totalMs + asr.latencyMs + llm.firstTokenMs + llm.decodeMs + replyTts.totalMs;

    turns.push({
      turnIndex,
      speaker: speaker.name,
      listener: listener.name,
      inputText: spokenText,
      asr,
      llm,
      schemaToolCall: schema,
      audio: {
        inboundTts: outboundTts,
        replyTts,
      },
      totalTurnMs: round(totalTurnMs),
    });
    spokenText = llm.reply;
  }

  return {
    status: "pass",
    backendMode: "synthetic",
    releaseEvidence: false,
    releaseEvidenceReason:
      "Synthetic backend validates orchestration and metric accounting only; run --backend real on a fused bundle for release evidence.",
    agents,
    turns,
  };
}

async function runReal(args) {
  const real = validateRealBackend(args);
  const agents = [
    { id: "agent-a", name: args.agentA, voice: "eliza-default-a" },
    { id: "agent-b", name: args.agentB, voice: "eliza-default-b" },
  ];
  const env = envForRealBridge(args, real);
  if (env.ELIZA_TWO_AGENT_BUNDLE_UNSUPPORTED_BY_DUET) {
    return {
      status: "needs-supported-bundle-layout",
      backendMode: "real",
      releaseEvidence: false,
      releaseEvidenceReason:
        "A custom --bundle was supplied, but voice-duet resolves installed bundles from <state-dir>/local-inference/models/<model-id>.bundle. Move or symlink the bundle there, or pass a bundle path with that layout so ELIZA_STATE_DIR can be derived.",
      realBackend: {
        ...real,
        reasons: [
          ...real.reasons,
          `custom bundle path is not consumable by voice-duet: ${args.bundle}`,
        ],
      },
      agents,
      turns: [],
    };
  }
  if (!fs.existsSync(VOICE_DUET)) {
    real.reasons.push(`voice-duet harness missing: ${VOICE_DUET}`);
    real.ok = false;
  }
  if (!real.ok || real.reasons.length > 0) {
    return {
      status: "needs-build-or-bundle",
      backendMode: "real",
      releaseEvidence: false,
      releaseEvidenceReason:
        "Real fused assets are missing; no synthetic pass is recorded as release evidence.",
      realBackend: real,
      bridge: {
        harness: VOICE_DUET,
        attempted: false,
        reason: "missing required bundle/bin assets",
      },
      agents,
      turns: [],
    };
  }

  const duetReport = bridgeReportPath(args);
  const result = await runVoiceDuetBridge(args, real, duetReport);
  const status = realBridgeStatus(result);
  return {
    status,
    backendMode: "real",
    releaseEvidence: status === "pass",
    releaseEvidenceReason: realBridgeReason(status, result),
    realBackend: real,
    bridge: {
      harness: VOICE_DUET,
      command: [
        executableForBunHarness(),
        VOICE_DUET,
        "--model",
        args.modelId,
        "--turns",
        String(args.turns),
        "--report",
        duetReport,
      ],
      report: duetReport,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      wallMs: result.wallMs,
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
      voiceDuetReport: result.report,
      completedTurns: result.report?.completedTurns ?? 0,
      requestedTurns: result.report?.requestedTurns ?? args.turns,
    },
    agents,
    turns: [],
  };
}

function aggregate(report) {
  const turns = report.turns || [];
  const totalTurnMs = turns.map((t) => t.totalTurnMs);
  const generatedTokens = sum(turns.map((t) => t.llm?.generatedTokens || 0));
  const decodeMs = sum(turns.map((t) => t.llm?.decodeMs || 0));
  const schemaBaseline = sum(
    turns.map((t) => t.schemaToolCall?.baseline?.estimatedTokens || 0),
  );
  const schemaGenerated = sum(
    turns.map(
      (t) => t.schemaToolCall?.optimized?.generatedEstimatedTokens || 0,
    ),
  );
  const schemaSaved = sum(
    turns.map((t) => t.schemaToolCall?.savedEstimatedTokens || 0),
  );
  const drafted = sum(turns.map((t) => t.llm?.dflash?.draftedTokens || 0));
  const accepted = sum(
    turns.map((t) => t.llm?.dflash?.acceptedDraftTokens || 0),
  );
  return {
    totalTurns: turns.length,
    totalElapsedMs: round(sum(totalTurnMs)),
    averageTurnMs: totalTurnMs.length ? round(sum(totalTurnMs) / totalTurnMs.length) : null,
    medianTurnMs: round(median(totalTurnMs)),
    generatedTokens,
    averageTokensPerSecond:
      decodeMs > 0 ? round(generatedTokens / (decodeMs / 1000), 3) : null,
    averageAsrMs: turns.length
      ? round(sum(turns.map((t) => t.asr?.latencyMs || 0)) / turns.length)
      : null,
    averageTtsMs: turns.length
      ? round(
          sum(
            turns.map(
              (t) =>
                (t.audio?.inboundTts?.totalMs || 0) +
                (t.audio?.replyTts?.totalMs || 0),
            ),
          ) /
            (turns.length * 2),
        )
      : null,
    averageReplyRtf: turns.length
      ? round(sum(turns.map((t) => t.audio?.replyTts?.rtf || 0)) / turns.length, 5)
      : null,
    dflash: {
      draftedTokens: drafted,
      acceptedDraftTokens: accepted,
      acceptanceRate: drafted > 0 ? round(accepted / drafted, 5) : null,
    },
    schemaInference: {
      baselineEstimatedTokens: schemaBaseline,
      generatedEstimatedTokens: schemaGenerated,
      savedEstimatedTokens: schemaSaved,
      savingsRatio: schemaBaseline > 0 ? round(schemaSaved / schemaBaseline, 5) : null,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const partial =
    args.backend === "synthetic" ? await runSynthetic(args) : await runReal(args);
  const report = {
    schema: "eliza.two_agent_voice_demo.v1",
    generatedAt: new Date().toISOString(),
    model: {
      id: args.modelId,
      sameModelForBothAgents: true,
      bundle: args.bundle || defaultBundle(args.modelId),
      binDir: args.binDir || defaultBinDir(),
    },
    toolCallPrefillContract: {
      onlyToolCallsSupported: true,
      responseTool: "RESPOND",
      modelStartsGeneratingAt: '<parameter": "reply">',
      runtimeInferredFields: [
        "tool name",
        "speaker/listener enum values",
        "voice preset",
        "response format",
        "turn index",
        "JSON delimiters",
      ],
    },
    ...partial,
  };
  report.aggregate = aggregate(report);

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!args.quiet) {
    console.log(
      [
        `[two-agent-voice] status=${report.status} backend=${report.backendMode} releaseEvidence=${report.releaseEvidence}`,
        `[two-agent-voice] model=${report.model.id} turns=${report.aggregate.totalTurns} avgTurnMs=${report.aggregate.averageTurnMs}`,
        `[two-agent-voice] tps=${report.aggregate.averageTokensPerSecond} schemaSavedTokens=${report.aggregate.schemaInference.savedEstimatedTokens} schemaSavings=${report.aggregate.schemaInference.savingsRatio}`,
        `[two-agent-voice] report=${args.report}`,
      ].join("\n"),
    );
  }

  if (args.backend === "real" && report.status !== "pass") {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`[two-agent-voice] ${err?.stack || err}`);
  process.exit(1);
});
