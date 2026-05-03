import { requireAdmin, requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppContext } from "@/types/cloud-worker-env";
import { type CloudCapability, type CloudCapabilityStatus, getCloudCapabilities } from "./registry";

type CapabilityArgs = Record<string, unknown>;
type HttpMethod = CloudCapability["surfaces"]["rest"]["method"];

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function asObject(value: unknown): CapabilityArgs {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CapabilityArgs)
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function resolveMethod(input: CapabilityArgs, params: CapabilityArgs, fallback: HttpMethod) {
  const candidate =
    typeof input.method === "string"
      ? input.method.toUpperCase()
      : typeof params.method === "string"
        ? params.method.toUpperCase()
        : fallback;
  if (!HTTP_METHODS.has(candidate)) throw new Error(`Unsupported method: ${candidate}`);
  return candidate as HttpMethod;
}

function resolvePath(path: string, input: CapabilityArgs, params: CapabilityArgs): string {
  const pathParams = {
    ...asObject(params.pathParams),
    ...asObject(input.pathParams),
  };

  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value =
      stringValue(pathParams[name]) ??
      stringValue(params[name]) ??
      stringValue(input[name]) ??
      stringValue(input.resourceId);
    if (!value) throw new Error(`Missing path parameter: ${name}`);
    return encodeURIComponent(value);
  });
}

function resolveQuery(input: CapabilityArgs, params: CapabilityArgs): CapabilityArgs {
  return {
    ...asObject(params.query),
    ...asObject(input.query),
  };
}

function resolveBody(
  method: HttpMethod,
  input: CapabilityArgs,
  params: CapabilityArgs,
): unknown | undefined {
  if (method === "GET" || method === "DELETE") return undefined;
  if (input.body !== undefined) return input.body;
  if (params.body !== undefined) return params.body;
  if (Object.keys(params).length > 0) return params;
  return undefined;
}

function findCapability(identifier: string): CloudCapability | undefined {
  return getCloudCapabilities().find(
    (capability) =>
      capability.id === identifier ||
      capability.surfaces.mcp.tool === identifier ||
      capability.surfaces.a2a.skill === identifier,
  );
}

function copyRequestHeaders(c: AppContext, input: CapabilityArgs): Headers {
  const headers = new Headers();
  for (const name of [
    "authorization",
    "x-api-key",
    "x-wallet-address",
    "x-timestamp",
    "x-wallet-signature",
    "x-payment",
    "idempotency-key",
    "x-idempotency-key",
    "cookie",
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }

  const extraHeaders = asObject(input.headers);
  for (const name of ["x-payment", "idempotency-key", "x-idempotency-key"]) {
    const value = extraHeaders[name];
    if (typeof value === "string" && value.length > 0) headers.set(name, value);
  }

  headers.set("content-type", "application/json");
  return headers;
}

function buildUrl(c: AppContext, path: string, query: CapabilityArgs): URL {
  if (!path.startsWith("/api/")) throw new Error("Capability REST path must begin with /api/");
  if (path.startsWith("/api/mcp")) {
    throw new Error("Capability REST execution cannot recursively call /api/mcp");
  }

  const url = new URL(path, c.req.url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function authorizeCapability(c: AppContext, capability: CloudCapability) {
  if (capability.auth.adminOnly || capability.auth.modes.includes("admin")) {
    await requireAdmin(c);
    return;
  }

  if (capability.category === "auth" || capability.auth.modes.includes("public")) {
    return;
  }

  await requireUserOrApiKeyWithOrg(c);
}

export async function executeCloudCapabilityRest(
  c: AppContext,
  identifier: string,
  args: unknown,
): Promise<{
  capability: {
    id: string;
    restStatus: CloudCapabilityStatus;
    mcpStatus: CloudCapabilityStatus;
    a2aStatus: CloudCapabilityStatus;
  };
  request: { method: HttpMethod; path: string };
  response: { status: number; ok: boolean; body: unknown };
}> {
  const capability = findCapability(identifier);
  if (!capability) throw new Error(`Unknown Cloud capability: ${identifier}`);

  await authorizeCapability(c, capability);

  const input = asObject(args);
  const params = asObject(input.params);
  const method = resolveMethod(input, params, capability.surfaces.rest.method);
  const path = resolvePath(capability.surfaces.rest.path, input, params);
  const query = resolveQuery(input, params);
  const body = resolveBody(method, input, params);
  const url = buildUrl(c, path, query);

  const response = await fetch(url, {
    method,
    headers: copyRequestHeaders(c, input),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const responseBody = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  return {
    capability: {
      id: capability.id,
      restStatus: capability.surfaces.rest.status,
      mcpStatus: capability.surfaces.mcp.status,
      a2aStatus: capability.surfaces.a2a.status,
    },
    request: { method, path },
    response: {
      status: response.status,
      ok: response.ok,
      body: responseBody,
    },
  };
}
