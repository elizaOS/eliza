/**
 * HTTP route handler for the LifeOpsBench benchmark.
 *
 * Adds four routes alongside the existing benchmark server:
 *
 *   POST /api/benchmark/lifeops_bench/reset
 *     body: { task_id, world_snapshot_path, now_iso }
 *     -> loads the LifeWorld JSON snapshot, hydrates an in-memory fake
 *        backend keyed by task_id, anchors the in-world clock.
 *     resp: { ok: true, world_hash }
 *
 *   POST /api/benchmark/lifeops_bench/message
 *     body: { task_id, text, context?: { tools?: ToolDef[] } }
 *     -> records the user message + any captured assistant tool_calls
 *        (parsed from the planner output), executes those calls against
 *        the fake backend, returns the assistant turn.
 *     resp: { text, tool_calls, usage }
 *
 *   GET  /api/benchmark/lifeops_bench/:task_id/world_state
 *     -> returns the canonical LifeWorld JSON document for state-hash
 *        scoring on the Python side.
 *     resp: { ok: true, world: {...}, world_hash }
 *
 *   POST /api/benchmark/lifeops_bench/teardown
 *     body: { task_id }
 *     -> frees the in-memory backend.
 *     resp: { ok: true }
 *
 * The implementation is intentionally framework-light — a single async
 * `handleLifeOpsBenchRequest()` hooked from the bench server's main
 * request listener. It returns `false` when the path is not a
 * lifeops_bench route so the caller can fall through to its own routes.
 */

import type http from "node:http";
import {
  type ActionResult,
  LifeOpsBackendUnsupportedError,
  LifeOpsFakeBackend,
} from "./lifeops-fake-backend.js";

interface LifeOpsBenchSession {
  taskId: string;
  backend: LifeOpsFakeBackend;
  createdAtMs: number;
  /** Last assistant text returned, kept for diagnostics. */
  lastAssistantText: string;
  turns: LifeOpsBenchTurnRecord[];
}

export interface LifeOpsBenchTurnRecord {
  userText: string;
  assistantText: string;
  toolCalls: ToolCallRecord[];
}

interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  ok: boolean;
  error?: string;
}

/** Shape of the assistant planner result we extract tool_calls from. */
export interface PlannerInvocationResult {
  text: string;
  toolCalls: Array<{
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    /**
     * Provider-reported prompt-cache reads (Anthropic
     * ``cache_read_input_tokens`` / OpenAI + Cerebras
     * ``prompt_tokens_details.cached_tokens``). Optional because not every
     * provider supports prompt caching; nullable upstream stays nullable
     * here — no silent 0 fallback, per AGENTS.md Cmd #8.
     */
    cacheReadInputTokens?: number;
    /** Anthropic-only ``cache_creation_input_tokens``. */
    cacheCreationInputTokens?: number;
  };
}

/**
 * Function the bench server provides to actually run the planner against
 * the user message. The handler is responsible for parsing the planner
 * output into named tool calls + assistant text. In the unit tests we
 * inject a deterministic fake; in production this delegates to the
 * existing Eliza handleMessage flow.
 */
export type LifeOpsPlannerInvocation = (args: {
  taskId: string;
  userText: string;
  toolManifest: unknown;
  backend: LifeOpsFakeBackend;
  previousTurns: LifeOpsBenchTurnRecord[];
}) => Promise<PlannerInvocationResult>;

export interface LifeOpsBenchHandlerOptions {
  /** Provided by the bench server: invokes Eliza's planner against `userText`. */
  invokePlanner: LifeOpsPlannerInvocation;
  /** Optional auth wrapper — same shape as the main bench server's checkAuth. */
  checkAuth?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  /** Maximum body size in bytes for POST routes. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const ROUTE_PREFIX = "/api/benchmark/lifeops_bench";

export class LifeOpsBenchHandler {
  private readonly sessions = new Map<string, LifeOpsBenchSession>();
  private readonly invokePlanner: LifeOpsPlannerInvocation;
  private readonly checkAuth?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => boolean;
  private readonly maxBodyBytes: number;

  constructor(options: LifeOpsBenchHandlerOptions) {
    this.invokePlanner = options.invokePlanner;
    this.checkAuth = options.checkAuth;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  /** Returns true when the request was a lifeops_bench route the handler took. */
  async tryHandle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!pathname.startsWith(ROUTE_PREFIX)) return false;

    if (pathname === `${ROUTE_PREFIX}/reset` && req.method === "POST") {
      if (this.checkAuth && !this.checkAuth(req, res)) return true;
      await this.handleReset(req, res);
      return true;
    }
    if (pathname === `${ROUTE_PREFIX}/message` && req.method === "POST") {
      if (this.checkAuth && !this.checkAuth(req, res)) return true;
      await this.handleMessage(req, res);
      return true;
    }
    if (pathname === `${ROUTE_PREFIX}/teardown` && req.method === "POST") {
      if (this.checkAuth && !this.checkAuth(req, res)) return true;
      await this.handleTeardown(req, res);
      return true;
    }

    // GET /api/benchmark/lifeops_bench/:task_id/world_state
    const worldStateMatch = pathname.match(
      /^\/api\/benchmark\/lifeops_bench\/([^/]+)\/world_state$/,
    );
    if (worldStateMatch && req.method === "GET") {
      this.handleWorldState(res, decodeURIComponent(worldStateMatch[1]));
      return true;
    }

    // Path was under our prefix but no route matched — return 404 ourselves
    // so the request doesn't fall through to the bench server's catch-all.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `No lifeops_bench route for ${req.method} ${pathname}`,
      }),
    );
    return true;
  }

  /** Test-only / introspection accessor. */
  getSession(taskId: string): LifeOpsBenchSession | undefined {
    return this.sessions.get(taskId);
  }

  // ------------------------------------------------------------------ reset

  private async handleReset(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: ResetBody;
    try {
      body = (await readJsonBody(req, this.maxBodyBytes)) as ResetBody;
    } catch (err) {
      writeError(res, 400, errorMessage(err));
      return;
    }

    const taskId = requireNonEmptyString(body, "task_id");
    const snapshotPath = requireNonEmptyString(body, "world_snapshot_path");
    const nowIso = optionalString(body, "now_iso");

    if (!taskId || !snapshotPath) {
      writeError(res, 400, "task_id and world_snapshot_path are required");
      return;
    }

    let backend: LifeOpsFakeBackend;
    try {
      backend = LifeOpsFakeBackend.fromJsonFile(snapshotPath);
    } catch (err) {
      writeError(
        res,
        400,
        `Failed to load world snapshot at ${snapshotPath}: ${errorMessage(err)}`,
      );
      return;
    }

    if (nowIso) backend.setNow(nowIso);

    this.sessions.set(taskId, {
      taskId,
      backend,
      createdAtMs: Date.now(),
      lastAssistantText: "",
      turns: [],
    });

    writeJson(res, 200, {
      ok: true,
      task_id: taskId,
      world_hash: backend.stateHash(),
      now_iso: backend.getNow(),
      seed: backend.getSeed(),
    });
  }

  // ---------------------------------------------------------------- message

  private async handleMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: MessageBody;
    try {
      body = (await readJsonBody(req, this.maxBodyBytes)) as MessageBody;
    } catch (err) {
      writeError(res, 400, errorMessage(err));
      return;
    }

    const taskId = requireNonEmptyString(body, "task_id");
    const text = requireNonEmptyString(body, "text");

    if (!taskId || !text) {
      writeError(res, 400, "task_id and text are required");
      return;
    }

    const session = this.sessions.get(taskId);
    if (!session) {
      writeError(
        res,
        404,
        `No lifeops_bench session for task_id=${taskId}; call /reset first`,
      );
      return;
    }

    const toolManifest =
      body.context && typeof body.context === "object" && body.context !== null
        ? (body.context as Record<string, unknown>).tools
        : undefined;

    let plannerResult: PlannerInvocationResult;
    try {
      plannerResult = await this.invokePlanner({
        taskId,
        userText: text,
        toolManifest,
        backend: session.backend,
        previousTurns: [...session.turns],
      });
    } catch (err) {
      writeError(res, 500, `Planner invocation failed: ${errorMessage(err)}`);
      return;
    }

    const executed: ToolCallRecord[] = [];
    for (const call of plannerResult.toolCalls) {
      const id = call.id ?? `call_${executed.length}`;
      try {
        const result: ActionResult = session.backend.applyAction(
          call.name,
          call.arguments,
        );
        executed.push({
          id,
          name: call.name,
          arguments: call.arguments,
          result: result.result,
          ok: result.ok,
        });
      } catch (err) {
        const message = errorMessage(err);
        const isUnsupported = err instanceof LifeOpsBackendUnsupportedError;
        executed.push({
          id,
          name: call.name,
          arguments: call.arguments,
          result: null,
          ok: false,
          error: isUnsupported ? `unsupported: ${message}` : message,
        });
      }
    }

    session.lastAssistantText = plannerResult.text;
    session.turns.push({
      userText: text,
      assistantText: plannerResult.text,
      toolCalls: executed,
    });

    writeJson(res, 200, {
      task_id: taskId,
      text: plannerResult.text,
      tool_calls: executed,
      usage: plannerResult.usage ?? {},
      world_hash: session.backend.stateHash(),
    });
  }

  // ------------------------------------------------------------ world_state

  private handleWorldState(res: http.ServerResponse, taskId: string): void {
    const session = this.sessions.get(taskId);
    if (!session) {
      writeError(res, 404, `No lifeops_bench session for task_id=${taskId}`);
      return;
    }
    writeJson(res, 200, {
      ok: true,
      task_id: taskId,
      world_hash: session.backend.stateHash(),
      world: session.backend.toDocument(),
    });
  }

  // -------------------------------------------------------------- teardown

  private async handleTeardown(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: TeardownBody;
    try {
      body = (await readJsonBody(req, this.maxBodyBytes)) as TeardownBody;
    } catch (err) {
      writeError(res, 400, errorMessage(err));
      return;
    }
    const taskId = requireNonEmptyString(body, "task_id");
    if (!taskId) {
      writeError(res, 400, "task_id is required");
      return;
    }
    const removed = this.sessions.delete(taskId);
    writeJson(res, 200, { ok: true, task_id: taskId, removed });
  }
}

// ---------------------------------------------------------------------------
// Body helpers — kept local so the handler is drop-in usable without pulling
// the bench server's private utilities.
// ---------------------------------------------------------------------------

interface ResetBody {
  task_id?: unknown;
  world_snapshot_path?: unknown;
  now_iso?: unknown;
}

interface MessageBody {
  task_id?: unknown;
  text?: unknown;
  context?: unknown;
}

interface TeardownBody {
  task_id?: unknown;
}

function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeded max size ${maxBytes} bytes`));
        return;
      }
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Malformed JSON request body: ${errorMessage(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function requireNonEmptyString(
  body: Record<string, unknown> | undefined,
  field: string,
): string {
  const v = body?.[field];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : "";
}

function optionalString(
  body: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const v = body?.[field];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function writeError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  writeJson(res, status, { error: message });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
