/**
 * Evidence sink: structured logging, token redaction, stage-timing ledger,
 * artifact writing with SHA-256, and a fail-loud completeness gate.
 *
 * Design law (DoD 16011 post-mortem): absent measurements read as ABSENT, never
 * as a healthy zero. A required stage that never fired is recorded as
 * `not_reached(reason)` and makes the whole run FAIL. There is no path that
 * coerces missing data into 0.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Side = "client" | "server" | "provider" | "harness";

export interface LogEntry {
  ts: string;
  monoMs: number;
  side: Side;
  level: "info" | "warn" | "error";
  msg: string;
  data?: Record<string, unknown>;
}

/** A pipeline stage we require timing evidence for. */
export type StageName =
  | "mint"
  | "ws_hello"
  | "ready"
  | "stt_first_partial"
  | "stt_final"
  | "llm_first_text"
  | "tts_first_frame"
  | "tts_complete"
  | "interrupt_requested"
  | "interrupt_to_silence";

export interface StageMark {
  stage: StageName;
  monoMs: number;
  reached: true;
}

export interface StageMiss {
  stage: StageName;
  reached: false;
  reason: string;
}

export type StageRecord = StageMark | StageMiss;

/** Redact anything that looks like a provider secret or bearer token. */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/Token\s+[A-Za-z0-9._-]{12,}/g, "Token <REDACTED>"],
  [/Bearer\s+[A-Za-z0-9._-]{12,}/g, "Bearer <REDACTED>"],
  [/("?(?:api[_-]?key|apiKey|X-API-Key|Authorization|token|deepgramApiKey)"?\s*[:=]\s*")[^"]+(")/gi, '$1<REDACTED>$2'],
  [/sk-[A-Za-z0-9]{16,}/g, "sk-<REDACTED>"],
];

export function redact<T>(value: T): T {
  if (typeof value === "string") {
    let s = value;
    for (const [re, rep] of REDACT_PATTERNS) s = s.replace(re, rep);
    return s as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(^|[_-])(key|token|authorization|secret)$/i.test(k) && typeof v === "string") {
        out[k] = "<REDACTED>";
      } else {
        out[k] = redact(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

export class Evidence {
  readonly dir: string;
  readonly startMono: number;
  private readonly logs: LogEntry[] = [];
  private readonly clientLogs: LogEntry[] = [];
  private readonly serverLogs: LogEntry[] = [];
  private readonly stages = new Map<StageName, StageRecord>();
  private readonly wsTranscript: Array<Record<string, unknown>> = [];
  private readonly artifacts: Array<{ name: string; bytes: number; sha256: string; note?: string }> = [];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.startMono = performance.now();
  }

  private now(): number {
    return performance.now() - this.startMono;
  }

  log(side: Side, level: LogEntry["level"], msg: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      monoMs: Number(this.now().toFixed(3)),
      side,
      level,
      msg: redact(msg),
      data: data ? redact(data) : undefined,
    };
    this.logs.push(entry);
    if (side === "client") this.clientLogs.push(entry);
    if (side === "server" || side === "provider") this.serverLogs.push(entry);
    const line = `[${entry.monoMs.toFixed(1)}ms][${side}][${level}] ${entry.msg}`;
    if (level === "error") console.error(line);
    else console.log(line);
  }

  /** Record a WS control/audio event exactly as it crossed the wire (redacted). */
  wsEvent(direction: "c2s" | "s2c", kind: "json" | "binary", payload: Record<string, unknown>): void {
    this.wsTranscript.push({
      monoMs: Number(this.now().toFixed(3)),
      direction,
      kind,
      ...redact(payload),
    });
  }

  mark(stage: StageName): void {
    if (this.stages.has(stage)) return; // first occurrence wins
    this.stages.set(stage, { stage, monoMs: Number(this.now().toFixed(3)), reached: true });
    this.log("harness", "info", `stage:${stage}`, { monoMs: this.now() });
  }

  miss(stage: StageName, reason: string): void {
    if (this.stages.get(stage)?.reached) return;
    this.stages.set(stage, { stage, reached: false, reason });
  }

  stageMs(stage: StageName): number | null {
    const r = this.stages.get(stage);
    return r && r.reached ? r.monoMs : null;
  }

  /** Delta between two reached stages, or null if either is missing. Never 0-for-missing. */
  stageDelta(from: StageName, to: StageName): number | null {
    const a = this.stageMs(from);
    const b = this.stageMs(to);
    if (a === null || b === null) return null;
    return Number((b - a).toFixed(3));
  }

  writeArtifact(name: string, bytes: Uint8Array, note?: string): string {
    const path = join(this.dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.artifacts.push({ name, bytes: bytes.byteLength, sha256, note });
    this.log("harness", "info", `artifact:${name}`, { bytes: bytes.byteLength, sha256 });
    return sha256;
  }

  writeJsonArtifact(name: string, value: unknown, note?: string): string {
    return this.writeArtifact(name, new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n"), note);
  }

  get artifactIndex(): ReadonlyArray<{ name: string; bytes: number; sha256: string; note?: string }> {
    return this.artifacts;
  }

  get transcript(): ReadonlyArray<Record<string, unknown>> {
    return this.wsTranscript;
  }

  /** Flush per-side logs + transcript + timings to disk. */
  flushLogs(): void {
    this.writeJsonArtifact("ws-transcript.json", this.wsTranscript, "full WS message transcript (tokens redacted)");
    this.writeJsonArtifact("server.log.json", this.serverLogs, "server + provider structured logs");
    this.writeJsonArtifact("client.log.json", this.clientLogs, "client-side event log");
    this.writeJsonArtifact("all.log.json", this.logs, "combined structured log");
  }

  /**
   * Build the stage timing report. Required stages that never fired are surfaced
   * as `not_reached`, which the caller uses to FAIL the run.
   */
  timingReport(requiredStages: StageName[]): {
    stages: StageRecord[];
    deltas: Record<string, number | null>;
    missing: string[];
  } {
    const stages: StageRecord[] = [];
    const missing: string[] = [];
    for (const s of requiredStages) {
      const rec = this.stages.get(s) ?? { stage: s, reached: false as const, reason: "stage never fired" };
      stages.push(rec);
      if (!rec.reached) missing.push(s);
    }
    const deltas: Record<string, number | null> = {
      "mint->ready": this.stageDelta("mint", "ready"),
      "ready->stt_final": this.stageDelta("ready", "stt_final"),
      "stt_final->llm_first_text": this.stageDelta("stt_final", "llm_first_text"),
      "llm_first_text->tts_first_frame": this.stageDelta("llm_first_text", "tts_first_frame"),
      "stt_final->tts_first_frame": this.stageDelta("stt_final", "tts_first_frame"),
      "tts_first_frame->tts_complete": this.stageDelta("tts_first_frame", "tts_complete"),
      "interrupt_requested->interrupt_to_silence": this.stageDelta(
        "interrupt_requested",
        "interrupt_to_silence",
      ),
    };
    return { stages, deltas, missing };
  }
}
