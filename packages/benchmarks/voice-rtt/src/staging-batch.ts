#!/usr/bin/env bun
/**
 * Repeatable staging batch baseline for current voice TTS and STT routes.
 *
 * The runner shells out to curl for DNS/connect/TLS/TTFB/total timings, stores
 * generated probe audio locally, and keeps response bodies out of stdout and
 * reports by default.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  joinUrl,
  metricSummaries,
  parsePositiveInt,
  readJsonConfig,
  renderStagingJson,
  renderStagingMarkdown,
  requiredEnv,
  type StagingReport,
  writeReportFiles,
} from "./staging-common.ts";

type BatchMetric =
  | "ttsDnsMs"
  | "ttsConnectMs"
  | "ttsTlsMs"
  | "ttsTtfbMs"
  | "ttsTotalMs"
  | "sttDnsMs"
  | "sttConnectMs"
  | "sttTlsMs"
  | "sttTtfbMs"
  | "sttTotalMs"
  | "sttDurationMs";

const BATCH_METRICS = [
  "ttsDnsMs",
  "ttsConnectMs",
  "ttsTlsMs",
  "ttsTtfbMs",
  "ttsTotalMs",
  "sttDnsMs",
  "sttConnectMs",
  "sttTlsMs",
  "sttTtfbMs",
  "sttTotalMs",
  "sttDurationMs",
] as const satisfies readonly BatchMetric[];

const DEFAULT_PROBES = [
  {
    id: "short",
    text: "Staging voice probe short one two three.",
  },
  {
    id: "long",
    text: "Staging voice probe long. The benchmark uses deterministic text so current batch latency can be compared across runs without storing transcripts in the output artifacts.",
  },
] as const;

interface BatchConfig {
  baseUrl: string;
  ttsPath: string;
  sttPath: string;
  probes?: Array<{ id: string; text: string }>;
  ttsRequest: {
    textField: string;
    responseFormat: "binary" | "jsonAudioBase64";
    contentType: string;
    audioBase64Field?: string;
  };
  sttRequest: {
    fieldName: string;
    responseFormat: "json";
    durationField: string;
  };
  curlTimeoutSeconds: number;
}

interface CurlTiming {
  httpCode: number;
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  totalMs: number;
}

interface BatchRun {
  probeId: string;
  runIndex: number;
  audioBytes: number;
  metrics: Record<BatchMetric, number | null>;
  error?: string;
}

interface Args {
  config: string;
  runs: number;
  out?: string;
  workDir: string;
}

const HELP = `Staging voice current batch baseline

Flags:
  --config=<path>       config JSON (default: configs/staging-batch.json)
  --runs=<n>            repeats per probe (default: 3)
  --out=<dir>           write staging-batch.json and staging-batch.md
  --work-dir=<dir>      generated audio/temp directory (default: .staging-batch)
  --help                show this message

Environment:
  VOICE_STAGING_BEARER_TOKEN
`;

export function parseBatchArgs(argv: readonly string[]): Args {
  const args: Args = {
    config: "configs/staging-batch.json",
    runs: 3,
    workDir: ".staging-batch",
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg.startsWith("--config=")) args.config = arg.slice(9);
    else if (arg.startsWith("--runs="))
      args.runs = parsePositiveInt(arg.slice(7), 3);
    else if (arg.startsWith("--out=")) args.out = arg.slice(6);
    else if (arg.startsWith("--work-dir=")) args.workDir = arg.slice(11);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export async function runStagingBatchBaseline(args: {
  config: BatchConfig;
  runs: number;
  workDir: string;
  bearerToken: string;
  nowIso: () => string;
}): Promise<StagingReport<BatchMetric, BatchRun>> {
  mkdirSync(args.workDir, { recursive: true });
  const runs: BatchRun[] = [];
  const probes = args.config.probes ?? DEFAULT_PROBES;
  for (let runIndex = 0; runIndex < args.runs; runIndex++) {
    for (const probe of probes) {
      process.stdout.write(`[staging-batch ${probe.id}#${runIndex}]\n`);
      runs.push(
        await runProbe({
          config: args.config,
          probe,
          runIndex,
          workDir: args.workDir,
          bearerToken: args.bearerToken,
        }),
      );
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: args.nowIso(),
    tool: "Staging Voice Batch Baseline",
    target: {
      baseUrl: args.config.baseUrl,
      paths: { tts: args.config.ttsPath, stt: args.config.sttPath },
    },
    summaries: metricSummaries(
      runs,
      BATCH_METRICS,
      (run, metric) => run.metrics[metric],
    ),
    runs,
  };
}

async function runProbe(args: {
  config: BatchConfig;
  probe: { id: string; text: string };
  runIndex: number;
  workDir: string;
  bearerToken: string;
}): Promise<BatchRun> {
  const metrics = emptyMetrics();
  const audioPath = resolve(
    args.workDir,
    `${args.probe.id}-${args.runIndex}.audio`,
  );
  const ttsBodyPath = resolve(
    args.workDir,
    `${args.probe.id}-${args.runIndex}.tts-body`,
  );
  const sttBodyPath = resolve(
    args.workDir,
    `${args.probe.id}-${args.runIndex}.stt-body.json`,
  );
  try {
    const requestPath = resolve(
      args.workDir,
      `${args.probe.id}-${args.runIndex}.tts-request.json`,
    );
    writeFileSync(
      requestPath,
      JSON.stringify({ [args.config.ttsRequest.textField]: args.probe.text }),
      "utf8",
    );
    const tts = await curlPost({
      url: joinUrl(args.config.baseUrl, args.config.ttsPath),
      bearerToken: args.bearerToken,
      outputPath: ttsBodyPath,
      timeoutSeconds: args.config.curlTimeoutSeconds,
      args: [
        "-H",
        `Content-Type: ${args.config.ttsRequest.contentType}`,
        "--data-binary",
        `@${requestPath}`,
      ],
    });
    assignCurl(metrics, "tts", tts);
    if (tts.httpCode < 200 || tts.httpCode >= 300) {
      throw new Error(`TTS failed with HTTP ${tts.httpCode}`);
    }
    if (args.config.ttsRequest.responseFormat === "binary") {
      await Bun.write(audioPath, readFileSync(ttsBodyPath));
    } else {
      const json = JSON.parse(readFileSync(ttsBodyPath, "utf8")) as Record<
        string,
        unknown
      >;
      const field = args.config.ttsRequest.audioBase64Field ?? "audioBase64";
      const audioBase64 = json[field];
      if (typeof audioBase64 !== "string") {
        throw new Error(`TTS JSON response missing ${field}`);
      }
      await Bun.write(audioPath, Buffer.from(audioBase64, "base64"));
    }
    const audioBytes = existsSync(audioPath)
      ? readFileSync(audioPath).byteLength
      : 0;
    const stt = await curlPost({
      url: joinUrl(args.config.baseUrl, args.config.sttPath),
      bearerToken: args.bearerToken,
      outputPath: sttBodyPath,
      timeoutSeconds: args.config.curlTimeoutSeconds,
      // curl cannot infer a useful MIME type from the neutral `.audio`
      // extension. The route validates both the multipart MIME and the file
      // signature, so provide an accepted container MIME explicitly.
      args: [
        "-F",
        `${args.config.sttRequest.fieldName}=@${audioPath};type=audio/mpeg`,
      ],
    });
    assignCurl(metrics, "stt", stt);
    if (stt.httpCode < 200 || stt.httpCode >= 300) {
      throw new Error(`STT failed with HTTP ${stt.httpCode}`);
    }
    const sttJson = JSON.parse(readFileSync(sttBodyPath, "utf8")) as Record<
      string,
      unknown
    >;
    const durationValue = sttJson[args.config.sttRequest.durationField];
    metrics.sttDurationMs =
      typeof durationValue === "number" && Number.isFinite(durationValue)
        ? durationValue
        : null;
    return {
      probeId: args.probe.id,
      runIndex: args.runIndex,
      audioBytes,
      metrics,
    };
  } catch (error) {
    return {
      probeId: args.probe.id,
      runIndex: args.runIndex,
      audioBytes: existsSync(audioPath)
        ? readFileSync(audioPath).byteLength
        : 0,
      metrics,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function curlPost(args: {
  url: string;
  bearerToken: string;
  outputPath: string;
  timeoutSeconds: number;
  args: string[];
}): Promise<CurlTiming> {
  const timingFormat = JSON.stringify({
    httpCode: "%{http_code}",
    dns: "%{time_namelookup}",
    connect: "%{time_connect}",
    tls: "%{time_appconnect}",
    ttfb: "%{time_starttransfer}",
    total: "%{time_total}",
  });
  const proc = Bun.spawn(
    [
      "curl",
      "-sS",
      "--max-time",
      String(args.timeoutSeconds),
      "-X",
      "POST",
      "-H",
      "@-",
      "-o",
      args.outputPath,
      "-w",
      timingFormat,
      ...args.args,
      args.url,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(`Authorization: Bearer ${args.bearerToken}\n`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const timing = parseCurlTiming(stdout);
  if (exitCode !== 0) {
    throw new Error(
      `curl failed with exit ${exitCode}, http ${timing.httpCode || "000"}: ${stderr.trim()}`,
    );
  }
  return timing;
}

export function parseCurlTiming(stdout: string): CurlTiming {
  const parsed = JSON.parse(stdout) as Record<string, string>;
  const seconds = (key: string) => Number.parseFloat(parsed[key] ?? "0") * 1000;
  return {
    httpCode: Number.parseInt(parsed.httpCode ?? "0", 10),
    dnsMs: seconds("dns"),
    connectMs: seconds("connect"),
    tlsMs: seconds("tls"),
    ttfbMs: seconds("ttfb"),
    totalMs: seconds("total"),
  };
}

function assignCurl(
  metrics: Record<BatchMetric, number | null>,
  prefix: "tts" | "stt",
  timing: CurlTiming,
): void {
  metrics[`${prefix}DnsMs`] = timing.dnsMs;
  metrics[`${prefix}ConnectMs`] = timing.connectMs;
  metrics[`${prefix}TlsMs`] = timing.tlsMs;
  metrics[`${prefix}TtfbMs`] = timing.ttfbMs;
  metrics[`${prefix}TotalMs`] = timing.totalMs;
}

function emptyMetrics(): Record<BatchMetric, number | null> {
  return Object.fromEntries(
    BATCH_METRICS.map((metric) => [metric, null]),
  ) as Record<BatchMetric, number | null>;
}

export function renderBatchRunTable(
  report: StagingReport<BatchMetric, BatchRun>,
): string[] {
  const lines = [
    "| Probe | Run | Audio bytes | TTS TTFB | TTS total | STT TTFB | STT total | STT duration | Error |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const run of report.runs) {
    const m = run.metrics;
    lines.push(
      `| ${run.probeId} | ${run.runIndex} | ${run.audioBytes} | ${fmt(m.ttsTtfbMs)} | ${fmt(m.ttsTotalMs)} | ${fmt(m.sttTtfbMs)} | ${fmt(m.sttTotalMs)} | ${fmt(m.sttDurationMs)} | ${run.error ?? ""} |`,
    );
  }
  return lines;
}

function fmt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}

async function main(): Promise<void> {
  const args = parseBatchArgs(process.argv.slice(2));
  const config = readJsonConfig<BatchConfig>(args.config);
  const report = await runStagingBatchBaseline({
    config,
    runs: args.runs,
    workDir: args.workDir,
    bearerToken: requiredEnv("VOICE_STAGING_BEARER_TOKEN"),
    nowIso: () => new Date().toISOString(),
  });
  const json = renderStagingJson(report);
  const markdown = renderStagingMarkdown(report, renderBatchRunTable(report));
  process.stdout.write(markdown);
  if (args.out) {
    writeReportFiles({
      outDir: args.out,
      json,
      markdown,
      jsonName: "staging-batch.json",
      markdownName: "staging-batch.md",
    });
  }
  if (report.runs.some((run) => run.error)) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
