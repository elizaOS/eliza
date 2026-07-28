/**
 * Narrow HTTP boundary for executing allowlisted actions against a real elizaOS runtime.
 *
 * The trusted evidence service calls this boundary from a separate process. It
 * never invokes the benchmark fake backend, never asks a model to choose an
 * action, and returns only the registered handler's normalized result.
 */

import crypto from "node:crypto";
import type http from "node:http";
import {
  type Action,
  type ActionResult,
  type AgentRuntime,
  type HandlerOptions,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import {
  BENCHMARK_OWNER_ENTITY_ID,
  BENCHMARK_WORLD_ID,
  type BenchmarkSession,
  ensureBenchmarkSessionContext,
  seedBenchUserRole,
} from "./server-utils.js";

export const TRUSTED_RUNTIME_ACTION_PATH =
  "/api/benchmark/trusted-runtime/action";
export const TRUSTED_RUNTIME_ACTION_SCHEMA =
  "eliza.trusted-runtime-action.v1";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const ACTION_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{15,255}$/;
const ALLOWED_RISKS = new Set(["read", "proposal", "approved_write"]);

type TrustedActionRisk = "read" | "proposal" | "approved_write";

interface TrustedRuntimeActionRequest {
  schema: typeof TRUSTED_RUNTIME_ACTION_SCHEMA;
  task_id: string;
  action: {
    name: string;
    parameters: Record<string, unknown>;
  };
  idempotency_key: string;
  risk: TrustedActionRisk;
  requested_at: string;
}

interface TrustedRuntimeActionResult {
  success: boolean;
  text?: string;
  userFacingText?: string;
  verifiedUserFacing?: boolean;
  data: Record<string, unknown>;
  effectReceipts?: readonly Record<string, unknown>[];
  userFacingEffectReceiptIds?: readonly string[];
}

export interface TrustedRuntimeActionHandlerOptions {
  runtime: AgentRuntime;
  bearerToken: string;
  allowedActions: ReadonlySet<string>;
  resolveSession: (taskId: string) => BenchmarkSession;
  prepareSession?: (
    runtime: AgentRuntime,
    session: BenchmarkSession,
  ) => Promise<void>;
  maxBodyBytes?: number;
}

export class TrustedRuntimeActionHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new TrustedRuntimeActionHttpError(
      400,
      `${label} fields do not match the trusted runtime protocol`,
    );
  }
}

function nonEmptyString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TrustedRuntimeActionHttpError(
      400,
      `${field} must be a non-empty string`,
    );
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw new TrustedRuntimeActionHttpError(
      400,
      `${field} has invalid syntax`,
    );
  }
  return normalized;
}

function parseRequestedAt(value: unknown): string {
  const requestedAt = nonEmptyString(value, "requested_at");
  const parsed = Date.parse(requestedAt);
  if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d\d:\d\d$/.test(requestedAt)) {
    throw new TrustedRuntimeActionHttpError(
      400,
      "requested_at must be an ISO timestamp with a timezone",
    );
  }
  const now = Date.now();
  if (Math.abs(now - parsed) > 2 * 60 * 1000) {
    throw new TrustedRuntimeActionHttpError(
      401,
      "trusted runtime request timestamp is stale",
    );
  }
  return new Date(parsed).toISOString();
}

export function parseTrustedRuntimeActionRequest(
  body: unknown,
): TrustedRuntimeActionRequest {
  if (!isRecord(body)) {
    throw new TrustedRuntimeActionHttpError(
      400,
      "trusted runtime request must be a JSON object",
    );
  }
  exactKeys(
    body,
    [
      "schema",
      "task_id",
      "action",
      "idempotency_key",
      "risk",
      "requested_at",
    ],
    "request",
  );
  if (body.schema !== TRUSTED_RUNTIME_ACTION_SCHEMA) {
    throw new TrustedRuntimeActionHttpError(
      400,
      "trusted runtime request schema is unsupported",
    );
  }
  const taskId = nonEmptyString(body.task_id, "task_id", IDENTIFIER_PATTERN);
  const idempotencyKey = nonEmptyString(
    body.idempotency_key,
    "idempotency_key",
    IDEMPOTENCY_KEY_PATTERN,
  );
  const risk = nonEmptyString(body.risk, "risk");
  if (!ALLOWED_RISKS.has(risk)) {
    throw new TrustedRuntimeActionHttpError(
      400,
      "risk is not supported by the trusted runtime protocol",
    );
  }
  if (!isRecord(body.action)) {
    throw new TrustedRuntimeActionHttpError(
      400,
      "action must be a JSON object",
    );
  }
  exactKeys(body.action, ["name", "parameters"], "action");
  const name = nonEmptyString(
    body.action.name,
    "action.name",
    ACTION_NAME_PATTERN,
  );
  if (!isRecord(body.action.parameters)) {
    throw new TrustedRuntimeActionHttpError(
      400,
      "action.parameters must be a JSON object",
    );
  }
  const parameters = { ...body.action.parameters };
  const suppliedIdempotencyKey = parameters.idempotencyKey;
  if (
    suppliedIdempotencyKey !== undefined &&
    suppliedIdempotencyKey !== idempotencyKey
  ) {
    throw new TrustedRuntimeActionHttpError(
      409,
      "action idempotencyKey conflicts with the authenticated request",
    );
  }
  parameters.idempotencyKey = idempotencyKey;
  return {
    schema: TRUSTED_RUNTIME_ACTION_SCHEMA,
    task_id: taskId,
    action: { name, parameters },
    idempotency_key: idempotencyKey,
    risk: risk as TrustedActionRisk,
    requested_at: parseRequestedAt(body.requested_at),
  };
}

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length) {
    const padded = Buffer.alloc(expectedBytes.length);
    providedBytes.copy(
      padded,
      0,
      0,
      Math.min(providedBytes.length, expectedBytes.length),
    );
    return crypto.timingSafeEqual(expectedBytes, padded) && false;
  }
  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

function normalizeResult(
  action: Action,
  rawResult: ActionResult | undefined,
): TrustedRuntimeActionResult {
  if (!rawResult || !isRecord(rawResult)) {
    throw new TrustedRuntimeActionHttpError(
      502,
      "runtime action returned no structured result",
    );
  }
  if (typeof rawResult.success !== "boolean") {
    throw new TrustedRuntimeActionHttpError(
      502,
      "runtime action result is missing its boolean success state",
    );
  }
  const data = isRecord(rawResult.data) ? rawResult.data : {};
  const normalized: TrustedRuntimeActionResult = {
    success: rawResult.success,
    data: {
      ...data,
      actionName: action.name,
    },
  };
  if (typeof rawResult.text === "string") normalized.text = rawResult.text;
  if (typeof rawResult.userFacingText === "string") {
    normalized.userFacingText = rawResult.userFacingText;
  }
  if (typeof rawResult.verifiedUserFacing === "boolean") {
    normalized.verifiedUserFacing = rawResult.verifiedUserFacing;
  }
  if (rawResult.effectReceipts !== undefined) {
    if (
      !Array.isArray(rawResult.effectReceipts) ||
      rawResult.effectReceipts.some((receipt) => !isRecord(receipt))
    ) {
      throw new TrustedRuntimeActionHttpError(
        502,
        "runtime action returned invalid effect receipt data",
      );
    }
    normalized.effectReceipts = rawResult.effectReceipts;
  }
  if (rawResult.userFacingEffectReceiptIds !== undefined) {
    if (
      !Array.isArray(rawResult.userFacingEffectReceiptIds) ||
      rawResult.userFacingEffectReceiptIds.some(
        (receiptId) =>
          typeof receiptId !== "string" || receiptId.trim().length === 0,
      )
    ) {
      throw new TrustedRuntimeActionHttpError(
        502,
        "runtime action returned invalid user-facing effect receipt IDs",
      );
    }
    normalized.userFacingEffectReceiptIds =
      rawResult.userFacingEffectReceiptIds;
  }
  try {
    JSON.stringify(normalized);
  } catch (error) {
    throw new TrustedRuntimeActionHttpError(
      502,
      `runtime action result is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalized;
}

async function defaultPrepareSession(
  runtime: AgentRuntime,
  session: BenchmarkSession,
): Promise<void> {
  await ensureBenchmarkSessionContext(runtime, session);
  await seedBenchUserRole(
    runtime,
    session,
    BENCHMARK_OWNER_ENTITY_ID,
    "OWNER",
  );
}

export async function executeTrustedRuntimeAction(
  options: TrustedRuntimeActionHandlerOptions,
  request: TrustedRuntimeActionRequest,
): Promise<Record<string, unknown>> {
  if (!options.allowedActions.has(request.action.name)) {
    throw new TrustedRuntimeActionHttpError(
      403,
      "action is not in the trusted runtime allowlist",
    );
  }
  const action = options.runtime
    .getAllActions()
    .find((candidate) => candidate.name === request.action.name);
  if (!action) {
    throw new TrustedRuntimeActionHttpError(
      503,
      "allowlisted action is not registered in this runtime",
    );
  }
  const session = options.resolveSession(request.task_id);
  await (options.prepareSession ?? defaultPrepareSession)(
    options.runtime,
    session,
  );
  const message: Memory = {
    id: stringToUuid(
      `trusted-runtime:${request.task_id}:${request.idempotency_key}`,
    ),
    entityId: BENCHMARK_OWNER_ENTITY_ID,
    agentId: options.runtime.agentId,
    roomId: session.roomId,
    worldId: BENCHMARK_WORLD_ID,
    content: {
      text: `Execute ${action.name} through the trusted runtime boundary.`,
      source: "trusted-runtime",
      action: action.name,
      ...request.action.parameters,
    },
    createdAt: Date.now(),
  };
  const handlerOptions: HandlerOptions = {
    parameters:
      request.action.parameters as NonNullable<HandlerOptions["parameters"]>,
  };
  const state = await options.runtime.composeState(message);
  const valid = await action.validate(
    options.runtime,
    message,
    state,
    handlerOptions,
  );
  if (!valid) {
    throw new TrustedRuntimeActionHttpError(
      403,
      "runtime action validation rejected the owner-scoped request",
    );
  }
  let rawResult: ActionResult | undefined;
  try {
    rawResult = await action.handler(
      options.runtime,
      message,
      state,
      handlerOptions,
      async () => [],
      [],
    );
  } catch (error) {
    options.runtime.logger.error(
      {
        src: "trusted-runtime-action",
        action: action.name,
        taskId: request.task_id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Trusted runtime action execution failed",
    );
    throw new TrustedRuntimeActionHttpError(
      502,
      "runtime action execution failed",
    );
  }
  const result = normalizeResult(action, rawResult);
  const observedAt = new Date().toISOString();
  return {
    schema: TRUSTED_RUNTIME_ACTION_SCHEMA,
    ok: result.success,
    task_id: request.task_id,
    action: action.name,
    idempotency_key: request.idempotency_key,
    risk: request.risk,
    requested_at: request.requested_at,
    observed_at: observedAt,
    runtime: {
      native_runtime_class: "@elizaos/core.AgentRuntime",
      native_runtime_api: "Action.handler",
      transport: "trusted_runtime_http",
      stand_in: false,
      release_evidence: true,
      action_tags: action.tags ?? [],
    },
    result,
  };
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(bytes);
}

export class TrustedRuntimeActionHandler {
  private readonly maxBodyBytes: number;

  constructor(private readonly options: TrustedRuntimeActionHandlerOptions) {
    if (options.bearerToken.length < 32) {
      throw new Error(
        "trusted runtime bearer token must contain at least 32 characters",
      );
    }
    if (options.allowedActions.size === 0) {
      throw new Error("trusted runtime action allowlist cannot be empty");
    }
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async tryHandle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (pathname !== TRUSTED_RUNTIME_ACTION_PATH) return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "trusted runtime accepts POST only" });
      return true;
    }
    const authorization = req.headers.authorization;
    const provided =
      typeof authorization === "string" &&
      authorization.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : "";
    if (!provided || !tokenMatches(this.options.bearerToken, provided)) {
      sendJson(res, 401, { error: "invalid or missing Bearer token" });
      return true;
    }
    const contentType = req.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      sendJson(res, 415, {
        error: "trusted runtime request must be application/json",
      });
      return true;
    }

    let body = "";
    let bodyBytes = 0;
    let completed = false;
    req.on("data", (chunk: Buffer) => {
      if (completed) return;
      bodyBytes += chunk.length;
      if (bodyBytes > this.maxBodyBytes) {
        completed = true;
        sendJson(res, 413, {
          error: "trusted runtime request exceeds the protocol limit",
        });
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", async () => {
      if (completed) return;
      completed = true;
      try {
        let decoded: unknown;
        try {
          decoded = JSON.parse(body);
        } catch (error) {
          throw new TrustedRuntimeActionHttpError(
            400,
            `trusted runtime request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const parsed = parseTrustedRuntimeActionRequest(decoded);
        const response = await executeTrustedRuntimeAction(
          this.options,
          parsed,
        );
        sendJson(res, 200, response);
      } catch (error) {
        if (error instanceof TrustedRuntimeActionHttpError) {
          sendJson(res, error.statusCode, { error: error.publicMessage });
          return;
        }
        this.options.runtime.logger.error(
          {
            src: "trusted-runtime-action",
            error: error instanceof Error ? error.message : String(error),
          },
          "Trusted runtime HTTP boundary failed",
        );
        sendJson(res, 500, { error: "trusted runtime internal failure" });
      }
    });
    return true;
  }
}
