#!/usr/bin/env bun
/**
 * Staging cloud voice-session WebSocket benchmark.
 *
 * This runner exercises the phase-1 session route through public staging URLs,
 * keeps endpoint/event names configurable, and emits only redacted timing
 * artifacts so provider credentials and transcripts never leave the operator.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  duration,
  joinUrl,
  metricSummaries,
  nowMs,
  parsePositiveInt,
  readJsonConfig,
  redactIdentifier,
  renderStagingJson,
  renderStagingMarkdown,
  requiredEnv,
  type StagingReport,
  writeReportFiles,
} from "./staging-common.ts";

type SessionMetric =
  | "mintLatencyMs"
  | "helloToReadyMs"
  | "uplinkEndToSttFinalMs"
  | "sttFinalToLlmFirstTextMs"
  | "llmFirstTextToFirstTtsFrameMs"
  | "endOfUplinkToFirstAudioMs"
  | "interruptToSilenceMs";

const SESSION_METRICS = [
  "mintLatencyMs",
  "helloToReadyMs",
  "uplinkEndToSttFinalMs",
  "sttFinalToLlmFirstTextMs",
  "llmFirstTextToFirstTtsFrameMs",
  "endOfUplinkToFirstAudioMs",
  "interruptToSilenceMs",
] as const satisfies readonly SessionMetric[];

interface SessionConfig {
  baseUrl: string;
  mintPath: string;
  transport: "websocket";
  protocol: number;
  audio: {
    encoding: "pcm16";
    sampleRateHz: number;
    chunkBytes: number;
    chunkMs: number;
  };
  events: {
    ready: string;
    sttFinal: string;
    llmFirstText: string;
    interrupted: string;
    error: string;
  };
  messages: {
    helloType: string;
    bargeInType: string;
    endOfInputType: string;
  };
  cases: string[];
  guardMs: number;
  timeouts: {
    mintMs: number;
    readyMs: number;
    turnMs: number;
    interruptMs: number;
  };
}

interface SessionRun {
  caseId: string;
  runIndex: number;
  sessionId?: string;
  wsUrlHost?: string;
  metrics: Record<SessionMetric, number | null>;
  postInterruptBinaryFrames: number;
  observedEvents: string[];
  error?: string;
}

interface Args {
  config: string;
  runs: number;
  out?: string;
  audioDir?: string;
}

const HELP = `Staging voice-session WebSocket benchmark

Flags:
  --config=<path>      config JSON (default: configs/staging-session.json)
  --runs=<n>           repeats per case (default: 1)
  --out=<dir>          write staging-session.json and staging-session.md
  --audio-dir=<dir>    PCM corpus directory (default: VOICE_STAGING_AUDIO_DIR)
  --help               show this message

Environment:
  VOICE_STAGING_BEARER_TOKEN, VOICE_STAGING_AGENT_ID,
  VOICE_STAGING_CONVERSATION_ID, VOICE_STAGING_AUDIO_DIR
`;

export function parseSessionArgs(argv: readonly string[]): Args {
  const args: Args = { config: "configs/staging-session.json", runs: 1 };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg.startsWith("--config=")) args.config = arg.slice(9);
    else if (arg.startsWith("--runs=")) {
      args.runs = parsePositiveInt(arg.slice(7), 1);
    } else if (arg.startsWith("--out=")) args.out = arg.slice(6);
    else if (arg.startsWith("--audio-dir=")) args.audioDir = arg.slice(12);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export async function runStagingSessionBenchmark(args: {
  config: SessionConfig;
  runs: number;
  audioDir: string;
  bearerToken: string;
  agentId: string;
  conversationId: string;
  nowIso: () => string;
}): Promise<StagingReport<SessionMetric, SessionRun>> {
  const runs: SessionRun[] = [];
  for (let runIndex = 0; runIndex < args.runs; runIndex++) {
    for (const caseId of args.config.cases) {
      process.stdout.write(`[staging-session ${caseId}#${runIndex}]\n`);
      runs.push(
        await runSessionCase({
          config: args.config,
          runIndex,
          caseId,
          audioPath: resolve(args.audioDir, `${caseId}.pcm`),
          bearerToken: args.bearerToken,
          agentId: args.agentId,
          conversationId: args.conversationId,
        }),
      );
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: args.nowIso(),
    tool: "Staging Voice Session",
    target: {
      baseUrl: args.config.baseUrl,
      paths: { mint: args.config.mintPath },
    },
    summaries: metricSummaries(
      runs,
      SESSION_METRICS,
      (run, metric) => run.metrics[metric],
    ),
    runs,
  };
}

async function runSessionCase(args: {
  config: SessionConfig;
  runIndex: number;
  caseId: string;
  audioPath: string;
  bearerToken: string;
  agentId: string;
  conversationId: string;
}): Promise<SessionRun> {
  const observedEvents: string[] = [];
  const metrics = emptyMetrics();
  let sessionId: string | undefined;
  let wsUrlHost: string | undefined;
  let postInterruptBinaryFrames = 0;
  let firstBinarySeen = false;
  let interruptAt: number | null = null;
  let lastBinaryAfterInterruptAt: number | null = null;
  const caseStartedAt = nowMs();
  try {
    const mintStart = nowMs();
    const mint = await mintSession(args);
    const mintEnd = nowMs();
    metrics.mintLatencyMs = mintEnd - mintStart;
    sessionId = mint.sessionId;
    wsUrlHost = new URL(mint.wsUrl).host;

    const audio = readFileSync(args.audioPath);
    const ws = await connectWebSocket(mint.wsUrl, args.config.timeouts.readyMs);
    const helloAt = nowMs();
    ws.send(
      JSON.stringify({
        type: args.config.messages.helloType,
        token: mint.token,
        protocol: args.config.protocol,
        audio: {
          encoding: args.config.audio.encoding,
          sampleRateHz: args.config.audio.sampleRateHz,
        },
      }),
    );

    let uplinkEndAt: number | null = null;
    let sttFinalAt: number | null = null;
    let llmFirstTextAt: number | null = null;
    let firstTtsFrameAt: number | null = null;
    let interruptedAt: number | null = null;

    await new Promise<void>((resolvePromise, reject) => {
      let finished = false;
      let interruptTimer: ReturnType<typeof setTimeout> | undefined;
      const closeSocket = () => {
        clearTimeout(turnTimer);
        if (interruptTimer) clearTimeout(interruptTimer);
        ws.close();
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        closeSocket();
        resolvePromise();
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        closeSocket();
        reject(error);
      };
      const turnTimer = setTimeout(() => {
        fail(
          new Error(
            `timed out waiting for configured events after ${args.config.timeouts.turnMs}ms`,
          ),
        );
      }, args.config.timeouts.turnMs);

      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        try {
          if (typeof event.data !== "string") {
            if (interruptAt !== null) {
              postInterruptBinaryFrames++;
              lastBinaryAfterInterruptAt = nowMs();
            }
            if (!firstBinarySeen) {
              firstBinarySeen = true;
              firstTtsFrameAt = nowMs();
              if (args.caseId === "barge-in") {
                interruptAt = nowMs();
                ws.send(
                  JSON.stringify({ type: args.config.messages.bargeInType }),
                );
                interruptTimer = setTimeout(() => {
                  fail(
                    new Error(
                      `timed out waiting for ${args.config.events.interrupted} after ${args.config.timeouts.interruptMs}ms`,
                    ),
                  );
                }, args.config.timeouts.interruptMs);
              } else {
                finish();
              }
            }
            return;
          }
          const message = parseEvent(event.data);
          observedEvents.push(message.type);
          if (message.type === args.config.events.error) {
            fail(new Error(`server emitted ${args.config.events.error}`));
            return;
          }
          if (message.type === args.config.events.ready) {
            const readyAt = nowMs();
            metrics.helloToReadyMs = readyAt - helloAt;
            void streamAudio(ws, audio, args.config).then((endedAt) => {
              uplinkEndAt = endedAt;
            }, fail);
            return;
          }
          if (message.type === args.config.events.sttFinal) {
            sttFinalAt = nowMs();
            metrics.uplinkEndToSttFinalMs =
              uplinkEndAt === null ? null : duration(uplinkEndAt, sttFinalAt);
            return;
          }
          if (message.type === args.config.events.llmFirstText) {
            llmFirstTextAt = nowMs();
            metrics.sttFinalToLlmFirstTextMs =
              sttFinalAt === null ? null : duration(sttFinalAt, llmFirstTextAt);
            return;
          }
          if (message.type === args.config.events.interrupted) {
            interruptedAt = nowMs();
            if (interruptTimer) clearTimeout(interruptTimer);
            setTimeout(() => {
              metrics.interruptToSilenceMs =
                interruptAt === null
                  ? null
                  : duration(
                      interruptAt,
                      lastBinaryAfterInterruptAt ?? interruptedAt,
                    );
              finish();
            }, args.config.guardMs);
          }
        } catch (error) {
          fail(error);
        }
      };
      ws.onerror = () => fail(new Error("websocket error"));
      ws.onclose = () => {
        if (args.caseId !== "barge-in" && firstTtsFrameAt !== null) {
          finish();
        }
      };
    });

    metrics.llmFirstTextToFirstTtsFrameMs =
      llmFirstTextAt === null
        ? null
        : duration(llmFirstTextAt, firstTtsFrameAt);
    metrics.endOfUplinkToFirstAudioMs =
      uplinkEndAt === null ? null : duration(uplinkEndAt, firstTtsFrameAt);
    if (sttFinalAt === null) {
      throw new Error(
        `did not observe ${args.config.events.sttFinal}; observed ${observedEvents.join(", ")}`,
      );
    }
    if (llmFirstTextAt === null) {
      throw new Error(
        `did not observe ${args.config.events.llmFirstText}; observed ${observedEvents.join(", ")}`,
      );
    }
    if (firstTtsFrameAt === null) {
      throw new Error("did not observe first binary TTS frame");
    }
    if (args.caseId === "barge-in" && interruptedAt === null) {
      throw new Error(
        `barge-in did not observe ${args.config.events.interrupted}; observed ${observedEvents.join(", ")}`,
      );
    }
    if (postInterruptBinaryFrames > 0) {
      process.stderr.write(
        `warning: ${basename(args.audioPath)} emitted binary frames after barge_in\n`,
      );
    }
  } catch (error) {
    return {
      caseId: args.caseId,
      runIndex: args.runIndex,
      sessionId: redactIdentifier(sessionId),
      wsUrlHost,
      metrics,
      postInterruptBinaryFrames,
      observedEvents,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (nowMs() - caseStartedAt > args.config.timeouts.turnMs) {
    throw new Error(`${args.caseId} exceeded configured turn timeout`);
  }
  return {
    caseId: args.caseId,
    runIndex: args.runIndex,
    sessionId: redactIdentifier(sessionId),
    wsUrlHost,
    metrics,
    postInterruptBinaryFrames,
    observedEvents,
  };
}

async function mintSession(args: {
  config: SessionConfig;
  bearerToken: string;
  agentId: string;
  conversationId: string;
}): Promise<{ wsUrl: string; token: string; sessionId: string }> {
  const response = await fetch(
    joinUrl(args.config.baseUrl, args.config.mintPath),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: args.agentId,
        conversationId: args.conversationId,
        transport: args.config.transport,
      }),
      signal: AbortSignal.timeout(args.config.timeouts.mintMs),
    },
  );
  if (!response.ok) {
    throw new Error(
      `mint ${args.config.mintPath} failed with ${response.status}; verify endpoint mapping and auth`,
    );
  }
  const body = (await response.json()) as Partial<{
    wsUrl: string;
    token: string;
    sessionId: string;
  }>;
  if (!body.wsUrl || !body.token || !body.sessionId) {
    throw new Error("mint response must include wsUrl, token, and sessionId");
  }
  return body as { wsUrl: string; token: string; sessionId: string };
}

async function connectWebSocket(
  wsUrl: string,
  timeoutMs: number,
): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`websocket open timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolvePromise(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    };
  });
}

async function streamAudio(
  ws: WebSocket,
  audio: Buffer,
  config: SessionConfig,
): Promise<number> {
  for (
    let offset = 0;
    offset < audio.length;
    offset += config.audio.chunkBytes
  ) {
    ws.send(
      Uint8Array.from(audio.subarray(offset, offset + config.audio.chunkBytes)),
    );
    await Bun.sleep(config.audio.chunkMs);
  }
  ws.send(JSON.stringify({ type: config.messages.endOfInputType }));
  return nowMs();
}

function parseEvent(data: string): { type: string } {
  const parsed = JSON.parse(data) as { type?: unknown; event?: unknown };
  const type = typeof parsed.type === "string" ? parsed.type : parsed.event;
  if (typeof type !== "string") {
    throw new Error("websocket JSON event is missing type/event");
  }
  return { ...parsed, type } as { type: string };
}

function emptyMetrics(): Record<SessionMetric, number | null> {
  return Object.fromEntries(
    SESSION_METRICS.map((metric) => [metric, null]),
  ) as Record<SessionMetric, number | null>;
}

export function renderSessionRunTable(
  report: StagingReport<SessionMetric, SessionRun>,
): string[] {
  const lines = [
    "| Case | Run | Mint | Ready | EOS to STT | STT to LLM | LLM to audio | EOS to audio | Interrupt to silence | Post-interrupt binary | Error |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const run of report.runs) {
    const m = run.metrics;
    lines.push(
      `| ${run.caseId} | ${run.runIndex} | ${fmt(m.mintLatencyMs)} | ${fmt(m.helloToReadyMs)} | ${fmt(m.uplinkEndToSttFinalMs)} | ${fmt(m.sttFinalToLlmFirstTextMs)} | ${fmt(m.llmFirstTextToFirstTtsFrameMs)} | ${fmt(m.endOfUplinkToFirstAudioMs)} | ${fmt(m.interruptToSilenceMs)} | ${run.postInterruptBinaryFrames} | ${run.error ?? ""} |`,
    );
  }
  return lines;
}

function fmt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}

async function main(): Promise<void> {
  const args = parseSessionArgs(process.argv.slice(2));
  const config = readJsonConfig<SessionConfig>(args.config);
  const report = await runStagingSessionBenchmark({
    config,
    runs: args.runs,
    audioDir: args.audioDir ?? requiredEnv("VOICE_STAGING_AUDIO_DIR"),
    bearerToken: requiredEnv("VOICE_STAGING_BEARER_TOKEN"),
    agentId: requiredEnv("VOICE_STAGING_AGENT_ID"),
    conversationId: requiredEnv("VOICE_STAGING_CONVERSATION_ID"),
    nowIso: () => new Date().toISOString(),
  });
  const json = renderStagingJson(report);
  const markdown = renderStagingMarkdown(report, renderSessionRunTable(report));
  process.stdout.write(markdown);
  if (args.out) {
    writeReportFiles({
      outDir: args.out,
      json,
      markdown,
      jsonName: "staging-session.json",
      markdownName: "staging-session.md",
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
