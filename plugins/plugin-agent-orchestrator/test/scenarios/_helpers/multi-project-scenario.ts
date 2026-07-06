/**
 * Shared infrastructure for the multi-project orchestration scenarios: a
 * cap-enforcing deterministic ACP, an evidence-grounded deterministic judge
 * runtime, and a real project-registry fixture in a temp state dir.
 *
 * The two multi-project scenario files (portfolio + failure-isolation) drive
 * the REAL `OrchestratorTaskService` (event bridge, transition table, admission
 * queue, auto goal-verify) over this fake transport, the same self-contained
 * style `orchestrator-concurrency-admission.scenario.ts` established — keyless,
 * no subprocess, pr-deterministic. The judge here is NOT rigged to pass: it
 * reads the verifier prompt's own evidence section and only passes completions
 * that carry concrete test-output proof, so a broken evidence pipeline fails
 * the scenario.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertProject } from "@elizaos/core";
import type { OrchestratorTaskStore } from "../../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskDocument } from "../../../src/services/orchestrator-task-types.js";
import {
  SessionCapError,
  type SessionInfo,
  type SpawnOptions,
  type SpawnResult,
} from "../../../src/services/types.js";

const TERMINAL_ACP_STATUSES = new Set([
  "stopped",
  "completed",
  "error",
  "errored",
  "cancelled",
]);

/**
 * Deterministic ACP transport with real worker-slot accounting: throws
 * `SessionCapError` past the cap (so the real admission queue parks spawns),
 * records every forwarded prompt for routing assertions, and lets scenarios
 * drive session lifecycles by emitting the same events the real transport does.
 */
export class MultiProjectAcp {
  readonly sent: Array<{ sessionId: string; text: string }> = [];
  /** Highest concurrent non-terminal worker count ever observed — the
   * concurrency-respected proof. */
  workerHighWaterMark = 0;
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly handlers = new Set<
    (sessionId: string, event: string, data: unknown) => void
  >();
  private readonly initialTasks = new Map<string, string>();
  private counter = 0;

  constructor(private readonly maxSessions = Number.POSITIVE_INFINITY) {}

  private activeWorkers(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (!TERMINAL_ACP_STATUSES.has(s.status)) n++;
    }
    return n;
  }

  async getCapacity() {
    const workers = this.activeWorkers();
    const max = Number.isFinite(this.maxSessions) ? this.maxSessions : 1024;
    return {
      maxSessions: max,
      systemHeadroom: 2,
      activeWorkers: workers,
      activeSystem: 0,
      freeWorkerSlots: Math.max(0, max - workers),
      freeSystemSlots: 2,
    };
  }

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const slotClass = opts.slotClass ?? "worker";
    if (slotClass === "worker" && this.activeWorkers() >= this.maxSessions) {
      throw new SessionCapError(
        "worker",
        Number(this.maxSessions),
        this.activeWorkers(),
      );
    }
    const id = `multi-project-sess-${++this.counter}`;
    const now = new Date();
    const session: SessionInfo = {
      id,
      name: opts.name ?? id,
      agentType: opts.agentType ?? "opencode",
      workdir: opts.workdir ?? "/tmp/multi-project",
      status: "ready",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: now,
      lastActivityAt: now,
      metadata: { ...(opts.metadata ?? {}), slotClass },
    };
    this.sessions.set(id, session);
    this.initialTasks.set(id, opts.initialTask ?? "");
    this.workerHighWaterMark = Math.max(
      this.workerHighWaterMark,
      this.activeWorkers(),
    );
    return {
      sessionId: id,
      id,
      name: session.name ?? id,
      agentType: session.agentType,
      workdir: session.workdir,
      status: session.status,
      metadata: session.metadata,
    };
  }

  /** The goal prompt handed to a spawned session at spawn time. */
  initialTaskFor(sessionId: string): string | undefined {
    return this.initialTasks.get(sessionId);
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  readySessions(): SessionInfo[] {
    return this.listSessions().filter((s) => s.status === "ready");
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    return this.sessions.get(id) ?? null;
  }

  getChangedPaths(): string[] {
    return [];
  }

  async stopSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.status = "stopped";
    this.emit(id, "stopped", { sessionId: id });
  }

  async sendToSession(id: string, text: string) {
    this.sent.push({ sessionId: id, text });
    // A corrective re-dispatch reactivates the worker: mirror the real
    // transport, where a kept-alive session goes back to work on a follow-up.
    const s = this.sessions.get(id);
    if (s && s.status === "completed") s.status = "ready";
    return {
      sessionId: id,
      finalText: "ack",
      response: "ack",
      stopReason: "end_turn",
      durationMs: 1,
    };
  }

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    for (const h of [...this.handlers]) h(sessionId, event, data);
  }

  /** Complete a live session: free its slot and emit task_complete so the real
   * service advances the task through validating → auto-verify. */
  complete(id: string, response: string): void {
    const s = this.sessions.get(id);
    if (s) s.status = "completed";
    this.emit(id, "task_complete", { response });
  }

  /** Crash a live session: free its slot and emit the error the real event
   * bridge classifies (a plain crash is un-respawnable → terminal `failed`). */
  crash(id: string, message: string): void {
    const s = this.sessions.get(id);
    if (s) s.status = "errored";
    this.emit(id, "error", { message });
  }
}

/**
 * Evidence-grounded deterministic verdict for the auto goal-verifier's judge
 * prompt: pass ONLY when the prompt's completion-evidence section carries a
 * concrete passing-test line; otherwise fail with the prompt's own acceptance
 * criteria as `missing` (which drives the real corrective re-prompt path).
 */
export function judgeVerdictFromPrompt(prompt: string): {
  passed: boolean;
  summary: string;
  missing: string[];
} {
  const evidenceStart = prompt.indexOf("---");
  const evidenceEnd = prompt.lastIndexOf("---");
  const evidence =
    evidenceStart >= 0 && evidenceEnd > evidenceStart
      ? prompt.slice(evidenceStart + 3, evidenceEnd)
      : "";
  if (/Tests \d+ passed/.test(evidence)) {
    return {
      passed: true,
      summary: "Every acceptance criterion is backed by pasted test output.",
      missing: [],
    };
  }
  const criteriaSection = prompt.split(
    "Acceptance criteria (each must hold for the task to pass):",
  )[1];
  const missing = (criteriaSection ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s/.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, ""));
  return {
    passed: false,
    summary: "No concrete test output was pasted; the claim is unproven.",
    missing: missing.length > 0 ? missing : ["concrete proof of completion"],
  };
}

/** Minimal runtime stub the real OrchestratorTaskService runs against: the only
 * model surface it exercises here is the goal-verifier judge, answered by
 * {@link judgeVerdictFromPrompt}. */
export function makeMultiProjectRuntime(
  acp: MultiProjectAcp,
  opts: { agentId: string; onJudge?: (prompt: string) => void },
): unknown {
  return {
    agentId: opts.agentId,
    character: { name: "MultiProjectOrchestrator" },
    databaseAdapter: undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    reportError() {},
    useModel: async (_type: unknown, params: { prompt?: string } = {}) => {
      const prompt = params.prompt ?? "";
      if (prompt.includes("demanding engineering manager")) {
        opts.onJudge?.(prompt);
        return JSON.stringify(judgeVerdictFromPrompt(prompt));
      }
      return "{}";
    },
    getService: (type: string) =>
      type === "ACP_SUBPROCESS_SERVICE" ? acp : undefined,
  };
}

/** Set env overrides for a scenario run; returns a restore fn for `finally`.
 * `undefined` deletes the key for the run. */
export function applyScenarioEnv(
  overrides: Record<string, string | undefined>,
): () => void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export interface ScenarioProject {
  /** Registered project-registry id (the durable binding key). */
  id: string;
  name: string;
  /** The project's real localPath under the temp state dir — every session of
   * a task bound to this project must spawn exactly here. */
  localPath: string;
  /** Distinct origin room per project. */
  roomId: string;
}

/**
 * Mint a temp state dir, point `ELIZA_STATE_DIR` at it, and register one REAL
 * project-registry record per name (each with its own on-disk localPath). The
 * returned restore fn puts the env back; the temp dir is left for the OS tmp
 * reaper, matching the other orchestrator scenario fixtures.
 */
export function registerScenarioProjects(
  prefix: string,
  names: string[],
): { projects: ScenarioProject[]; restoreEnv: () => void } {
  const stateDir = mkdtempSync(join(tmpdir(), `${prefix}-state-`));
  const restoreEnv = applyScenarioEnv({ ELIZA_STATE_DIR: stateDir });
  const projects = names.map((name, index) => {
    const localPath = join(stateDir, "checkouts", name);
    mkdirSync(localPath, { recursive: true });
    const record = upsertProject({ name, localPath });
    return {
      id: record.id,
      name,
      localPath: record.localPath,
      roomId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    };
  });
  return { projects, restoreEnv };
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`multi-project scenario timed out waiting for ${label}`);
}

export async function waitForTask(
  store: OrchestratorTaskStore,
  taskId: string,
  predicate: (doc: OrchestratorTaskDocument) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<OrchestratorTaskDocument> {
  const deadline = Date.now() + timeoutMs;
  let last: OrchestratorTaskDocument | null = null;
  while (Date.now() < deadline) {
    last = await store.getTask(taskId);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `multi-project scenario timed out waiting for ${label}; last status=${
      last?.task.status ?? "(missing)"
    }, events=${last ? last.events.map((e) => e.eventType).join(",") : "(none)"}`,
  );
}

/** Every event on the doc must reference either no session or one of the
 * task's OWN sessions — the cross-task/cross-project routing invariant.
 * Returns the ids of foreign sessions found (empty = clean). */
export function foreignEventSessions(doc: OrchestratorTaskDocument): string[] {
  const own = new Set(doc.sessions.map((s) => s.sessionId));
  const foreign = new Set<string>();
  for (const event of doc.events) {
    if (event.sessionId && !own.has(event.sessionId)) {
      foreign.add(event.sessionId);
    }
  }
  for (const message of doc.messages) {
    if (message.sessionId && !own.has(message.sessionId)) {
      foreign.add(message.sessionId);
    }
  }
  return [...foreign];
}
