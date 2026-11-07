#!/usr/bin/env bun
/**
 * Host quality gate for the shipped mobile voice: Paradee-8M TTS and the
 * Phonon-2 GGUF, both on native libelizainference (no ONNX anywhere;
 * the evaluator is the native ASR itself).
 *
 * Gates (thresholds in fixtures.json):
 *   1. TTS round trip: Paradee speaks each sentence, the native ASR hears it,
 *      corpus WER over the Paradee card samples, the 25 qualify sentences and
 *      the first 200 Paradee held-out WikiText sentences must be <= 0.08.
 *   2. ASR on pinned human speech: 100 LibriSpeech test-clean utterances plus
 *      the Android speech-fixture 0.wav, corpus WER <= 0.06.
 *   3. 3 s of digital silence must give an empty transcript.
 * RTF (compute seconds / audio seconds) is reported for both engines.
 *
 * Workers are separate processes speaking the host worker protocol: the
 * worker writes JSON lines on fd 3, first `{"ready":true}`, then one reply
 * per request line read from stdin.
 *   TTS: `{"id","op":"synthesize","text"}`  -> `{"id","audio": base64 PCM16 mono WAV}`
 *   ASR: `{"id","op":"transcribe","pcm": base64 float32 LE, "encoding":"f32","sampleRate":16000}` -> `{"id","text"}`
 *   either may answer `{"id","error"}`.
 * The workers verify their own library and model hashes; pass their
 * environment (ELIZA_INFERENCE_LIBRARY and friends) through this process.
 *
 *   bun packages/app/scripts/voice-quality/host-wer-gate.ts \
 *     --librispeech /data/LibriSpeech [--only asr|tts] [--label macos-arm64] \
 *     [--tts-worker "bun plugins/plugin-local-inference/src/host-tts-worker.ts"] \
 *     [--asr-worker "bun plugins/plugin-local-inference/src/host-asr-worker.ts"]
 *
 * `--librispeech` is the directory that holds `test-clean/` (the extracted
 * openslr test-clean.tar.gz pinned in fixtures.json). FLAC decoding uses the
 * `flac` CLI. The report goes to test-results/voice-quality/.
 *
 * `--export-device-fixtures <dir> --librispeech <dir>` runs no worker: it
 * writes the same pinned inputs for the on-device qualify app
 * (packages/app/scripts/paradee-voice/qualify, -PasrFixturesDir=<dir>):
 * asr-fixtures.json + asr/*.wav (16 kHz PCM16) and tts-sentences.txt.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import {
  corpusWer,
  decodeWav,
  encodeWav,
  normalizeWords,
  resample,
  type WordErrors,
  wordErrors,
} from "./wer.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "../../../..");

interface Fixtures {
  thresholds: { ttsRoundTripWer: number; asrWer: number };
  tts: Record<
    "paradeeSamples" | "qualifySentences" | "paradeeHeldOut",
    {
      url?: string;
      path?: string;
      sha256: string;
      format: "numbered-lines" | "lines" | "json-array";
      take?: number;
    }
  >;
  asr: {
    librispeech: {
      archiveSha256: string;
      utterances: Array<{
        id: string;
        path: string;
        sha256: string;
        text: string;
      }>;
    };
    speechFixture: {
      librispeechId: string;
      path: string;
      flacSha256: string;
      wavSha256: string;
      text: string;
    };
    silence: { seconds: number };
  };
}

export const FIXTURES = JSON.parse(
  readFileSync(path.join(here, "fixtures.json"), "utf8"),
) as Fixtures;

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Fetch (or read) a pinned text fixture, verify its sha256, and return its lines. */
export async function loadSentences(
  spec: Fixtures["tts"][keyof Fixtures["tts"]],
  cacheDir: string,
): Promise<string[]> {
  let bytes: Uint8Array;
  if (spec.path) {
    bytes = readFileSync(path.join(repoRoot, spec.path));
  } else if (spec.url) {
    const cached = path.join(cacheDir, spec.sha256);
    if (existsSync(cached)) {
      bytes = readFileSync(cached);
    } else {
      const res = await fetch(spec.url);
      if (!res.ok) throw new Error(`fixture ${spec.url}: HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (sha256(bytes) === spec.sha256 && !existsSync(cached)) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cached, bytes);
    }
  } else {
    throw new Error("fixture has neither path nor url");
  }
  const actual = sha256(bytes);
  if (actual !== spec.sha256) {
    throw new Error(
      `fixture ${spec.path ?? spec.url} sha256 ${actual} != pinned ${spec.sha256}`,
    );
  }
  const text = Buffer.from(bytes).toString("utf8");
  let lines: string[];
  if (spec.format === "json-array") {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string"))
      throw new Error("json-array fixture must be an array of strings");
    lines = parsed as string[];
  } else {
    lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (spec.format === "numbered-lines")
      lines = lines.map((l) => l.replace(/^\d+\.\s*/, ""));
  }
  return spec.take ? lines.slice(0, spec.take) : lines;
}

/** One worker process speaking the fd-3 JSON-lines protocol. */
export class HostWorker {
  private readonly pending = new Map<
    string,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  private readonly child: ChildProcess;
  private readonly ready: Promise<void>;
  private exited: Error | null = null;

  constructor(
    readonly name: string,
    command: string[],
    logPath: string,
    readyTimeoutMs = 300_000,
  ) {
    const [bin, ...args] = command;
    if (!bin) throw new Error(`${name} worker command is empty`);
    this.child = spawn(bin, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const log: string[] = [];
    const keep = (chunk: Buffer) => {
      log.push(chunk.toString("utf8"));
      writeFileSync(logPath, log.join(""));
    };
    this.child.stdout?.on("data", keep);
    this.child.stderr?.on("data", keep);
    const protocol = this.child.stdio[3];
    if (!protocol || !("on" in protocol))
      throw new Error(`${name} worker has no fd 3`);
    let markReady: () => void = () => {};
    let failReady: (e: Error) => void = () => {};
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    const timer = setTimeout(
      () =>
        failReady(
          new Error(
            `${name} worker not ready in ${readyTimeoutMs} ms (log ${logPath})`,
          ),
        ),
      readyTimeoutMs,
    );
    createInterface({ input: protocol as NodeJS.ReadableStream }).on(
      "line",
      (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.ready === true) {
          clearTimeout(timer);
          markReady();
          return;
        }
        const id = typeof msg.id === "string" ? msg.id : "";
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        if (typeof msg.error === "string")
          waiter.reject(new Error(`${name}: ${msg.error}`));
        else waiter.resolve(msg);
      },
    );
    this.child.on("exit", (code, signal) => {
      clearTimeout(timer);
      this.exited = new Error(
        `${name} worker exited (code ${code}, signal ${signal}); log ${logPath}`,
      );
      failReady(this.exited);
      for (const waiter of this.pending.values()) waiter.reject(this.exited);
      this.pending.clear();
    });
  }

  async request(
    body: Record<string, unknown>,
    timeoutMs = 600_000,
  ): Promise<Record<string, unknown>> {
    await this.ready;
    if (this.exited) throw this.exited;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} request timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  waitReady(): Promise<void> {
    return this.ready;
  }

  close(): void {
    this.child.stdin?.end();
    this.child.kill();
  }
}

function splitCommand(command: string): string[] {
  return (
    command
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((p) => p.replace(/^"|"$/g, "")) ?? []
  );
}

export async function transcribe(
  asr: HostWorker,
  pcm16k: Float32Array,
): Promise<{ text: string; seconds: number }> {
  const started = performance.now();
  const samples = Buffer.alloc(pcm16k.length * 4);
  for (let i = 0; i < pcm16k.length; i++)
    samples.writeFloatLE(pcm16k[i]!, i * 4);
  const reply = await asr.request({
    op: "transcribe",
    pcm: samples.toString("base64"),
    encoding: "f32",
    sampleRate: 16000,
  });
  if (typeof reply.text !== "string")
    throw new Error("ASR worker reply has no text");
  return { text: reply.text, seconds: (performance.now() - started) / 1000 };
}

function decodeFlac(file: string): { pcm: Float32Array; wav: Uint8Array } {
  const out = spawnSync("flac", ["-d", "-c", "-s", "--force", file], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (out.error) throw new Error(`flac CLI unavailable: ${out.error.message}`);
  if (out.status !== 0)
    throw new Error(`flac -d ${file} failed: ${out.stderr.toString()}`);
  const wav = new Uint8Array(out.stdout);
  const decoded = decodeWav(wav);
  if (decoded.sampleRate !== 16000)
    throw new Error(`${file}: expected 16 kHz, got ${decoded.sampleRate}`);
  return { pcm: decoded.samples, wav };
}

interface AsrItem {
  set: string;
  id: string;
  file: string;
  sha: string;
  text: string;
}

/** The ASR gate inputs: the LibriSpeech selection plus the speech fixture. */
function asrItems(
  librispeech: string,
  speechFixture?: string,
  limit = Infinity,
): AsrItem[] {
  const fixture = FIXTURES.asr.speechFixture;
  const items: AsrItem[] = FIXTURES.asr.librispeech.utterances
    .slice(0, limit)
    .map((u) => ({
      set: "librispeech-test-clean",
      id: u.id,
      file: path.join(librispeech, u.path),
      sha: u.sha256,
      text: u.text,
    }));
  items.push({
    set: "android-speech-fixture",
    id: "speech-fixture/0.wav",
    file: speechFixture ?? path.join(librispeech, fixture.path),
    sha: speechFixture ? fixture.wavSha256 : fixture.flacSha256,
    text: fixture.text,
  });
  return items;
}

/** Verify an ASR input against its pin and return 16 kHz mono samples. */
function loadAsrItem(item: AsrItem): Float32Array {
  const bytes = readFileSync(item.file);
  if (sha256(bytes) !== item.sha)
    throw new Error(`${item.file} sha256 does not match fixtures.json`);
  const pcm = item.file.endsWith(".wav")
    ? decodeWav(bytes).samples
    : decodeFlac(item.file).pcm;
  if (item.set === "android-speech-fixture" && !item.file.endsWith(".wav")) {
    // The fixture is the same PCM as its LibriSpeech source.
    const rebuilt = sha256(encodeWav(pcm, 16000));
    if (rebuilt !== FIXTURES.asr.speechFixture.wavSha256)
      throw new Error(
        `rebuilt speech-fixture sha256 ${rebuilt} != ${FIXTURES.asr.speechFixture.wavSha256}`,
      );
  }
  return pcm;
}

async function exportDeviceFixtures(
  out: string,
  librispeech: string,
  cacheDir: string,
): Promise<void> {
  mkdirSync(path.join(out, "asr"), { recursive: true });
  const items = asrItems(librispeech).map((item) => {
    const pcm = loadAsrItem(item);
    const file = `asr/${item.id.replace(/[^A-Za-z0-9.-]+/g, "_")}.wav`;
    writeFileSync(path.join(out, file), encodeWav(pcm, 16000));
    return { id: item.id, set: item.set, file, text: item.text };
  });
  writeFileSync(
    path.join(out, "asr-fixtures.json"),
    `${JSON.stringify({ schema: "eliza-voice-quality-device-fixtures-v1", thresholds: FIXTURES.thresholds, items }, null, 2)}\n`,
  );
  const sentences = [
    ...(await loadSentences(FIXTURES.tts.paradeeSamples, cacheDir)),
    ...(await loadSentences(FIXTURES.tts.paradeeHeldOut, cacheDir)),
  ];
  writeFileSync(
    path.join(out, "tts-sentences.txt"),
    `${sentences.join("\n")}\n`,
  );
  console.log(
    `[voice-gate] exported ${items.length} ASR items and ${sentences.length} TTS sentences to ${out}`,
  );
}

interface Row extends WordErrors {
  set: string;
  id: string;
  reference: string;
  heard: string;
  audioSeconds: number;
  asrSeconds: number;
  ttsSeconds?: number;
  error?: string;
}

function summarize(rows: Row[], threshold: number) {
  const audioSeconds = rows.reduce((n, r) => n + r.audioSeconds, 0);
  const asrSeconds = rows.reduce((n, r) => n + r.asrSeconds, 0);
  const ttsSeconds = rows.reduce((n, r) => n + (r.ttsSeconds ?? 0), 0);
  const failures = rows.filter((r) => r.error).length;
  const wer = corpusWer(rows);
  const bySet: Record<string, { wer: number; words: number; rows: number }> =
    {};
  for (const set of new Set(rows.map((r) => r.set))) {
    const subset = rows.filter((r) => r.set === set);
    bySet[set] = {
      wer: corpusWer(subset),
      words: subset.reduce((n, r) => n + r.words, 0),
      rows: subset.length,
    };
  }
  return {
    rows: rows.length,
    failures,
    words: rows.reduce((n, r) => n + r.words, 0),
    edits: rows.reduce((n, r) => n + r.edits, 0),
    wer,
    threshold,
    pass: failures === 0 && rows.length > 0 && wer <= threshold,
    bySet,
    audioSeconds,
    asrRtf: audioSeconds > 0 ? asrSeconds / audioSeconds : null,
    ttsRtf:
      ttsSeconds > 0 && audioSeconds > 0 ? ttsSeconds / audioSeconds : null,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      librispeech: { type: "string" },
      cache: { type: "string" },
      only: { type: "string" },
      label: { type: "string" },
      "tts-worker": {
        type: "string",
        default: "bun plugins/plugin-local-inference/src/host-tts-worker.ts",
      },
      "asr-worker": {
        type: "string",
        default: "bun plugins/plugin-local-inference/src/host-asr-worker.ts",
      },
      "speech-fixture": { type: "string" },
      "export-device-fixtures": { type: "string" },
      "tts-limit": { type: "string" },
      "asr-limit": { type: "string" },
    },
  });
  const only = values.only;
  if (only && only !== "tts" && only !== "asr")
    throw new Error("--only must be tts or asr");
  const runTts = only !== "asr";
  const runAsr = only !== "tts";
  const label = values.label ?? `${process.platform}-${process.arch}`;
  const outDir = testOutputPath("voice-quality");
  const cacheDir = values.cache ?? path.join(outDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  if (values["export-device-fixtures"]) {
    if (!values.librispeech)
      throw new Error(
        "--export-device-fixtures needs --librispeech <dir with test-clean/>",
      );
    await exportDeviceFixtures(
      path.resolve(values["export-device-fixtures"]),
      values.librispeech,
      cacheDir,
    );
    return 0;
  }
  const asr = new HostWorker(
    "asr",
    splitCommand(values["asr-worker"] as string),
    path.join(outDir, `asr-worker-${label}.log`),
  );
  const tts = runTts
    ? new HostWorker(
        "tts",
        splitCommand(values["tts-worker"] as string),
        path.join(outDir, `tts-worker-${label}.log`),
      )
    : null;
  const library = process.env.ELIZA_INFERENCE_LIBRARY;
  const report: Record<string, unknown> = {
    schema: "eliza-voice-quality-host-gate-v1",
    label,
    startedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpus: os.cpus()[0]?.model ?? null,
      bun: process.versions.bun ?? null,
    },
    library: library
      ? { path: library, sha256: sha256(readFileSync(library)) }
      : null,
    workers: {
      asr: values["asr-worker"],
      tts: runTts ? values["tts-worker"] : null,
    },
    thresholds: FIXTURES.thresholds,
  };
  const gates: Record<string, unknown> = {};
  try {
    await asr.waitReady();
    // Gate 3: silence.
    const silence = await transcribe(
      asr,
      new Float32Array(FIXTURES.asr.silence.seconds * 16000),
    );
    gates.silence = {
      heard: silence.text,
      pass: normalizeWords(silence.text).length === 0,
      asrSeconds: silence.seconds,
    };
    console.log(`[voice-gate] silence -> ${JSON.stringify(silence.text)}`);

    if (runAsr) {
      if (!values.librispeech)
        throw new Error(
          "--librispeech <dir with test-clean/> is required for the ASR gate",
        );
      const rows: Row[] = [];
      const items = asrItems(
        values.librispeech,
        values["speech-fixture"],
        Number(values["asr-limit"] ?? Infinity),
      );
      for (const item of items) {
        const pcm = loadAsrItem(item);
        let heard = "";
        let asrSeconds = 0;
        let error: string | undefined;
        try {
          ({ text: heard, seconds: asrSeconds } = await transcribe(asr, pcm));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const score = wordErrors(item.text, heard);
        rows.push({
          set: item.set,
          id: item.id,
          reference: item.text,
          heard,
          audioSeconds: pcm.length / 16000,
          asrSeconds,
          ...score,
          ...(error ? { error } : {}),
        });
        console.log(
          `[voice-gate] asr ${rows.length}/${items.length} ${item.id} edits=${score.edits}/${score.words} rtf=${(asrSeconds / (pcm.length / 16000)).toFixed(3)}${error ? ` error=${error}` : ""}`,
        );
      }
      gates.asr = {
        ...summarize(rows, FIXTURES.thresholds.asrWer),
        items: rows,
      };
    }

    if (tts) {
      await tts.waitReady();
      const rows: Row[] = [];
      const limit = Number(values["tts-limit"] ?? Infinity);
      const sets: Array<[string, string[]]> = [];
      for (const key of [
        "paradeeSamples",
        "qualifySentences",
        "paradeeHeldOut",
      ] as const) {
        sets.push([key, await loadSentences(FIXTURES.tts[key], cacheDir)]);
      }
      const all = sets.flatMap(([set, lines]) =>
        lines.map((text, i) => ({ set, id: `${set}#${i + 1}`, text })),
      );
      for (const item of all.slice(0, limit)) {
        let heard = "";
        let asrSeconds = 0;
        let ttsSeconds = 0;
        let audioSeconds = 0;
        let error: string | undefined;
        try {
          const started = performance.now();
          const reply = await tts.request({
            op: "synthesize",
            text: item.text,
          });
          ttsSeconds = (performance.now() - started) / 1000;
          if (typeof reply.audio !== "string")
            throw new Error("TTS worker reply has no audio");
          const wav = decodeWav(Buffer.from(reply.audio, "base64"));
          audioSeconds = wav.samples.length / wav.sampleRate;
          ({ text: heard, seconds: asrSeconds } = await transcribe(
            asr,
            resample(wav.samples, wav.sampleRate, 16000),
          ));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const score = wordErrors(item.text, heard);
        rows.push({
          ...item,
          reference: item.text,
          heard,
          audioSeconds,
          asrSeconds,
          ttsSeconds,
          ...score,
          ...(error ? { error } : {}),
        });
        console.log(
          `[voice-gate] tts ${rows.length}/${Math.min(limit, all.length)} ${item.id} edits=${score.edits}/${score.words} rtf=${audioSeconds ? (ttsSeconds / audioSeconds).toFixed(3) : "-"}${error ? ` error=${error}` : ""}`,
        );
      }
      gates.ttsRoundTrip = {
        ...summarize(rows, FIXTURES.thresholds.ttsRoundTripWer),
        items: rows,
      };
    }
  } finally {
    asr.close();
    tts?.close();
  }
  const ran = Object.values(gates) as Array<{ pass: boolean }>;
  const complete = runTts && runAsr && "silence" in gates;
  Object.assign(report, {
    finishedAt: new Date().toISOString(),
    complete,
    notRun: [...(runTts ? [] : ["ttsRoundTrip"]), ...(runAsr ? [] : ["asr"])],
    pass: ran.length > 0 && ran.every((g) => g.pass),
    gates,
  });
  const reportPath = path.join(outDir, `host-wer-gate-${label}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, gate] of Object.entries(gates) as Array<
    [
      string,
      {
        pass: boolean;
        wer?: number;
        threshold?: number;
        asrRtf?: number | null;
        ttsRtf?: number | null;
      },
    ]
  >) {
    console.log(
      `[voice-gate] ${name}: ${gate.pass ? "PASS" : "FAIL"}${gate.wer !== undefined ? ` wer=${gate.wer.toFixed(4)} (<= ${gate.threshold})` : ""}${gate.asrRtf != null ? ` asrRtf=${gate.asrRtf.toFixed(3)}` : ""}${gate.ttsRtf != null ? ` ttsRtf=${gate.ttsRtf.toFixed(3)}` : ""}`,
    );
  }
  console.log(`[voice-gate] report ${reportPath}`);
  return report.pass ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(
        `[voice-gate] ${err instanceof Error ? err.stack : String(err)}`,
      );
      process.exit(2);
    },
  );
}
