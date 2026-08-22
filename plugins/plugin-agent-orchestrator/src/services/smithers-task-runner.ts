/**
 * Runs a durable multi-turn coding task by spawning a Bun subprocess that hosts
 * the Smithers workflow engine, and bridging its provision/turn/approval/submit
 * steps back to the parent over stdio. Each step the subprocess needs executed
 * is sent as a `StepRequest`, dispatched to the in-process `TaskStepExecutor`,
 * and answered with a `StepResponse`; turns are bounded by `DEFAULT_MAX_TURNS`.
 *
 * The run executes under Bun (Smithers imports `bun:sqlite`), and the task's
 * storage backend — sqlite, postgres, or PGlite — is resolved from environment.
 * Payloads cross a dedicated pipe, worker environments exclude provider secrets,
 * and a wall-clock deadline bounds every subprocess.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ElizaError } from "@elizaos/core";
import type {
  SmithersTaskExecution,
  TaskRunResult,
  TaskRunSpec,
  TaskStepContext,
  TaskStepExecutor,
} from "./smithers-task-types";

const DEFAULT_MAX_TURNS = 32;
const DEFAULT_SMITHERS_TIMEOUT_MS = 300_000;
const MAX_SMITHERS_TIMEOUT_MS = 2_147_483_647;
const ABORT_DRAIN_TIMEOUT_MS = 1_000;
const SMITHERS_WORKER_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "MSGPACKR_NATIVE_ACCELERATION_DISABLED",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
] as const;

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

interface TaskResultMessage {
  type: "taskResult";
  execution: SmithersTaskExecution;
}

const METHOD_BY_KIND = {
  provision: "provision",
  turn: "runTurn",
  approval: "requestApproval",
  submit: "submit",
} as const;

export interface DurableTaskTurnSnapshot {
  done: boolean;
  turn?: number;
  agentIndex?: number;
  output?: Record<string, unknown>;
}

interface DurableTaskSummary {
  version: 1;
  provision?: Record<string, unknown>;
  approval?: Record<string, unknown>;
  submit?: Record<string, unknown>;
  turns: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readDurableTaskSummary(
  execution: SmithersTaskExecution,
): DurableTaskSummary | undefined {
  const record = asRecord(execution);
  if (record?.version !== 1 || !Array.isArray(record.turns)) return undefined;
  const provision = asRecord(record.provision);
  const approval = asRecord(record.approval);
  const submit = asRecord(record.submit);
  return {
    version: 1,
    turns: record.turns,
    ...(provision ? { provision } : {}),
    ...(approval ? { approval } : {}),
    ...(submit ? { submit } : {}),
  };
}

/** Recover persisted turn results from Smithers' terminal graph output. */
export function collectDurableTaskTurns(
  execution: SmithersTaskExecution,
): DurableTaskTurnSnapshot[] {
  const queue: unknown[] = [execution];
  const turns: DurableTaskTurnSnapshot[] = [];
  for (let index = 0; index < queue.length && index < 10_000; index += 1) {
    const value = queue[index];
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (typeof record.done === "boolean") {
      const turn =
        typeof record.turn === "number" &&
        Number.isInteger(record.turn) &&
        record.turn > 0
          ? record.turn
          : undefined;
      const agentIndex =
        typeof record.agentIndex === "number" &&
        Number.isInteger(record.agentIndex) &&
        record.agentIndex >= 0
          ? record.agentIndex
          : undefined;
      turns.push({
        done: record.done,
        ...(turn === undefined ? {} : { turn }),
        ...(agentIndex === undefined ? {} : { agentIndex }),
        ...(record.output &&
        typeof record.output === "object" &&
        !Array.isArray(record.output)
          ? { output: record.output as Record<string, unknown> }
          : {}),
      });
      continue;
    }
    queue.push(...Object.values(record));
  }
  return turns;
}

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

function pathSegment(value: string, fallback: string): string {
  const readable =
    value
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || fallback;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
}

/** Resolve the tenant-isolated SQLite file for a durable coding task. */
export function resolveTaskDbPath(tenantId: string, taskId: string): string {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new ElizaError("Smithers task tenant id is required", {
      code: "SMITHERS_TASK_TENANT_REQUIRED",
    });
  }
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new ElizaError("Smithers task id is required", {
      code: "SMITHERS_TASK_ID_REQUIRED",
      context: { tenantId },
    });
  }
  return join(
    process.cwd(),
    ".eliza",
    "smithers-tasks",
    pathSegment(tenantId, "tenant"),
    `${pathSegment(taskId, "task")}.sqlite`,
  );
}

/**
 * Resolve one persistent PGlite database beneath the configured storage root.
 * PGlite is an embedded single-process database: separate Smithers workers
 * cannot safely open the same directory concurrently. The durable identifiers
 * keep retries of one run on the same database while isolating unrelated
 * tenant, task, and run subprocesses.
 */
export function resolveTaskPgliteDataDir(
  dataRoot: string,
  tenantId: string,
  taskId: string,
  runId: string,
): string {
  if (dataRoot.trim().length === 0) {
    throw new ElizaError("Smithers PGlite data root is required", {
      code: "SMITHERS_DB_DATA_DIR_REQUIRED",
    });
  }
  if (tenantId.trim().length === 0) {
    throw new ElizaError("Smithers task tenant id is required", {
      code: "SMITHERS_TASK_TENANT_REQUIRED",
    });
  }
  if (taskId.trim().length === 0) {
    throw new ElizaError("Smithers task id is required", {
      code: "SMITHERS_TASK_ID_REQUIRED",
      context: { tenantId },
    });
  }
  if (runId.trim().length === 0) {
    throw new ElizaError("Smithers task run id is required", {
      code: "SMITHERS_TASK_RUN_ID_REQUIRED",
      context: { tenantId, taskId },
    });
  }
  return resolve(
    dataRoot,
    pathSegment(tenantId, "tenant"),
    pathSegment(taskId, "task"),
    pathSegment(runId, "run"),
  );
}

/**
 * Resolve the Smithers storage backend configuration from environment variables.
 *
 * SMITHERS_DB_PROVIDER: "sqlite" (default) | "postgres" | "pglite"
 * SMITHERS_DB_URL:      PostgreSQL connection string (used when provider = "postgres")
 * SMITHERS_DB_DATA_DIR: PGlite data root (used when provider = "pglite")
 *
 * The resolved config is threaded through the subprocess payload so the layer
 * selection runs inside the subprocess script string.
 */
export function resolveSmithersDbConfig(): {
  provider: "sqlite" | "postgres" | "pglite";
  connectionString?: string;
  dataDir?: string;
} {
  const provider = (process.env.SMITHERS_DB_PROVIDER ?? "sqlite")
    .trim()
    .toLowerCase();
  if (
    provider !== "sqlite" &&
    provider !== "postgres" &&
    provider !== "pglite"
  ) {
    throw new ElizaError(
      `Unsupported Smithers database provider: ${provider}`,
      {
        code: "SMITHERS_DB_PROVIDER_INVALID",
        context: { provider },
      },
    );
  }
  if (provider === "postgres") {
    const connectionString = process.env.SMITHERS_DB_URL?.trim();
    if (!connectionString) {
      throw new ElizaError(
        "SMITHERS_DB_URL is required for the postgres backend",
        {
          code: "SMITHERS_DB_URL_REQUIRED",
          context: { provider },
        },
      );
    }
    return { provider, connectionString };
  }
  if (provider === "pglite") {
    const dataDir = process.env.SMITHERS_DB_DATA_DIR?.trim();
    if (!dataDir) {
      throw new ElizaError(
        "SMITHERS_DB_DATA_DIR is required for the pglite backend",
        {
          code: "SMITHERS_DB_DATA_DIR_REQUIRED",
          context: { provider },
        },
      );
    }
    return { provider, dataDir };
  }
  return { provider };
}

export function resolveSmithersTimeoutMs(explicitTimeoutMs?: number): number {
  const rawConfigured = process.env.ELIZA_SMITHERS_TIMEOUT_MS;
  let configured: number;
  if (explicitTimeoutMs !== undefined) {
    configured = explicitTimeoutMs;
  } else if (rawConfigured === undefined || rawConfigured === "") {
    configured = DEFAULT_SMITHERS_TIMEOUT_MS;
  } else {
    configured = /^[1-9]\d*$/.test(rawConfigured)
      ? Number(rawConfigured)
      : Number.NaN;
  }
  if (
    !Number.isSafeInteger(configured) ||
    configured <= 0 ||
    configured > MAX_SMITHERS_TIMEOUT_MS
  ) {
    const received = explicitTimeoutMs ?? rawConfigured;
    throw new ElizaError(
      `Smithers timeout must be an integer from 1 through ${MAX_SMITHERS_TIMEOUT_MS} milliseconds`,
      {
        code: "SMITHERS_TIMEOUT_INVALID",
        context: {
          configured: received,
          minimum: 1,
          maximum: MAX_SMITHERS_TIMEOUT_MS,
        },
      },
    );
  }
  return configured;
}

export function buildSmithersWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SMITHERS_WORKER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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
      // error-policy:J3 a missing/unreadable package.json at this level is the
      // expected "not the root here" probe result → keep walking up.
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
 * parent over a line-delimited stdin/stdout protocol. Live metrics come from the
 * responses the parent observes, while Smithers' terminal graph output crosses
 * back separately so a restarted parent can recover already-completed answers.
 */
function createTaskScript(): string {
  return String.raw`
    import { Smithers } from 'smthrs';
    import { Effect, Schema } from 'effect';
    import { readFileSync } from 'node:fs';
    import { createInterface } from 'node:readline/promises';

    const payload = JSON.parse(readFileSync(3, 'utf8'));
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Map();
    let requestSeq = 0;

    function emit(message) {
      return new Promise((resolve, reject) => {
        process.stdout.write(JSON.stringify(message) + '\n', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
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
        emit({ type: 'executeStep', requestId, kind, ctx }).catch((error) => {
          // error-policy:J1 translate a failed worker-protocol write into the
          // pending Smithers step promise observed by the durable runner.
          pending.delete(requestId);
          reject(error);
        });
      });
    }

    const baseCtx = () => ({ taskId: payload.taskId, runId: payload.runId, prompt: payload.initialPrompt });

    try {
      const wf = Smithers.workflow({ name: payload.workflowName, input: Schema.Unknown });
      const agents = Math.max(1, payload.parallelAgents ?? 1);
      const maxTurns = Math.max(1, payload.maxTurns ?? ${DEFAULT_MAX_TURNS});
      const latestTurnResults = new Array(agents);
      const nodes = [];
      const summaryNeeds = {};
      let approvalStep;

      if (payload.provision) {
        const provisionStep = wf.step('provision-step', {
          output: Schema.Unknown,
          run: async () => await delegate('provision', baseCtx()),
        });
        nodes.push(provisionStep);
        summaryNeeds.provision = provisionStep;
      }

      const makeAgentLoop = (agentIndex) => {
        const turnId = 'agent-' + agentIndex + '-turn';
        const turnStep = wf.step(turnId, {
          output: Schema.Unknown,
          run: async (smithersCtx) => {
            if (!Number.isInteger(smithersCtx.iteration) || smithersCtx.iteration < 0) {
              throw new Error('Smithers did not provide a valid durable loop iteration');
            }
            const turn = smithersCtx.iteration + 1;
            const out = await delegate('turn', { ...baseCtx(), agentIndex, turn });
            const result = { done: out?.done === true, turn, agentIndex, output: out?.output };
            latestTurnResults[agentIndex] = result;
            return result;
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
        approvalStep = wf.step('approval-step', {
          output: Schema.Unknown,
          run: async () => await delegate('approval', baseCtx()),
        });
        nodes.push(approvalStep);
        summaryNeeds.approval = approvalStep;
      }

      if (payload.submit) {
        const submitStep = wf.step('submit-step', {
          output: Schema.Unknown,
          ...(approvalStep ? { needs: { approval: approvalStep } } : {}),
          run: async (ctx) => {
            if (approvalStep && ctx.approval?.approved !== true) return { skipped: true };
            return await delegate('submit', baseCtx());
          },
        });
        nodes.push(submitStep);
        summaryNeeds.submit = submitStep;
      }

      if (Object.keys(summaryNeeds).length > 0) {
        const resultStep = wf.step('task-result-step', {
          output: Schema.Unknown,
          needs: summaryNeeds,
          run: async (ctx) => ({
            version: 1,
            ...(ctx.provision === undefined ? {} : { provision: ctx.provision }),
            turns: latestTurnResults,
            ...(ctx.approval === undefined ? {} : { approval: ctx.approval }),
            ...(ctx.submit === undefined ? {} : { submit: ctx.submit }),
          }),
        });
        nodes.push(resultStep);
      }

      const built = wf.from(wf.sequence(...nodes));
      // The configured backend is an operational contract. Falling back to a
      // local database would make a shared deployment look healthy while losing
      // durability and cross-instance visibility.
      const dbConfig = payload.dbConfig ?? {};
      const provider = dbConfig.provider ?? 'sqlite';
      let smithersLayer;
      if (provider === 'sqlite') {
        smithersLayer = Smithers.sqlite({ filename: payload.dbPath });
      } else if (provider === 'postgres' && typeof Smithers.postgres === 'function') {
        smithersLayer = Smithers.postgres({ connectionString: dbConfig.connectionString });
      } else if (provider === 'pglite' && typeof Smithers.pglite === 'function') {
        smithersLayer = Smithers.pglite({ dataDir: dbConfig.dataDir });
      } else {
        throw new Error('Configured Smithers backend is unavailable: ' + provider);
      }
      const execution = await Effect.runPromise(
        built
          .execute(
            { taskId: payload.taskId, runId: payload.storageRunId },
            { runId: payload.storageRunId, force: false, rootDir: payload.rootDir ?? process.cwd(), allowNetwork: true }
          )
          .pipe(Effect.provide(smithersLayer))
      );
      // process.exit() does not drain stdout; the callback-backed emit ensures
      // a large persisted answer reaches the parent before the worker exits.
      await emit({ type: 'taskResult', execution });
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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TaskRunResult> {
  if (options.signal?.aborted) {
    throw new ElizaError("Smithers task execution was aborted", {
      code: "SMITHERS_TASK_ABORTED",
      context: { taskId: spec.taskId, runId: spec.runId },
      severity: "ephemeral",
    });
  }
  const timeoutMs = resolveSmithersTimeoutMs(options.timeoutMs);
  const dbPath = resolveTaskDbPath(spec.tenantId, spec.taskId);
  await mkdir(dirname(dbPath), { recursive: true });
  const agents = Math.max(1, spec.parallelAgents ?? 1);
  const configuredDb = resolveSmithersDbConfig();
  let dbConfig = configuredDb;
  if (configuredDb.provider === "pglite") {
    if (!configuredDb.dataDir) {
      throw new ElizaError("Smithers PGlite data root is required", {
        code: "SMITHERS_DB_DATA_DIR_REQUIRED",
        context: { provider: configuredDb.provider },
      });
    }
    const dataDir = resolveTaskPgliteDataDir(
      configuredDb.dataDir,
      spec.tenantId,
      spec.taskId,
      spec.runId,
    );
    dbConfig = {
      ...configuredDb,
      dataDir,
    };
    await mkdir(dataDir, { recursive: true });
  }
  const tenantNamespace = createHash("sha256")
    .update(spec.tenantId)
    .digest("hex")
    .slice(0, 16);
  const specFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        tenantId: spec.tenantId,
        taskId: spec.taskId,
        runId: spec.runId,
        initialPrompt: spec.initialPrompt,
        agentType: spec.agentType ?? null,
        provision: spec.provision === true,
        submit: spec.submit === true,
        approvalBeforeSubmit: spec.approvalBeforeSubmit === true,
        maxTurns: spec.maxTurns ?? DEFAULT_MAX_TURNS,
        parallelAgents: agents,
      }),
    )
    .digest("hex");

  const payload = JSON.stringify({
    taskId: spec.taskId,
    runId: spec.runId,
    storageRunId: specFingerprint,
    workflowName: `${sanitizeId(spec.taskId)}-${tenantNamespace}`,
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
    env: buildSmithersWorkerEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const payloadInput = proc.stdio[3];
  if (
    !payloadInput ||
    typeof (payloadInput as { end?: unknown }).end !== "function"
  ) {
    proc.kill("SIGKILL");
    throw new ElizaError("Smithers task worker payload pipe was not created", {
      code: "SMITHERS_PAYLOAD_PIPE_MISSING",
      context: { taskId: spec.taskId, runId: spec.runId },
    });
  }
  (payloadInput as NodeJS.WritableStream).end(payload);

  const executionController = new AbortController();
  const stopWorker = (reason: unknown): void => {
    if (!executionController.signal.aborted) {
      executionController.abort(reason);
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  };

  let externallyAborted = false;
  const onAbort = (): void => {
    externallyAborted = true;
    stopWorker(options.signal?.reason);
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
  let protocolError: ElizaError | null = null;
  let executionResult: SmithersTaskExecution;
  let taskResultReceived = false;

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
      // Fail CLOSED: a present approval handler must EXPLICITLY approve. The
      // prior `!== false` treated a malformed/ambiguous response (approved
      // missing / null / undefined at this untyped subprocess boundary) as
      // approval, so a broken approval handler silently let a task submit. Only
      // an explicit `approved === true` clears the gate now. (The no-handler
      // case is unaffected: it never reaches record(), so the permissive init
      // default still stands for deployments that wire no requestApproval.)
      assembled.approved = out.approved === true;
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
    const context: TaskStepContext = {
      ...request.ctx,
      signal: executionController.signal,
    };
    inflight.push(
      handler
        .call(executor, context)
        .then((output) => {
          record(request.kind, context, output);
          writeResponse({ requestId: request.requestId, ok: true, output });
        })
        // error-policy:J1 boundary — translates an executor step failure into a
        // structured StepResponse (ok:false) the subprocess step rejects on.
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
    let message: StepRequest | TaskResultMessage;
    try {
      message = JSON.parse(trimmed) as StepRequest | TaskResultMessage;
    } catch {
      // error-policy:J3 untrusted subprocess stdout — a non-JSON line is ignored
      // (Smithers shares stdout with its own logging).
      return;
    }
    if (message.type === "taskResult") {
      if (!Object.hasOwn(message, "execution")) {
        protocolError = new ElizaError(
          "Smithers returned an invalid durable task result",
          {
            code: "SMITHERS_PROTOCOL_INVALID",
            context: { taskId: spec.taskId, runId: spec.runId },
          },
        );
        stopWorker(protocolError);
        return;
      }
      executionResult = message.execution;
      taskResultReceived = true;
      return;
    }
    if (message.type !== "executeStep") return;
    if (
      typeof message.requestId !== "string" ||
      !Object.hasOwn(METHOD_BY_KIND, message.kind) ||
      !message.ctx ||
      typeof message.ctx !== "object"
    ) {
      protocolError = new ElizaError(
        "Smithers returned an invalid task step request",
        {
          code: "SMITHERS_PROTOCOL_INVALID",
          context: { taskId: spec.taskId, runId: spec.runId },
        },
      );
      stopWorker(protocolError);
      return;
    }
    dispatchStep(message);
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

  let timeoutError: ElizaError | undefined;
  let spawnError: Error | undefined;
  const exitCode = await new Promise<number>((resolve) => {
    const timeout = setTimeout(() => {
      timeoutError = new ElizaError(
        `Smithers task execution timed out after ${timeoutMs}ms`,
        {
          code: "SMITHERS_TASK_TIMEOUT",
          context: { taskId: spec.taskId, runId: spec.runId, timeoutMs },
          severity: "ephemeral",
        },
      );
      stopWorker(timeoutError);
    }, timeoutMs);
    proc.once("error", (error) => {
      spawnError = error;
      stopWorker(error);
    });
    // `close` fires only after the stdio streams are drained; `exit` can precede
    // the last protocol bytes and would lose a final step request.
    proc.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
  options.signal?.removeEventListener("abort", onAbort);
  if (buffer.trim()) handleLine(buffer);
  if (exitCode === 0 && !taskResultReceived && !protocolError) {
    protocolError = new ElizaError(
      "Smithers task worker exited without a durable result",
      {
        code: "SMITHERS_PROTOCOL_RESULT_MISSING",
        context: { taskId: spec.taskId, runId: spec.runId },
      },
    );
  }
  if (exitCode !== 0 && !executionController.signal.aborted) {
    stopWorker(spawnError ?? new Error(`Smithers worker exited ${exitCode}`));
  }

  const drain = Promise.allSettled(inflight);
  if (executionController.signal.aborted) {
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drain,
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, ABORT_DRAIN_TIMEOUT_MS);
      }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);
  } else {
    await drain;
  }

  if (protocolError) throw protocolError;
  if (externallyAborted) {
    throw new ElizaError("Smithers task execution was aborted", {
      code: "SMITHERS_TASK_ABORTED",
      context: { taskId: spec.taskId, runId: spec.runId },
      severity: "ephemeral",
    });
  }
  if (timeoutError) throw timeoutError;

  if (spawnError) {
    throw new ElizaError("Smithers task worker failed to start", {
      code: "SMITHERS_TASK_SPAWN_FAILED",
      context: { taskId: spec.taskId, runId: spec.runId },
      cause: spawnError,
      severity: "ephemeral",
    });
  }

  if (exitCode !== 0) {
    throw new ElizaError(
      `Smithers task execution failed: ${stderr.trim() || `exit ${exitCode}`}`,
      {
        code: "SMITHERS_TASK_FAILED",
        context: { taskId: spec.taskId, runId: spec.runId, exitCode },
        severity: "ephemeral",
      },
    );
  }
  if (!taskResultReceived) {
    throw new ElizaError("Smithers durable task result is unavailable", {
      code: "SMITHERS_PROTOCOL_RESULT_MISSING",
      context: { taskId: spec.taskId, runId: spec.runId },
    });
  }

  const durableSummary = readDurableTaskSummary(executionResult);
  const durableTurns = collectDurableTaskTurns(executionResult);
  const finalTurnsByAgent = new Map<number, DurableTaskTurnSnapshot>();
  for (const [index, turn] of durableTurns.entries()) {
    const agentIndex = turn.agentIndex ?? (agents === 1 ? 0 : index);
    const previous = finalTurnsByAgent.get(agentIndex);
    if ((turn.turn ?? 0) >= (previous?.turn ?? 0)) {
      finalTurnsByAgent.set(agentIndex, turn);
    }
  }
  if (finalTurnsByAgent.size === agents) {
    assembled.agentsDone = Array.from(
      { length: agents },
      (_, index) => finalTurnsByAgent.get(index)?.done === true,
    );
    const durableTurnTotal = Array.from(finalTurnsByAgent.values()).reduce(
      (total, turn) => total + (turn.turn ?? 0),
      0,
    );
    assembled.turns = Math.max(assembled.turns, durableTurnTotal);
  }
  if (!assembled.workspace) {
    assembled.workspace = asRecord(durableSummary?.provision?.workspace);
  }
  if (spec.approvalBeforeSubmit) {
    // A missing or malformed persisted decision is denial. Resume may skip the
    // live approval request, so the durable value is the authority at this gate.
    assembled.approved = durableSummary?.approval?.approved === true;
  }
  if (!assembled.submitOutput) {
    assembled.submitOutput = asRecord(durableSummary?.submit?.output);
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
    execution: executionResult,
    metrics: {
      turns: assembled.turns,
      agents,
      retries: 0,
      durationMs: Date.now() - startedAt,
    },
  };
}
