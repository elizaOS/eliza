#!/usr/bin/env node
/**
 * Collect live Eliza-1 samples through the Eliza Cloud API.
 *
 * This harness intentionally calls the Cloud API surface, not the Vast endpoint
 * directly. It writes raw text samples, streaming output checks, and optional
 * voice TTS/STT evidence without loading any local LLM weights.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const DEFAULT_REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "eliza1-cloud-samples",
);

const DEFAULT_MODELS = ["vast/eliza-1-2b", "vast/eliza-1-27b-256k"];

const PROMPTS = [
  {
    id: "exact_echo",
    messages: [
      {
        role: "user",
        content: "Reply with exactly: eliza cloud vast route ok",
      },
    ],
    maxTokens: 32,
  },
  {
    id: "concise_help",
    messages: [
      {
        role: "user",
        content:
          "In one short sentence, tell me whether the phrase 'voice test sample' is understandable.",
      },
    ],
    maxTokens: 64,
  },
  {
    id: "json_shape",
    messages: [
      {
        role: "system",
        content: "Return only compact JSON with keys ok, summary, and risk.",
      },
      {
        role: "user",
        content:
          "Assess whether this output is garbled: 'The meeting starts at 4pm and the report is ready.'",
      },
    ],
    maxTokens: 96,
  },
];

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.ELIZA_CLOUD_SAMPLE_BASE_URL || "http://localhost:8787",
    apiKey: process.env.ELIZA_CLOUD_SAMPLE_API_KEY || "dev-test-key",
    reportDir: process.env.ELIZA_CLOUD_SAMPLE_REPORT_DIR || DEFAULT_REPORT_DIR,
    models: DEFAULT_MODELS,
    runVoice: process.env.ELIZA_CLOUD_SAMPLE_VOICE !== "0",
    timeoutMs: Number.parseInt(
      process.env.ELIZA_CLOUD_SAMPLE_TIMEOUT_MS || "180000",
      10,
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--api-key") args.apiKey = next();
    else if (arg === "--report-dir") args.reportDir = path.resolve(next());
    else if (arg === "--timeout-ms")
      args.timeoutMs = Number.parseInt(next(), 10);
    else if (arg === "--models") {
      args.models = next()
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean);
    } else if (arg === "--no-voice") args.runVoice = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/eliza1-cloud-samples.mjs [options]",
          "",
          "Options:",
          "  --base-url URL       Cloud API base URL (default: http://localhost:8787)",
          "  --api-key KEY        API key header value (default: dev-test-key)",
          "  --models CSV         Models to sample",
          "  --report-dir DIR     Output directory",
          "  --timeout-ms N       Per-request timeout in ms (default: 180000)",
          "  --no-voice           Skip /api/v1/voice/tts and /api/v1/voice/stt",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  if (args.models.length === 0) throw new Error("--models must not be empty");
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  return args;
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function printableRatio(text) {
  if (!text) return 0;
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n" || char === "\t" || (code >= 0x20 && code !== 0x7f)) {
      printable += 1;
    }
  }
  return printable / Math.max(1, [...text].length);
}

function repeatedRunTooLong(text) {
  return /(.)\1{24,}/u.test(text);
}

function textQuality(text) {
  const clean = stripThinking(text);
  const replacementChars = (clean.match(/\uFFFD/g) || []).length;
  const ratio = printableRatio(clean);
  const lower = clean.toLowerCase();
  const issues = [];
  if (clean.length < 3) issues.push("empty-or-too-short");
  if (replacementChars > 0) issues.push("replacement-characters");
  if (ratio < 0.95) issues.push("low-printable-ratio");
  if (repeatedRunTooLong(clean)) issues.push("long-repeated-character-run");
  if (/^\s*(error|exception|traceback|failed)\b/i.test(clean)) {
    issues.push("error-looking-output");
  }
  if (lower.includes("[object object]")) issues.push("object-object-output");
  return {
    ok: issues.length === 0,
    clean,
    length: clean.length,
    printableRatio: Number(ratio.toFixed(4)),
    replacementChars,
    issues,
  };
}

function tokenSet(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

function overlapScore(expected, actual) {
  const exp = tokenSet(expected);
  const act = tokenSet(actual);
  if (exp.size === 0) return 0;
  let overlap = 0;
  for (const token of exp) {
    if (act.has(token)) overlap += 1;
  }
  return overlap / exp.size;
}

function authHeaders(args) {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": args.apiKey,
  };
}

async function fetchWithTimeout(args, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function chat(args, model, prompt, stream = false) {
  const started = performance.now();
  const res = await fetchWithTimeout(
    args,
    `${args.baseUrl}/api/v1/chat/completions`,
    {
      method: "POST",
      headers: authHeaders(args),
      body: JSON.stringify({
        model,
        messages: prompt.messages,
        temperature: 0,
        max_tokens: prompt.maxTokens,
        stream,
      }),
    },
  );

  if (!stream) {
    const rawText = await res.text();
    let json = null;
    try {
      json = JSON.parse(rawText);
    } catch {
      // Keep raw response for diagnostics.
    }
    const content = json?.choices?.[0]?.message?.content ?? "";
    return {
      mode: "nonstream",
      promptId: prompt.id,
      ok: res.ok,
      httpStatus: res.status,
      latencyMs: Math.round(performance.now() - started),
      model,
      content,
      rawText: rawText.slice(0, 2000),
      usage: json?.usage ?? null,
      quality: textQuality(content),
    };
  }

  const raw = await res.text();
  const chunks = [];
  for (const block of raw.split(/\n\n+/)) {
    const line = block.split(/\n/).find((entry) => entry.startsWith("data: "));
    if (!line) continue;
    const payload = line.slice("data: ".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta;
      if (typeof delta?.content === "string") chunks.push(delta.content);
    } catch {
      chunks.push(payload);
    }
  }
  const content = chunks.join("");
  return {
    mode: "stream",
    promptId: prompt.id,
    ok: res.ok,
    httpStatus: res.status,
    latencyMs: Math.round(performance.now() - started),
    model,
    eventCount: raw.split(/\n\n+/).filter(Boolean).length,
    content,
    rawText: raw.slice(0, 2000),
    quality: textQuality(content),
  };
}

function isMp3(bytes) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return true;
  }
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

async function collectVoice(args, text, reportDir, stamp) {
  const voiceText =
    stripThinking(text).slice(0, 240) || "Eliza cloud voice sample is clear.";
  const ttsStarted = performance.now();
  const ttsRes = await fetchWithTimeout(
    args,
    `${args.baseUrl}/api/v1/voice/tts`,
    {
      method: "POST",
      headers: authHeaders(args),
      body: JSON.stringify({
        text: voiceText,
        modelId: "eleven_flash_v2_5",
      }),
    },
  );
  const ttsBuffer = new Uint8Array(await ttsRes.arrayBuffer());
  const audioPath = path.join(reportDir, `voice-tts-${stamp}.mp3`);
  if (ttsRes.ok && ttsBuffer.byteLength > 0) {
    fs.writeFileSync(audioPath, ttsBuffer);
  }

  const tts = {
    ok: ttsRes.ok,
    httpStatus: ttsRes.status,
    latencyMs: Math.round(performance.now() - ttsStarted),
    contentType: ttsRes.headers.get("content-type"),
    cache: ttsRes.headers.get("x-tts-cache"),
    bytes: ttsBuffer.byteLength,
    audioPath: ttsRes.ok ? path.relative(REPO_ROOT, audioPath) : null,
    mp3MagicOk: isMp3(ttsBuffer),
  };

  let stt = null;
  if (ttsRes.ok && ttsBuffer.byteLength > 0) {
    const form = new FormData();
    form.set(
      "audio",
      new File([ttsBuffer], "eliza-cloud-voice-sample.mp3", {
        type: "audio/mpeg",
      }),
    );
    form.set("languageCode", "en");
    const sttStarted = performance.now();
    const sttRes = await fetchWithTimeout(
      args,
      `${args.baseUrl}/api/v1/voice/stt`,
      {
        method: "POST",
        headers: { "X-Api-Key": args.apiKey },
        body: form,
      },
    );
    const rawText = await sttRes.text();
    let json = null;
    try {
      json = JSON.parse(rawText);
    } catch {
      // Keep raw response for diagnostics.
    }
    const transcript = json?.transcript ?? "";
    const transcriptQuality = textQuality(transcript);
    const overlap = overlapScore(voiceText, transcript);
    stt = {
      ok: sttRes.ok,
      httpStatus: sttRes.status,
      latencyMs: Math.round(performance.now() - sttStarted),
      transcript,
      rawText: rawText.slice(0, 2000),
      durationMs: json?.duration_ms ?? null,
      overlapScore: Number(overlap.toFixed(4)),
      quality: {
        ...transcriptQuality,
        ok: transcriptQuality.ok && overlap >= 0.35,
        issues:
          overlap >= 0.35
            ? transcriptQuality.issues
            : [...transcriptQuality.issues, "low-transcript-overlap"],
      },
    };
  }

  return {
    inputText: voiceText,
    tts,
    stt,
    ok:
      tts.ok === true &&
      tts.mp3MagicOk === true &&
      tts.bytes > 1000 &&
      (stt?.ok ?? false) === true &&
      (stt?.quality?.ok ?? false) === true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = timestampForFile();
  fs.mkdirSync(args.reportDir, { recursive: true });

  const samples = [];
  for (const model of args.models) {
    for (const prompt of PROMPTS) {
      console.log(`[eliza1:cloud-samples] ${model} ${prompt.id} nonstream`);
      samples.push(await chat(args, model, prompt, false));
    }
    console.log(`[eliza1:cloud-samples] ${model} ${PROMPTS[1].id} stream`);
    samples.push(await chat(args, model, PROMPTS[1], true));
  }

  const representativeText =
    samples.find((sample) => sample.ok && sample.quality?.ok)?.content ||
    "Eliza cloud voice sample is clear.";
  const voice = args.runVoice
    ? (console.log("[eliza1:cloud-samples] voice tts/stt"),
      await collectVoice(args, representativeText, args.reportDir, stamp))
    : null;

  const pass =
    samples.every((sample) => sample.ok && sample.quality?.ok) &&
    (voice === null || voice.ok === true);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    models: args.models,
    status: pass ? "pass" : "fail",
    summary: {
      textSamples: samples.length,
      textPass: samples.filter((sample) => sample.ok && sample.quality?.ok)
        .length,
      voicePass: voice?.ok ?? null,
    },
    samples,
    voice,
  };

  const reportPath = path.join(
    args.reportDir,
    `eliza1-cloud-samples-${stamp}.json`,
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[eliza1:cloud-samples] wrote ${path.relative(REPO_ROOT, reportPath)} (${report.status})`,
  );
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `[eliza1:cloud-samples] ${error instanceof Error ? error.stack : error}`,
  );
  process.exit(1);
});
