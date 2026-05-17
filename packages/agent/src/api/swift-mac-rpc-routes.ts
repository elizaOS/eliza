import type http from "node:http";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type SwiftMacRPCMethod =
  | "runtime.health"
  | "runtime.agents"
  | "runtime.logs"
  | "wallet.config"
  | "wallet.addresses"
  | "wallet.balances"
  | "wallet.stewardStatus"
  | "permissions.list"
  | "permissions.automationMode"
  | "permissions.tradeMode"
  | "conversation.create"
  | "conversation.messages"
  | "conversation.send";

interface SwiftMacRPCRequest {
  id?: string;
  method: SwiftMacRPCMethod;
  params?: JsonObject;
}

interface SwiftMacRPCTarget {
  method: "GET" | "POST";
  path: string;
  body?: JsonObject;
}

interface SwiftMacRPCRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<T | null>;
  json: (res: http.ServerResponse, data: JsonObject, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
}

const METHOD_PATHS: Record<
  Exclude<
    SwiftMacRPCMethod,
    "conversation.create" | "conversation.messages" | "conversation.send"
  >,
  SwiftMacRPCTarget
> = {
  "runtime.health": { method: "GET", path: "/api/health" },
  "runtime.agents": { method: "GET", path: "/api/agents" },
  "runtime.logs": { method: "GET", path: "/api/logs" },
  "wallet.config": { method: "GET", path: "/api/wallet/config" },
  "wallet.addresses": { method: "GET", path: "/api/wallet/addresses" },
  "wallet.balances": { method: "GET", path: "/api/wallet/balances" },
  "wallet.stewardStatus": {
    method: "GET",
    path: "/api/wallet/steward-status",
  },
  "permissions.list": { method: "GET", path: "/api/permissions" },
  "permissions.automationMode": {
    method: "GET",
    path: "/api/permissions/automation-mode",
  },
  "permissions.tradeMode": {
    method: "GET",
    path: "/api/permissions/trade-mode",
  },
};

const VALID_METHODS = new Set<SwiftMacRPCMethod>([
  ...Object.keys(METHOD_PATHS),
  "conversation.create",
  "conversation.messages",
  "conversation.send",
] as SwiftMacRPCMethod[]);

export async function handleSwiftMacRPCRoutes(
  ctx: SwiftMacRPCRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, readJsonBody, json, error } = ctx;
  if (pathname !== "/api/swift/rpc") return false;

  if (method !== "POST") {
    error(res, "Swift RPC requires POST", 405);
    return true;
  }

  const body = await readJsonBody<Partial<SwiftMacRPCRequest>>(req, res);
  if (body === null) return true;

  const parsed = parseRPCRequest(body);
  if (!parsed.ok) {
    error(res, parsed.error, 400);
    return true;
  }

  let target: SwiftMacRPCTarget;
  try {
    target = targetFor(parsed.request);
  } catch (err) {
    error(res, err instanceof Error ? err.message : String(err), 400);
    return true;
  }

  let forwarded: {
    ok: boolean;
    status: number;
    payload: JsonValue;
    error: string;
  };
  try {
    forwarded = await forwardRPCRequest(req, target);
  } catch (err) {
    json(res, {
      id: parsed.request.id ?? null,
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : String(err),
      result: null,
    });
    return true;
  }

  json(
    res,
    {
      id: parsed.request.id ?? null,
      ok: forwarded.ok,
      status: forwarded.status,
      ...(forwarded.ok
        ? { result: forwarded.payload }
        : { error: forwarded.error, result: forwarded.payload }),
    },
    200,
  );
  return true;
}

function parseRPCRequest(
  body: Partial<SwiftMacRPCRequest>,
): { ok: true; request: SwiftMacRPCRequest } | { ok: false; error: string } {
  if (!isObject(body)) {
    return { ok: false, error: "Swift RPC body must be an object" };
  }

  if (typeof body.method !== "string" || !VALID_METHODS.has(body.method)) {
    return { ok: false, error: "Swift RPC method is invalid" };
  }

  if (body.id !== undefined && typeof body.id !== "string") {
    return { ok: false, error: "Swift RPC id must be a string" };
  }

  if (body.params !== undefined && !isJsonObject(body.params)) {
    return { ok: false, error: "Swift RPC params must be an object" };
  }

  return {
    ok: true,
    request: {
      ...(body.id ? { id: body.id } : {}),
      method: body.method,
      ...(body.params ? { params: body.params } : {}),
    },
  };
}

function targetFor(request: SwiftMacRPCRequest): SwiftMacRPCTarget {
  if (request.method in METHOD_PATHS) {
    return METHOD_PATHS[request.method as keyof typeof METHOD_PATHS];
  }

  switch (request.method) {
    case "conversation.create":
      return {
        method: "POST",
        path: "/api/conversations",
        body: request.params ?? {},
      };
    case "conversation.messages": {
      const conversationId = requiredString(request.params, "conversationID");
      return {
        method: "GET",
        path: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      };
    }
    case "conversation.send": {
      const conversationId = requiredString(request.params, "conversationID");
      const text = requiredString(request.params, "text");
      const channelType = optionalString(request.params, "channelType") ?? "DM";
      const source = optionalString(request.params, "source") ?? "swift-macos";
      const metadata = optionalObject(request.params, "metadata");
      return {
        method: "POST",
        path: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        body: {
          text,
          channelType,
          source,
          ...(metadata ? { metadata } : {}),
        },
      };
    }
  }

  throw new Error(`Swift RPC method is not implemented: ${request.method}`);
}

async function forwardRPCRequest(
  req: http.IncomingMessage,
  target: SwiftMacRPCTarget,
): Promise<{
  ok: boolean;
  status: number;
  payload: JsonValue;
  error: string;
}> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(target.path, `http://${host}`);
  const response = await fetch(url, {
    method: target.method,
    headers: {
      Accept: "application/json",
      ...(typeof req.headers.authorization === "string"
        ? { Authorization: req.headers.authorization }
        : {}),
      ...(target.body ? { "Content-Type": "application/json" } : {}),
      "X-Eliza-Swift-RPC": "1",
    },
    body: target.body ? JSON.stringify(target.body) : undefined,
  });

  const text = await response.text();
  const payload = parseJsonText(text);
  const errorMessage = response.ok
    ? ""
    : errorMessageFromPayload(payload) || response.statusText;

  return {
    ok: response.ok,
    status: response.status,
    payload,
    error: errorMessage,
  };
}

function requiredString(params: JsonObject | undefined, key: string): string {
  const value = params?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Swift RPC param "${key}" is required`);
  }
  return value.trim();
}

function optionalString(
  params: JsonObject | undefined,
  key: string,
): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalObject(
  params: JsonObject | undefined,
  key: string,
): JsonObject | undefined {
  const value = params?.[key];
  return isJsonObject(value) ? value : undefined;
}

function parseJsonText(text: string): JsonValue {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return { text };
  }
}

function errorMessageFromPayload(payload: JsonValue): string {
  if (!isJsonObject(payload)) return "";
  const errorValue = payload.error;
  if (typeof errorValue === "string") return errorValue;
  const messageValue = payload.message;
  return typeof messageValue === "string" ? messageValue : "";
}

function isObject(value: object): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
