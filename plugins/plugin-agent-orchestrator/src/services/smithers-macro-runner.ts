/**
 * Observability-only Smithers macro-run for an existing issue-to-validated-PR
 * chain. Smithers records the phase boundaries, attempts, events, and rendered
 * frames while the host remains the owner of every operation and verdict.
 *
 * This adapter deliberately does not create branches or PRs, run agents, or
 * decide whether CI passed. Its executor observes the existing Eliza chain and
 * returns references to work already performed by the authoritative services.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SMITHERS_MACRO_PHASES = [
  "issue-intake",
  "branch",
  "implement",
  "test",
  "pr",
  "ci-verdict",
] as const;

export type SmithersMacroPhase = (typeof SMITHERS_MACRO_PHASES)[number];

export interface SmithersMacroCorrelation {
  /** Smithers execution identity, shared by the entire macro-run. */
  smithersRunId: string;
  /** Stable Smithers node id for this phase. */
  smithersNodeId: SmithersMacroPhase;
  /** Smithers' 1-based attempt number for this node. */
  smithersAttempt: number;
  /** Existing Eliza orchestrator task identity. */
  elizaTaskId: string;
  /** Existing Eliza trajectory identity, when trajectory recording is enabled. */
  trajectoryId?: string;
}

export interface SmithersMacroPhaseContext extends SmithersMacroCorrelation {
  issueNumber: number;
  repository: string;
}

export interface SmithersMacroPhaseEvidence {
  /** Short, durable statement of what the existing chain observed. */
  summary: string;
  /** References only. External writes must happen outside this macro-run. */
  references?: Record<string, string>;
}

export interface SmithersMacroRunSpec {
  runId: string;
  elizaTaskId: string;
  trajectoryId?: string;
  repository: string;
  issueNumber: number;
  /** Stable project root used by Smithers and its native monitor. */
  rootDir?: string;
}

export interface SmithersMacroExecutor {
  observePhase(
    phase: SmithersMacroPhase,
    context: SmithersMacroPhaseContext,
  ): Promise<SmithersMacroPhaseEvidence>;
}

export interface SmithersMacroFrameEvent {
  phase: SmithersMacroPhase;
  correlation: SmithersMacroCorrelation;
  evidence: SmithersMacroPhaseEvidence;
}

export interface SmithersMacroRunResult {
  runId: string;
  status: "completed";
  databasePath: string;
  phases: SmithersMacroFrameEvent[];
  watch: {
    /** Native live web monitor. Run from rootDir while the macro is active. */
    monitorCommand: string;
    /** Native structured run/frame inspection, also works after completion. */
    inspectCommand: string;
    /** Native ordered event replay, also works after completion. */
    replayCommand: string;
  };
}

interface PhaseRequest {
  type: "observePhase";
  requestId: string;
  phase: SmithersMacroPhase;
  correlation: SmithersMacroCorrelation;
}

interface PhaseResponse {
  requestId: string;
  ok: boolean;
  evidence?: SmithersMacroPhaseEvidence;
  error?: { message: string };
}

interface MacroResultMessage {
  type: "macroResult";
}

function sanitizeId(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "run"
  );
}

function resolveBunBinary(): string {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined")
    return process.execPath;
  return process.env.BUN_BIN || "bun";
}

async function resolvePluginRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(
        await readFile(join(dir, "package.json"), "utf8"),
      ) as {
        name?: string;
      };
      if (manifest.name === "@elizaos/plugin-agent-orchestrator") return dir;
    } catch {
      // Expected while walking from src/services to the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function createMacroScript(): string {
  return String.raw`
    import { Smithers } from '@smithers-orchestrator/engine';
    import { Effect, Schema } from 'effect';
    import { createInterface } from 'node:readline/promises';

    const payload = JSON.parse(process.env.ELIZA_SMITHERS_MACRO_PAYLOAD ?? '{}');
    const phases = ['issue-intake', 'branch', 'implement', 'test', 'pr', 'ci-verdict'];
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Map();
    let requestSeq = 0;

    function emit(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
    (async () => {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        const entry = pending.get(response.requestId);
        if (!entry) continue;
        pending.delete(response.requestId);
        if (response.ok) entry.resolve(response.evidence);
        else entry.reject(new Error(response.error?.message ?? 'Macro phase observation failed'));
      }
    })();

    function observe(phase, context) {
      const requestId = String(++requestSeq);
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        emit({
          type: 'observePhase',
          requestId,
          phase,
          correlation: {
            smithersRunId: payload.runId,
            smithersNodeId: phase,
            smithersAttempt: context.attempt,
            elizaTaskId: payload.elizaTaskId,
            ...(payload.trajectoryId ? { trajectoryId: payload.trajectoryId } : {}),
          },
        });
      });
    }

    try {
      const workflow = Smithers.workflow({ name: 'eliza-issue-to-validated-pr', input: Schema.Unknown });
      const steps = phases.map((phase) => workflow.step(phase, {
        output: Schema.Unknown,
        run: async (context) => ({
          phase,
          correlation: {
            smithersRunId: payload.runId,
            smithersNodeId: phase,
            smithersAttempt: context.attempt,
            elizaTaskId: payload.elizaTaskId,
            ...(payload.trajectoryId ? { trajectoryId: payload.trajectoryId } : {}),
          },
          evidence: await observe(phase, context),
        }),
      }));
      const built = workflow.from(workflow.sequence(...steps));
      await Effect.runPromise(
        built.execute(
          { repository: payload.repository, issueNumber: payload.issueNumber },
          {
            runId: payload.runId,
            force: false,
            rootDir: payload.rootDir,
            allowNetwork: false,
          },
        ).pipe(Effect.provide(Smithers.sqlite({ filename: payload.databasePath }))),
      );
      emit({ type: 'macroResult' });
      process.exit(0);
    } catch (error) {
      console.error(error?.stack ?? error?.message ?? String(error));
      process.exit(1);
    }
  `;
}

/**
 * Record an existing issue-to-validated-PR chain as one durable Smithers run.
 * Completed nodes are skipped when invoked again with the same run id. PR
 * creation and merge are intentionally outside the workflow; the `pr` phase may
 * only return a reference to an already-created PR.
 */
export async function runSmithersObservabilityMacro(
  spec: SmithersMacroRunSpec,
  executor: SmithersMacroExecutor,
): Promise<SmithersMacroRunResult> {
  const rootDir = spec.rootDir ?? process.cwd();
  const databasePath = join(rootDir, ".smithers", "smithers.db");
  await mkdir(dirname(databasePath), { recursive: true });
  const pluginRoot = await resolvePluginRoot();
  const payload = JSON.stringify({ ...spec, rootDir, databasePath });
  const proc = spawn(resolveBunBinary(), ["-e", createMacroScript()], {
    cwd: pluginRoot,
    env: { ...process.env, ELIZA_SMITHERS_MACRO_PAYLOAD: payload },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const phases: SmithersMacroFrameEvent[] = [];
  const inflight: Promise<void>[] = [];
  let completed = false;
  let stderr = "";

  const respond = (response: PhaseResponse): void => {
    if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(response)}\n`);
  };
  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed[0] !== "{") return;
    let message: PhaseRequest | MacroResultMessage;
    try {
      message = JSON.parse(trimmed) as PhaseRequest | MacroResultMessage;
    } catch {
      return;
    }
    if (message.type === "macroResult") {
      completed = true;
      proc.stdin.end();
      return;
    }
    const context: SmithersMacroPhaseContext = {
      ...message.correlation,
      repository: spec.repository,
      issueNumber: spec.issueNumber,
    };
    inflight.push(
      executor
        .observePhase(message.phase, context)
        .then((evidence) => {
          phases.push({
            phase: message.phase,
            correlation: message.correlation,
            evidence,
          });
          respond({ requestId: message.requestId, ok: true, evidence });
        })
        .catch((error: unknown) => {
          respond({
            requestId: message.requestId,
            ok: false,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }),
    );
  };

  let stdout = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  if (stdout.trim()) handleLine(stdout);
  if (exitCode === 0) await Promise.all(inflight);
  if (exitCode !== 0) {
    throw new Error(
      `Smithers macro-run failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  if (!completed)
    throw new Error("Smithers macro-run exited without a completion message");

  phases.sort(
    (a, b) =>
      SMITHERS_MACRO_PHASES.indexOf(a.phase) -
      SMITHERS_MACRO_PHASES.indexOf(b.phase),
  );
  const runId = sanitizeId(spec.runId);
  return {
    runId: spec.runId,
    status: "completed",
    databasePath,
    phases,
    watch: {
      monitorCommand: `bunx smithers-orchestrator monitor ${runId}`,
      inspectCommand: `bunx smithers-orchestrator inspect ${runId}`,
      replayCommand: `bunx smithers-orchestrator events --run ${runId} --no-follow`,
    },
  };
}
