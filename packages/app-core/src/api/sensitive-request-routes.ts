import type http from "node:http";
import {
  defaultSensitiveRequestPolicy,
  resolveSensitiveRequestDelivery,
  type SensitiveRequest,
  type SensitiveRequestCallback,
  type SensitiveRequestDeliveryPlan,
  type SensitiveRequestEnvironment,
  type SensitiveRequestEvent,
  type SensitiveRequestKind,
  type SensitiveRequestPolicy,
  type SensitiveRequestPrivateInfoTarget,
  type SensitiveRequestSecretTarget,
  type SensitiveRequestSourceContext,
  type SensitiveRequestTarget,
} from "@elizaos/core";
import { sharedVault } from "../services/vault-mirror";
import {
  ensureRouteAuthorized,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "./auth.ts";
import {
  type CompatRuntimeState,
  isTrustedLocalRequest,
  readCompatJsonBody,
} from "./compat-route-shared";
import { sendJson, sendJsonError } from "./response";
import {
  type LocalSensitiveRequestRecord,
  type LocalSensitiveRequestStore,
  localSensitiveRequestStore,
  redactLocalSensitiveRequest,
  type SensitiveRequestAuditEvent,
} from "./sensitive-request-store";

const ROUTE_PREFIX = "/api/sensitive-requests";
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const SAFE_FIELD_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SOURCE_CONTEXTS = new Set<SensitiveRequestSourceContext>([
  "owner_app_private",
  "dm",
  "public",
  "api",
  "unknown",
]);

export interface SensitiveRequestRouteOptions {
  store?: LocalSensitiveRequestStore;
  now?: () => number;
  isLocalSensitiveRequestAuthConfigured?: (
    state: CompatRuntimeState,
  ) => boolean;
  fulfillSecret?: (
    record: LocalSensitiveRequestRecord,
    value: string,
  ) => Promise<void>;
  fulfillPrivateInfo?: (
    record: LocalSensitiveRequestRecord,
    fields: Record<string, string>,
  ) => Promise<void>;
  onEvent?: (
    event: SensitiveRequestEvent,
    request: SensitiveRequest,
  ) => void | Promise<void>;
  getTunnelStatus?: (
    state: CompatRuntimeState,
  ) => { active: boolean; url?: string | null } | null;
}

interface CreateBody {
  kind?: unknown;
  agentId?: unknown;
  organizationId?: unknown;
  ownerEntityId?: unknown;
  requesterEntityId?: unknown;
  sourceRoomId?: unknown;
  sourceChannelType?: unknown;
  sourcePlatform?: unknown;
  target?: unknown;
  callback?: unknown;
  ttlMs?: unknown;
  source?: unknown;
  channelType?: unknown;
  ownerAppPrivateChat?: unknown;
  dmAvailable?: unknown;
  policy?: unknown;
}

function firstPathMatch(
  pathname: string,
): { id: string; action: "get" | "submit" | "cancel" } | null {
  const submit = /^\/api\/sensitive-requests\/([^/]+)\/submit$/.exec(pathname);
  if (submit?.[1])
    return { id: decodeURIComponent(submit[1]), action: "submit" };
  const cancel = /^\/api\/sensitive-requests\/([^/]+)\/cancel$/.exec(pathname);
  if (cancel?.[1])
    return { id: decodeURIComponent(cancel[1]), action: "cancel" };
  const get = /^\/api\/sensitive-requests\/([^/]+)$/.exec(pathname);
  if (get?.[1]) return { id: decodeURIComponent(get[1]), action: "get" };
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolFromUnknown(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function isTruthy(value: unknown): boolean {
  return boolFromUnknown(value) === true;
}

function normalizeSource(value: unknown): SensitiveRequestSourceContext {
  return typeof value === "string" &&
    SOURCE_CONTEXTS.has(value as SensitiveRequestSourceContext)
    ? (value as SensitiveRequestSourceContext)
    : "api";
}

function parseSecretTarget(
  target: Record<string, unknown>,
): SensitiveRequestSecretTarget | string {
  const key = optionalString(target.key);
  if (!key || !SAFE_KEY_RE.test(key)) return "invalid secret target key";
  const scope = optionalString(target.scope);
  const allowedScopes = new Set(["global", "world", "user", "agent", "app"]);
  const parsed: SensitiveRequestSecretTarget = {
    kind: "secret",
    key,
  };
  if (scope) {
    if (!allowedScopes.has(scope)) return "invalid secret target scope";
    parsed.scope = scope as SensitiveRequestSecretTarget["scope"];
  }
  const appId = optionalString(target.appId);
  if (appId) parsed.appId = appId;
  const validation = asRecord(target.validation);
  if (validation) {
    const type = optionalString(validation.type) ?? "none";
    if (!["none", "non_empty", "url", "regex"].includes(type)) {
      return "invalid secret validation type";
    }
    parsed.validation = {
      type: type as NonNullable<
        SensitiveRequestSecretTarget["validation"]
      >["type"],
    };
    const pattern = optionalString(validation.pattern);
    if (pattern) parsed.validation.pattern = pattern;
  }
  return parsed;
}

function parsePrivateInfoTarget(
  target: Record<string, unknown>,
): SensitiveRequestPrivateInfoTarget | string {
  const fields = Array.isArray(target.fields) ? target.fields : null;
  if (!fields || fields.length === 0 || fields.length > 50) {
    return "private_info target requires 1-50 fields";
  }
  const parsedFields: SensitiveRequestPrivateInfoTarget["fields"] = [];
  for (const raw of fields) {
    const field = asRecord(raw);
    const name = optionalString(field?.name);
    if (!name || !SAFE_FIELD_RE.test(name)) {
      return "invalid private_info field name";
    }
    const classification = optionalString(field?.classification);
    if (
      classification &&
      classification !== "private" &&
      classification !== "public_non_secret"
    ) {
      return "invalid private_info field classification";
    }
    parsedFields.push({
      name,
      label: optionalString(field?.label),
      required: boolFromUnknown(field?.required) ?? false,
      classification:
        classification as SensitiveRequestPrivateInfoTarget["fields"][number]["classification"],
    });
  }
  const parsed: SensitiveRequestPrivateInfoTarget = {
    kind: "private_info",
    fields: parsedFields,
  };
  const storage = asRecord(target.storage);
  if (storage) {
    const storageKind = optionalString(storage.kind);
    if (
      storageKind &&
      ["app_metadata", "profile", "workflow_input", "custom"].includes(
        storageKind,
      )
    ) {
      parsed.storage = {
        kind: storageKind as NonNullable<
          SensitiveRequestPrivateInfoTarget["storage"]
        >["kind"],
        key: optionalString(storage.key),
      };
    }
  }
  return parsed;
}

function parseTarget(
  body: CreateBody,
):
  | { kind: "secret" | "private_info"; target: SensitiveRequestTarget }
  | string {
  const target = asRecord(body.target);
  if (!target) return "missing target";
  const kind = optionalString(body.kind) ?? optionalString(target.kind);
  if (kind !== "secret" && kind !== "private_info") {
    return "local sensitive requests support only secret and private_info";
  }
  const parsed =
    kind === "secret"
      ? parseSecretTarget(target)
      : parsePrivateInfoTarget(target);
  if (typeof parsed === "string") return parsed;
  if (parsed.kind !== kind) return "target kind mismatch";
  return { kind, target: parsed };
}

function normalizePolicy(
  kind: SensitiveRequestKind,
  policyInput: unknown,
): SensitiveRequestPolicy {
  const policy = { ...defaultSensitiveRequestPolicy(kind) };
  const raw = asRecord(policyInput);
  if (raw) {
    for (const key of [
      "requirePrivateDelivery",
      "requireAuthenticatedLink",
      "allowInlineOwnerAppEntry",
      "allowPublicLink",
      "allowDmFallback",
      "allowTunnelLink",
      "allowCloudLink",
    ] as const) {
      const parsed = boolFromUnknown(raw[key]);
      if (parsed !== undefined) policy[key] = parsed;
    }
    const actor = optionalString(raw.actor);
    if (
      actor === "owner_or_linked_identity" ||
      actor === "organization_admin"
    ) {
      policy.actor = actor;
    }
  }

  if (kind === "secret" || kind === "private_info") {
    policy.actor = "owner_or_linked_identity";
    policy.requirePrivateDelivery = true;
    policy.requireAuthenticatedLink = true;
    policy.allowPublicLink = false;
  }

  return policy;
}

function localSensitiveRequestAuthEnabledByEnv(): boolean {
  return isTruthy(process.env.ELIZA_TUNNEL_SENSITIVE_REQUEST_AUTH);
}

export function isLocalSensitiveRequestAuthConfigured(
  state: CompatRuntimeState,
): boolean {
  if (!localSensitiveRequestAuthEnabledByEnv()) return false;
  if (getCompatApiToken()) return true;
  return Boolean(state.current?.adapter && "db" in state.current.adapter);
}

function resolveTunnelStatus(
  state: CompatRuntimeState,
): { active: boolean; url?: string | null } | null {
  const service = state.current?.getService?.("tunnel") as
    | {
        getStatus?: () => { active?: boolean; url?: string | null };
        isActive?: () => boolean;
        getUrl?: () => string | null;
      }
    | null
    | undefined;
  if (!service) return null;
  const status = service.getStatus?.();
  return {
    active: Boolean(status?.active ?? service.isActive?.()),
    url:
      typeof status?.url === "string"
        ? status.url
        : (service.getUrl?.() ?? null),
  };
}

function buildEnvironment(
  body: CreateBody,
  state: CompatRuntimeState,
  options: SensitiveRequestRouteOptions,
): SensitiveRequestEnvironment {
  const tunnel = (options.getTunnelStatus ?? resolveTunnelStatus)(state);
  const tunnelAuth = (
    options.isLocalSensitiveRequestAuthConfigured ??
    isLocalSensitiveRequestAuthConfigured
  )(state);
  return {
    cloud: { available: false },
    tunnel: {
      available: Boolean(tunnel?.active && tunnel.url),
      url: tunnel?.url ?? undefined,
      authenticated: tunnelAuth,
    },
    dm: {
      available: boolFromUnknown(body.dmAvailable) ?? true,
    },
    ownerApp: {
      privateChat: boolFromUnknown(body.ownerAppPrivateChat) ?? false,
    },
  };
}

function createDeliveryPlan(
  kind: SensitiveRequestKind,
  body: CreateBody,
  state: CompatRuntimeState,
  policy: SensitiveRequestPolicy,
  options: SensitiveRequestRouteOptions,
): SensitiveRequestDeliveryPlan {
  const delivery = resolveSensitiveRequestDelivery({
    kind,
    source: normalizeSource(body.source),
    channelType: optionalString(body.channelType),
    environment: buildEnvironment(body, state, options),
  });
  return { ...delivery, policy };
}

async function ensureCallerAuthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  if (isTrustedLocalRequest(req)) return true;

  const expected = getCompatApiToken();
  const provided = getProvidedApiToken(req);
  if (expected && provided && tokenMatches(expected, provided)) {
    return true;
  }

  return await ensureRouteAuthorized(req, res, state);
}

async function defaultFulfillSecret(
  record: LocalSensitiveRequestRecord,
  value: string,
): Promise<void> {
  if (record.target.kind !== "secret") {
    throw new Error("request target is not a secret");
  }
  await sharedVault().set(record.target.key, value, {
    sensitive: true,
    caller: "sensitive-request-routes",
  });
}

async function defaultFulfillPrivateInfo(): Promise<void> {
  // No canonical local private-info persistence API exists yet. Keep the
  // fulfillment hook-only and emit a redacted typed event.
}

function eventForSubmission(
  record: LocalSensitiveRequestRecord,
  fields?: Record<string, string>,
): SensitiveRequestEvent {
  if (record.target.kind === "secret") {
    return {
      kind: "secret.set",
      requestId: record.id,
      key: record.target.key,
      scope: record.target.scope,
    };
  }
  return {
    kind: "private_info.submitted",
    requestId: record.id,
    fields: Object.keys(fields ?? {}).sort(),
  };
}

function parseSecretSubmitValue(body: Record<string, unknown>): string | null {
  const value = body.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePrivateInfoSubmitFields(
  record: LocalSensitiveRequestRecord,
  body: Record<string, unknown>,
): Record<string, string> | string {
  if (record.target.kind !== "private_info")
    return "target is not private_info";
  const raw = asRecord(body.fields);
  if (!raw) return "missing fields";
  const fields: Record<string, string> = {};
  const allowed = new Set(record.target.fields.map((field) => field.name));
  for (const field of record.target.fields) {
    const value = raw[field.name];
    if (field.required && (typeof value !== "string" || value.length === 0)) {
      return "missing required field";
    }
    if (typeof value === "string" && allowed.has(field.name)) {
      fields[field.name] = value;
    }
  }
  return fields;
}

function tokenFromBody(body: Record<string, unknown>): string | null {
  return optionalString(body.token) ?? optionalString(body.submitToken) ?? null;
}

function sendSubmitTokenError(
  res: http.ServerResponse,
  status: number,
  reason: string,
): void {
  sendJson(res, status, { ok: false, error: reason });
}

function appendViewedAudit(
  store: LocalSensitiveRequestStore,
  record: LocalSensitiveRequestRecord,
  now: number,
): void {
  const event: SensitiveRequestAuditEvent = {
    action: "viewed",
    outcome: "success",
    createdAt: new Date(now).toISOString(),
  };
  store.appendAudit(record, event);
}

export async function handleSensitiveRequestRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  options: SensitiveRequestRouteOptions = {},
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    return false;
  }

  const store = options.store ?? localSensitiveRequestStore;
  const now = options.now?.() ?? Date.now();

  if (pathname === ROUTE_PREFIX) {
    if (method !== "POST") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    if (!(await ensureCallerAuthorized(req, res, state))) return true;
    const body = (await readCompatJsonBody(req, res)) as CreateBody | null;
    if (!body) return true;
    const parsed = parseTarget(body);
    if (typeof parsed === "string") {
      sendJsonError(res, 400, parsed);
      return true;
    }
    const policy = normalizePolicy(parsed.kind, body.policy);
    const delivery = createDeliveryPlan(
      parsed.kind,
      body,
      state,
      policy,
      options,
    );
    if (
      delivery.mode === "tunnel_authenticated_link" &&
      !(
        options.isLocalSensitiveRequestAuthConfigured ??
        isLocalSensitiveRequestAuthConfigured
      )(state)
    ) {
      sendJsonError(
        res,
        403,
        "local_sensitive_request_auth_required_for_tunnel",
      );
      return true;
    }
    const created = store.create({
      kind: parsed.kind,
      agentId: optionalString(body.agentId) ?? "local-agent",
      organizationId: optionalString(body.organizationId),
      ownerEntityId: optionalString(body.ownerEntityId),
      requesterEntityId: optionalString(body.requesterEntityId),
      sourceRoomId: optionalString(body.sourceRoomId),
      sourceChannelType: optionalString(body.sourceChannelType),
      sourcePlatform: optionalString(body.sourcePlatform),
      target: parsed.target,
      policy,
      delivery,
      callback: asRecord(body.callback) as SensitiveRequestCallback | undefined,
      ttlMs:
        typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
          ? body.ttlMs
          : undefined,
      now,
    });
    sendJson(res, 201, {
      ok: true,
      request: redactLocalSensitiveRequest(created.record),
      submitToken: created.submitToken,
      submit: {
        url: `${ROUTE_PREFIX}/${encodeURIComponent(created.record.id)}/submit`,
        method: "POST",
        tokenRequired: true,
      },
    });
    return true;
  }

  const match = firstPathMatch(pathname);
  if (!match || !SAFE_ID_RE.test(match.id)) {
    sendJsonError(res, 404, "not found");
    return true;
  }

  if (match.action === "get") {
    if (method !== "GET") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    if (!(await ensureCallerAuthorized(req, res, state))) return true;
    const record = store.get(match.id, now);
    if (!record) {
      sendJsonError(res, 404, "not found");
      return true;
    }
    appendViewedAudit(store, record, now);
    sendJson(res, 200, {
      ok: true,
      request: redactLocalSensitiveRequest(record),
    });
    return true;
  }

  if (match.action === "cancel") {
    if (method !== "POST") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    if (!(await ensureCallerAuthorized(req, res, state))) return true;
    const record = store.cancel(match.id, now);
    if (!record) {
      sendJsonError(res, 404, "not found");
      return true;
    }
    const event: SensitiveRequestEvent = {
      kind: "request.canceled",
      requestId: record.id,
    };
    await options.onEvent?.(event, redactLocalSensitiveRequest(record));
    sendJson(res, 200, {
      ok: true,
      request: redactLocalSensitiveRequest(record),
      event,
    });
    return true;
  }

  if (method !== "POST") {
    sendJsonError(res, 405, "method not allowed");
    return true;
  }

  const record = store.get(match.id, now);
  if (!record) {
    sendJsonError(res, 404, "not found");
    return true;
  }
  if (
    record.delivery.mode === "tunnel_authenticated_link" &&
    !(
      options.isLocalSensitiveRequestAuthConfigured ??
      isLocalSensitiveRequestAuthConfigured
    )(state)
  ) {
    sendJsonError(res, 403, "local_sensitive_request_auth_required_for_tunnel");
    return true;
  }
  if (!(await ensureCallerAuthorized(req, res, state))) return true;

  const body = await readCompatJsonBody(req, res);
  if (!body) return true;
  const submitToken = tokenFromBody(body);
  if (!submitToken) {
    sendSubmitTokenError(res, 401, "request_token_required");
    return true;
  }

  let submittedFields: Record<string, string> | undefined;
  let submittedSecret: string | undefined;
  if (record.target.kind === "secret") {
    const value = parseSecretSubmitValue(body);
    if (value === null) {
      sendJsonError(res, 400, "missing secret value");
      return true;
    }
    submittedSecret = value;
  } else if (record.target.kind === "private_info") {
    const fields = parsePrivateInfoSubmitFields(record, body);
    if (typeof fields === "string") {
      sendJsonError(res, 400, fields);
      return true;
    }
    submittedFields = fields;
  } else {
    sendJsonError(res, 400, "unsupported request kind");
    return true;
  }

  const tokenCheck = store.consumeSubmitToken(match.id, submitToken, now);
  if (tokenCheck.ok === false) {
    sendSubmitTokenError(res, tokenCheck.status, tokenCheck.reason);
    return true;
  }

  try {
    if (record.target.kind === "secret") {
      await (options.fulfillSecret ?? defaultFulfillSecret)(
        record,
        submittedSecret ?? "",
      );
    } else {
      await (options.fulfillPrivateInfo ?? defaultFulfillPrivateInfo)(
        record,
        submittedFields ?? {},
      );
    }
    const event = eventForSubmission(record, submittedFields);
    store.fulfill(record.id, event, now);
    const redacted = redactLocalSensitiveRequest(record);
    await options.onEvent?.(event, redacted);
    sendJson(res, 200, { ok: true, request: redacted, event });
  } catch {
    store.fail(record.id, "fulfillment_failed", now);
    sendJsonError(res, 500, "fulfillment_failed");
  }
  return true;
}

export function _resetSensitiveRequestsForTesting(): void {
  localSensitiveRequestStore.reset();
}
