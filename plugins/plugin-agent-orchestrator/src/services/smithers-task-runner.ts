import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TaskRunResult,
  TaskRunSpec,
  TaskStepContext,
  TaskStepExecutor,
} from "./smithers-task-types";

const DEFAULT_MAX_TURNS = 32;

interface StepRequest {
  type: "executeStep";
  requestId: string;
  kind: "provision" | "turn" | "approval" | "submit";
  ctx: TaskStepContext;
}

interface StepResponse {
  requestId: string;
  ok: boolean;
  output?: unknown;
  error?: { message: string };
}

const METHOD_BY_KIND = {
  provision: "provision",
  turn: "runTurn",
  approval: "requestApproval",
  submit: "submit",
} as const;

function sanitizeId(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "task"
  );
}

/**
 * Resolve the Bun executable. Smithers imports `bun:sqlite`, so the durable run
 * must execute under Bun. When the host is already Bun, reuse it; otherwise fall
 * back to `BUN_BIN` or `bun` on PATH (the host agent is Bun in production; this
 * keeps node+tsx dev hosts working too).
 */
function resolveBunBinary(): string {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined")
    return process.execPath;
  return process.env.BUN_BIN || "bun";
}

function resolveTaskDbPath(taskId: string): string {
  return join(
    process.cwd(),
    ".eliza",
    "smithers-tasks",
    `${sanitizeId(taskId)}.sqlite`,
  );
}

/**
 * Resolve the Smithers storage backend configuration from environment variables.
 *
 * SMITHERS_DB_PROVIDER: "sqlite" (default) | "postgres" | "pglite"
 * SMITHERS_DB_URL:      PostgreSQL connection string (used when provider = "postgres")
 * SMITHERS_DB_DATA_DIR: PGlite data directory (used when provider = "pglite")
 *
 * The resolved config is threaded through the subprocess payload so the layer
 * selection runs inside the subprocess script string.
 */
export function resolveSmithersDbConfig(): {
  provider: "sqlite" | "postgres" | "pglite";
  connectionString?: string;
  dataDir?: string;
} {
  const raw = process.env.SMITHERS_DB_PROVIDER ?? "sqlite";
  const provider = raw === "postgres" || raw === "pglite" ? raw : "sqlite";
  return {
    provider,
    connectionString: process.env.SMITHERS_DB_URL,
    dataDir: process.env.SMITHERS_DB_DATA_DIR,
  };
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
      // keep walking up to the plugin root
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Source for the per-task Smithers subprocess. Built as a string and run under a
 * fresh Bun process per task so the global Smithers singleton + SQLite state are
 * isolated (a long-lived singleton degrades across runs) and so a crashed task
 * resumes cleanly: re-running with the same `runId` and `force: false` skips the
 * already-completed steps/turns (verified) and re-drives only the rest.
 *
 * The graph is: provision? → (loop of agent turns per agent, parallel when
 * fanning out) → approval? → submit?. Every step delegates its real work to the
 * parent over a line-delimited stdin/stdout protocol; the parent owns the actual
 * work and assembles the result from the responses it observes (a step's `run`
 * is not given prior step outputs, so the result cannot be assembled in-script).
 */
function createTaskScript(): string {
  return String.raw`
    import { Smithers } from 'smithers-orchestrator';
    import { Effect, Schema } from 'effect';
    import { createInterface } from 'node:readline/promises';

    const payload = JSON.parse(process.env.ELIZA_TASK_RUN_PAYLOAD ?? '{}');
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Map();
    let requestSeq = 0;

    function emit(message) {
      process.stdout.write(JSON.stringify(message) + '\n');
    }

    (async () => {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        const entry = pending.get(response.requestId);
        if (!entry) continue;
        pending.delete(response.requestId);
        if (!response.ok) entry.reject(new Error(response.error?.message ?? 'Task step failed'));
        else entry.resolve(response.output);
      }
    })();

    function delegate(kind, ctx) {
      const requestId = String(++requestSeq);
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        emit({ type: 'executeStep', requestId, kind, ctx });
      });
    }

    const baseCtx = () => ({ taskId: payload.taskId, runId: payload.runId, prompt: payload.initialPrompt });

    try {
      const wf = Smithers.workflow({ name: payload.workflowName, input: Schema.Unknown });
      const agents = Math.max(1, payload.parallelAgents ?? 1);
      const maxTurns = Math.max(1, payload.maxTurns ?? ${DEFAULT_MAX_TURNS});
      const perAgentTurn = {};
      const nodes = [];

      if (payload.provision) {
        nodes.push(wf.step('provision-step', {
          output: Schema.Unknown,
          run: async () => { await delegate('provision', baseCtx()); return { ok: true }; },
        }));
      }

      const makeAgentLoop = (agentIndex) => {
        const turnId = 'agent-' + agentIndex + '-turn';
        const turnStep = wf.step(turnId, {
          output: Schema.Unknown,
          run: async () => {
            perAgentTurn[agentIndex] = (perAgentTurn[agentIndex] ?? 0) + 1;
            const out = await delegate('turn', { ...baseCtx(), agentIndex, turn: perAgentTurn[agentIndex] });
            return { done: out?.done === true };
          },
        });
        return wf.loop({
          id: 'agent-' + agentIndex + '-loop',
          children: turnStep,
          until: (o) => o?.[turnId]?.done === true,
          maxIterations: maxTurns,
          onMaxReached: 'return-last',
        });
      };

      const loops = Array.from({ length: agents }, (_, i) => makeAgentLoop(i));
      nodes.push(agents === 1 ? loops[0] : wf.parallel(...loops));

      if (payload.approvalBeforeSubmit) {
        nodes.push(wf.step('approval-step', {
          output: Schema.Unknown,
          run: async () => { await delegate('approval', baseCtx()); return { ok: true }; },
        }));
      }

      if (payload.submit) {
        nodes.push(wf.step('submit-step', {
          output: Schema.Unknown,
          run: async () => { await delegate('submit', baseCtx()); return { ok: true }; },
        }));
      }

      const built = wf.from(wf.sequence(...nodes));
      // Select the storage backend based on the provider field threaded through
      // the payload. Feature-detect non-sqlite APIs: smithers-orchestrator@0.22.0
      // does not yet expose Smithers.postgres / Smithers.pglite; if the method is
      // absent we degrade to sqlite so old and new builds both work correctly.
      const dbConfig = payload.dbConfig ?? {};
      const provider = dbConfig.provider ?? 'sqlite';
      let smithersLayer;
      if (provider !== 'sqlite' && typeof Smithers[provider] === 'function') {
        if (provider === 'postgres') {
          smithersLayer = Smithers.postgres({ connectionString: dbConfig.connectionString });
        } else if (provider === 'pglite') {
          smithersLayer = Smithers.pglite({ dataDir: dbConfig.dataDir });
        } else {
          smithersLayer = Smithers.sqlite({ filename: payload.dbPath });
        }
      } else {
        smithersLayer = Smithers.sqlite({ filename: payload.dbPath });
      }
      await Effect.runPromise(
        built
          .execute(
            { taskId: payload.taskId, runId: payload.runId },
            { runId: payload.runId, force: false, rootDir: payload.rootDir ?? process.cwd(), allowNetwork: true }
          )
          .pipe(Effect.provide(smithersLayer))
      );
      process.exit(0);
    } catch (error) {
      console.error(error?.stack ?? error?.message ?? String(error));
      process.exit(1);
    }
  `;
}

/**
 * Run a coding task on the durable Smithers engine, delegating each step to the
 * given executor. Resolves with the assembled {@link TaskRunResult}. Re-invoking
 * with the same `spec.runId` after a crash resumes the task from its last
 * completed step/turn (completed work is not repeated); the result then reflects
 * the steps re-driven in this invocation.
 */
export async function runTaskWithSmithers(
  spec: TaskRunSpec,
  executor: TaskStepExecutor,
  options: { signal?: AbortSignal } = {},
): Promise<TaskRunResult> {
  const dbPath = resolveTaskDbPath(spec.taskId);
  await mkdir(dirname(dbPath), { recursive: true });
  const agents = Math.max(1, spec.parallelAgents ?? 1);
  const dbConfig = resolveSmithersDbConfig();

  const payload = JSON.stringify({
    taskId: spec.taskId,
    runId: spec.runId,
    workflowName: sanitizeId(spec.taskId),
    initialPrompt: spec.initialPrompt,
    provision: spec.provision === true,
    submit: spec.submit === true,
    approvalBeforeSubmit: spec.approvalBeforeSubmit === true,
    maxTurns: spec.maxTurns ?? DEFAULT_MAX_TURNS,
    parallelAgents: agents,
    dbPath,
    dbConfig,
    rootDir: process.cwd(),
  });

  const pluginRoot = await resolvePluginRoot();
  const proc = spawn(resolveBunBinary(), ["-e", createTaskScript()], {
    cwd: pluginRoot,
    env: { ...process.env, ELIZA_TASK_RUN_PAYLOAD: payload },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const onAbort = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const startedAt = Date.now();
  // Result assembled from observed step responses (a step's run isn't given
  // prior outputs, so the script can't assemble it).
  const assembled = {
    workspace: undefined as Record<string, unknown> | undefined,
    submitOutput: undefined as Record<string, unknown> | undefined,
    approved: true,
    turns: 0,
    agentsDone: new Array<boolean>(agents).fill(false),
  };
  let stderr = "";
  const inflight: Promise<void>[] = [];

  const writeResponse = (response: StepResponse): void => {
    if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(response)}\n`);
  };

  const record = (
    kind: StepRequest["kind"],
    ctx: TaskStepContext,
    output: unknown,
  ): void => {
    const out = (output ?? {}) as Record<string, unknown>;
    if (kind === "provision") {
      assembled.workspace =
        (out.workspace as Record<string, unknown>) ?? assembled.workspace;
    } else if (kind === "turn") {
      assembled.turns += 1;
      assembled.agentsDone[ctx.agentIndex ?? 0] = out.done === true;
    } else if (kind === "approval") {
      assembled.approved = out.approved !== false;
    } else if (kind === "submit") {
      assembled.submitOutput =
        (out.output as Record<string, unknown>) ?? assembled.submitOutput;
    }
  };

  const dispatchStep = (request: StepRequest): void => {
    // Enforce the approval gate parent-side: a denied task skips submit entirely.
    if (request.kind === "submit" && !assembled.approved) {
      writeResponse({
        requestId: request.requestId,
        ok: true,
        output: { skipped: true },
      });
      return;
    }
    const handler = executor[METHOD_BY_KIND[request.kind]] as
      | ((ctx: TaskStepContext) => Promise<unknown>)
      | undefined;
    if (typeof handler !== "function") {
      // Optional step with no executor method → use an empty default response
      // rather than wedging the run (turn always has a handler — it's required).
      const fallback = request.kind === "approval" ? { approved: true } : {};
      writeResponse({
        requestId: request.requestId,
        ok: true,
        output: fallback,
      });
      return;
    }
    inflight.push(
      handler
        .call(executor, request.ctx)
        .then((output) => {
          record(request.kind, request.ctx, output);
          writeResponse({ requestId: request.requestId, ok: true, output });
        })
        .catch((error: unknown) =>
          writeResponse({
            requestId: request.requestId,
            ok: false,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        ),
    );
  };

  const handleLine = (line: string): void => {
    // The subprocess shares stdout with Smithers' own logging; only our
    // newline-delimited protocol JSON is relevant, so ignore everything else.
    const trimmed = line.trim();
    if (trimmed?.[0] !== "{") return;
    let message: StepRequest;
    try {
      message = JSON.parse(trimmed) as StepRequest;
    } catch {
      return;
    }
    if (message.type === "executeStep") dispatchStep(message);
  };

  proc.stdout.setEncoding("utf8");
  let buffer = "";
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => resolve(code ?? 1));
  });
  options.signal?.removeEventListener("abort", onAbort);
  if (buffer.trim()) handleLine(buffer);
  // Only drain in-flight executor calls on a clean exit. On a crash/kill the
  // subprocess is gone and any pending call (e.g. an in-flight turn) is moot —
  // awaiting it could hang forever.
  if (exitCode === 0) await Promise.all(inflight);

  if (exitCode !== 0) {
    throw new Error(
      `Smithers task execution failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }

  const status: TaskRunResult["status"] = !assembled.approved
    ? "denied"
    : assembled.agentsDone.length > 0 && assembled.agentsDone.every(Boolean)
      ? "completed"
      : "incomplete";

  return {
    taskId: spec.taskId,
    runId: spec.runId,
    status,
    turns: assembled.turns,
    approved: assembled.approved,
    workspace: assembled.workspace,
    submit: assembled.approved ? assembled.submitOutput : undefined,
    agentsDone: assembled.agentsDone,
    metrics: {
      turns: assembled.turns,
      agents,
      retries: 0,
      durationMs: Date.now() - startedAt,
    },
  };
}
