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
import {
  captureTrustedParentContractFinalState,
  prepareTrustedParentContractEvidenceSession,
} from "./trusted-parent-contract-evidence.js";
import {
  captureTrustedParentingFinalState,
  prepareTrustedParentingEvidenceSession,
  trustedParentingRequestText,
} from "./trusted-parenting-evidence.js";

export const TRUSTED_RUNTIME_ACTION_PATH =
  "/api/benchmark/trusted-runtime/action";
export const TRUSTED_RUNTIME_ACTION_SCHEMA = "eliza.trusted-runtime-action.v1";
export const TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA =
  "eliza.trusted-runtime-evidence-provenance.v1";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const ACTION_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{15,255}$/;
const PROVIDER_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const ALLOWED_RISKS = new Set(["read", "proposal", "approved_write"]);
const RESERVED_ACTION_DATA_KEYS = [
  "terminalSnapshot",
  "trustedFinalState",
  "trustedParentContractState",
] as const;
const PROVIDER_EVIDENCE_CONFIGURATION_KEYS = [
  "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER",
  "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY",
  "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256",
] as const;

type TrustedActionRisk = "read" | "proposal" | "approved_write";
type TrustedProviderEvidenceBoundary =
  | "sandbox_connector"
  | "production_connector";

export type TrustedRuntimeEvidenceProvenance =
  | {
      schema: typeof TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA;
      tier: "local_nonpublishable";
      publishable: false;
      configuration_basis: "default_local_configuration";
      provider: null;
      boundary: null;
      account_identity_sha256: null;
      provider_readback: "not_applicable";
    }
  | {
      schema: typeof TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA;
      tier: "provider_backed";
      publishable: false;
      configuration_basis: "explicit_server_configuration";
      provider: string;
      boundary: TrustedProviderEvidenceBoundary;
      account_identity_sha256: string;
      provider_readback: "not_verified";
    };

const LOCAL_EVIDENCE_PROVENANCE: TrustedRuntimeEvidenceProvenance = {
  schema: TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
  tier: "local_nonpublishable",
  publishable: false,
  configuration_basis: "default_local_configuration",
  provider: null,
  boundary: null,
  account_identity_sha256: null,
  provider_readback: "not_applicable",
};

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
  evidenceProvenance?: TrustedRuntimeEvidenceProvenance;
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
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredValue(
  configuration: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = configuration[key]?.trim();
  return value ? value : undefined;
}

function isProviderEvidenceBoundary(
  value: string,
): value is TrustedProviderEvidenceBoundary {
  return value === "sandbox_connector" || value === "production_connector";
}

/**
 * Converts trusted-server environment configuration into a closed evidence
 * provenance type. Local execution is deliberately nonpublishable; enabling a
 * provider-backed tier requires a pinned provider, boundary, and account hash.
 */
export function parseTrustedRuntimeEvidenceProvenance(
  configuration: Readonly<Record<string, string | undefined>>,
): TrustedRuntimeEvidenceProvenance {
  const tier =
    configuredValue(
      configuration,
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER",
    ) ?? "local_nonpublishable";
  if (tier === "local_nonpublishable") {
    const unexpectedProviderConfiguration =
      PROVIDER_EVIDENCE_CONFIGURATION_KEYS.find((key) =>
        configuredValue(configuration, key),
      );
    if (unexpectedProviderConfiguration) {
      throw new Error(
        `${unexpectedProviderConfiguration} requires ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER=provider_backed`,
      );
    }
    return { ...LOCAL_EVIDENCE_PROVENANCE };
  }
  if (tier !== "provider_backed") {
    throw new Error(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER must be local_nonpublishable or provider_backed",
    );
  }

  const provider = configuredValue(
    configuration,
    "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER",
  );
  if (!provider || !PROVIDER_IDENTIFIER_PATTERN.test(provider)) {
    throw new Error(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER must be a lowercase provider identifier",
    );
  }
  const boundary = configuredValue(
    configuration,
    "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY",
  );
  if (!boundary || !isProviderEvidenceBoundary(boundary)) {
    throw new Error(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY must be sandbox_connector or production_connector",
    );
  }
  const accountIdentitySha256 = configuredValue(
    configuration,
    "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256",
  );
  if (!accountIdentitySha256 || !SHA256_PATTERN.test(accountIdentitySha256)) {
    throw new Error(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256 must be a 64-character SHA-256 digest",
    );
  }
  return {
    schema: TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
    tier: "provider_backed",
    // Explicit configuration pins operator intent, not provider execution or
    // readback. A future server-owned verifier must establish those facts.
    publishable: false,
    configuration_basis: "explicit_server_configuration",
    provider,
    boundary,
    account_identity_sha256: accountIdentitySha256.toLowerCase(),
    provider_readback: "not_verified",
  };
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
    throw new TrustedRuntimeActionHttpError(400, `${field} has invalid syntax`);
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
    ["schema", "task_id", "action", "idempotency_key", "risk", "requested_at"],
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
    data,
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
  let canonical: unknown;
  try {
    const serialized = JSON.stringify(normalized);
    if (serialized === undefined) {
      throw new Error("JSON serialization returned no value");
    }
    canonical = JSON.parse(serialized) as unknown;
  } catch (error) {
    // error-policy:J3 Action results are untrusted boundary data; serialization
    // failures must become an explicit invalid-result response.
    throw new TrustedRuntimeActionHttpError(
      502,
      `runtime action result is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    !isRecord(canonical) ||
    typeof canonical.success !== "boolean" ||
    !isRecord(canonical.data)
  ) {
    throw new TrustedRuntimeActionHttpError(
      502,
      "runtime action result changed shape during JSON serialization",
    );
  }

  // JSON round-tripping removes custom prototypes and toJSON hooks before the
  // exact evaluator-visible path is cleared. Nested domain fields with the same
  // names remain ordinary action data and cannot become terminal evidence.
  for (const key of RESERVED_ACTION_DATA_KEYS) {
    delete canonical.data[key];
  }
  canonical.data.actionName = action.name;

  const result: TrustedRuntimeActionResult = {
    success: canonical.success,
    data: canonical.data,
  };
  if (canonical.text !== undefined) {
    if (typeof canonical.text !== "string") {
      throw new TrustedRuntimeActionHttpError(
        502,
        "runtime action result changed text shape during JSON serialization",
      );
    }
    result.text = canonical.text;
  }
  if (canonical.userFacingText !== undefined) {
    if (typeof canonical.userFacingText !== "string") {
      throw new TrustedRuntimeActionHttpError(
        502,
        "runtime action result changed user-facing text shape during JSON serialization",
      );
    }
    result.userFacingText = canonical.userFacingText;
  }
  if (canonical.verifiedUserFacing !== undefined) {
    if (typeof canonical.verifiedUserFacing !== "boolean") {
      throw new TrustedRuntimeActionHttpError(
        502,
        "runtime action result changed verification shape during JSON serialization",
      );
    }
    result.verifiedUserFacing = canonical.verifiedUserFacing;
  }
  if (canonical.effectReceipts !== undefined) {
    if (
      !Array.isArray(canonical.effectReceipts) ||
      canonical.effectReceipts.some((receipt) => !isRecord(receipt))
    ) {
      throw new TrustedRuntimeActionHttpError(
        502,
        "runtime action effect receipts changed shape during JSON serialization",
      );
    }
    result.effectReceipts = canonical.effectReceipts;
  }
  if (canonical.userFacingEffectReceiptIds !== undefined) {
    if (
      !Array.isArray(canonical.userFacingEffectReceiptIds) ||
      canonical.userFacingEffectReceiptIds.some(
        (receiptId) =>
          typeof receiptId !== "string" || receiptId.trim().length === 0,
      )
    ) {
      throw new TrustedRuntimeActionHttpError(
        502,
        "runtime action receipt IDs changed shape during JSON serialization",
      );
    }
    result.userFacingEffectReceiptIds = canonical.userFacingEffectReceiptIds;
  }
  return result;
}

async function defaultPrepareSession(
  runtime: AgentRuntime,
  session: BenchmarkSession,
): Promise<void> {
  await ensureBenchmarkSessionContext(runtime, session);
  await seedBenchUserRole(runtime, session, BENCHMARK_OWNER_ENTITY_ID, "OWNER");
  await prepareTrustedParentingEvidenceSession(runtime, session);
  await prepareTrustedParentContractEvidenceSession(runtime, session);
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
  const trustedParentingText = trustedParentingRequestText(
    request.task_id,
    action.name,
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
      ...request.action.parameters,
      text:
        trustedParentingText ??
        `Execute ${action.name} through the trusted runtime boundary.`,
      source: "trusted-runtime",
      action: action.name,
    },
    createdAt: Date.now(),
  };
  const handlerOptions: HandlerOptions = {
    parameters: request.action.parameters as NonNullable<
      HandlerOptions["parameters"]
    >,
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
    // error-policy:J2 Preserve the action failure as the cause while adding
    // authenticated action-boundary context for the HTTP translator.
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
      { cause: error },
    );
  }
  const result = normalizeResult(action, rawResult);
  if (result.effectReceipts) {
    result.effectReceipts = result.effectReceipts.map((receipt) => ({
      ...receipt,
      trustedRuntimeInvocation: {
        idempotencyKey: request.idempotency_key,
      },
    }));
  }
  const trustedParentingState = await captureTrustedParentingFinalState(
    options.runtime,
    request.task_id,
  );
  if (trustedParentingState) {
    result.data.trustedFinalState = trustedParentingState;
  }
  const trustedParentContractState =
    await captureTrustedParentContractFinalState(
      options.runtime,
      session,
      action.name,
      request.action.parameters,
      result,
    );
  if (trustedParentContractState) {
    result.data.trustedParentContractState = trustedParentContractState;
  }
  const observedAt = new Date().toISOString();
  const evidenceProvenance =
    options.evidenceProvenance ?? LOCAL_EVIDENCE_PROVENANCE;
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
      release_evidence: evidenceProvenance.publishable,
      evidence_provenance: evidenceProvenance,
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
      typeof authorization === "string" && authorization.startsWith("Bearer ")
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
          // error-policy:J3 Malformed request bytes are rejected as explicit
          // invalid input at the authenticated HTTP boundary.
          throw new TrustedRuntimeActionHttpError(
            400,
            `trusted runtime request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        const parsed = parseTrustedRuntimeActionRequest(decoded);
        const response = await executeTrustedRuntimeAction(
          this.options,
          parsed,
        );
        sendJson(res, 200, response);
      } catch (error) {
        // error-policy:J1 This is the outer HTTP translation boundary for
        // structured protocol failures and unexpected runtime failures.
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
