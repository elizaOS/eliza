import type http from "node:http";
import { isIP } from "node:net";
import { type ElizaConfig, loadElizaConfig } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import {
  isLoopbackBindHost,
  normalizeOnboardingProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { sendJsonError as sendJsonErrorResponse } from "./response";

const MAX_BODY_BYTES = 1_048_576;

export interface CompatRuntimeState {
  current: AgentRuntime | null;
  pendingAgentName: string | null;
  pendingRestartReasons: string[];
}

export function clearCompatRuntimeRestart(state: CompatRuntimeState): void {
  state.pendingRestartReasons = [];
}

export function scheduleCompatRuntimeRestart(
  state: CompatRuntimeState,
  reason: string,
): void {
  if (state.pendingRestartReasons.includes(reason)) {
    return;
  }

  if (state.pendingRestartReasons.length >= 50) {
    state.pendingRestartReasons.splice(
      1,
      state.pendingRestartReasons.length - 1,
    );
  }

  state.pendingRestartReasons.push(reason);
}

export const DATABASE_UNAVAILABLE_MESSAGE =
  "Database not available. The agent may not be running or the database adapter is not initialized.";

export function isLoopbackRemoteAddress(
  remoteAddress: string | null | undefined,
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "::ffff:0:127.0.0.1"
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

const CLIENT_IP_PROXY_HEADERS = new Set([
  "forwarded",
  "forwarded-for",
  "x-forwarded",
  "x-forwarded-for",
  "x-original-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "x-forwarded-client-ip",
  "x-cluster-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "x-appengine-user-ip",
  "x-azure-clientip",
]);

function headerValues(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function isClientIpProxyHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    CLIENT_IP_PROXY_HEADERS.has(normalized) ||
    normalized.endsWith("-client-ip") ||
    normalized.endsWith("-connecting-ip") ||
    normalized.endsWith("-real-ip")
  );
}

function extractForwardedForCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const pattern = /(?:^|[;,])\s*for=(?:"([^"]*)"|([^;,]*))/gi;
  for (const match of raw.matchAll(pattern)) {
    candidates.push(match[1] ?? match[2] ?? "");
  }
  return candidates;
}

function extractProxyClientAddressCandidates(
  headerName: string,
  raw: string,
): string[] {
  if (headerName === "forwarded") {
    return extractForwardedForCandidates(raw);
  }

  const forwardedCandidates = raw.toLowerCase().includes("for=")
    ? extractForwardedForCandidates(raw)
    : [];
  if (forwardedCandidates.length > 0) return forwardedCandidates;

  return raw.split(",");
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isNeutralProxyClientAddress(raw: string): boolean {
  const normalized = stripMatchingQuotes(raw).trim().toLowerCase();
  return (
    !normalized ||
    normalized === "unknown" ||
    normalized === "null" ||
    normalized.startsWith("_")
  );
}

function normalizeProxyClientIp(raw: string): string | null {
  let normalized = stripMatchingQuotes(raw).trim();
  if (!normalized) return null;

  if (normalized.startsWith("[")) {
    const close = normalized.indexOf("]");
    if (close > 0) {
      normalized = normalized.slice(1, close);
    }
  } else {
    const ipv4HostPort = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)$/.exec(normalized);
    if (ipv4HostPort?.[1]) {
      normalized = ipv4HostPort[1];
    }
  }

  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }

  normalized = normalized.trim().toLowerCase();
  return isIP(normalized) ? normalized : null;
}

function isLoopbackProxyClientIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:0:127.")
  );
}

function proxyClientHeaderBlocksLocalTrust(
  headers: http.IncomingHttpHeaders,
): boolean {
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const headerName = rawName.toLowerCase();
    if (!isClientIpProxyHeaderName(headerName)) continue;

    for (const value of headerValues(rawValue)) {
      for (const candidate of extractProxyClientAddressCandidates(
        headerName,
        value,
      )) {
        if (isNeutralProxyClientAddress(candidate)) continue;
        const ip = normalizeProxyClientIp(candidate);
        if (!ip || !isLoopbackProxyClientIp(ip)) return true;
      }
    }
  }

  return false;
}

function isCloudProvisionedByEnv(): boolean {
  return process.env.ELIZA_CLOUD_PROVISIONED === "1";
}

function isLocalAuthRequiredByEnv(): boolean {
  return process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1";
}

function isTrustedLocalOrigin(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return true;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "file:" ||
      parsed.protocol === "app:" ||
      parsed.protocol === "tauri:" ||
      parsed.protocol === "capacitor:" ||
      parsed.protocol === "capacitor-electron:" ||
      parsed.protocol === "electrobun:"
    ) {
      return true;
    }
    return isLoopbackBindHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Same-machine dashboard access. This is intentionally stricter than just
 * checking `remoteAddress`: the browser must also be targeting a loopback Host
 * and must not present cross-site browser metadata.
 */
export function isTrustedLocalRequest(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): boolean {
  if (isLocalAuthRequiredByEnv()) return false;
  if (isCloudProvisionedByEnv()) return false;
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false;
  if (proxyClientHeaderBlocksLocalTrust(req.headers)) return false;

  const host = firstHeaderValue(req.headers.host);
  if (host && !isLoopbackBindHost(host)) return false;

  const secFetchSite = firstHeaderValue(
    req.headers["sec-fetch-site"],
  )?.toLowerCase();
  if (secFetchSite === "cross-site") return false;

  const origin = firstHeaderValue(req.headers.origin);
  if (origin && !isTrustedLocalOrigin(origin)) return false;

  const referer = firstHeaderValue(req.headers.referer);
  if (!origin && referer && !isTrustedLocalOrigin(referer)) return false;

  return true;
}

export async function readCompatJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  // When this handler is invoked through the runtime's plugin-route adapter
  // (rawPath: true), the runtime has already consumed the request stream and
  // attached the parsed JSON body as `req.body`. Streaming the IncomingMessage
  // again would yield zero bytes and we'd return `{}`, even though the caller
  // sent a real payload. Honour the pre-parsed body when present.
  const preParsed = (req as { body?: unknown }).body;
  if (preParsed && typeof preParsed === "object" && !Array.isArray(preParsed)) {
    return preParsed as Record<string, unknown>;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        sendJsonErrorResponse(res, 413, "Request body too large");
        return null;
      }
      chunks.push(buf);
    }
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid request body");
    return null;
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJsonErrorResponse(res, 400, "Invalid JSON body");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid JSON body");
    return null;
  }
}

export function hasCompatPersistedOnboardingState(
  config: ElizaConfig,
): boolean {
  if ((config.meta as Record<string, unknown>)?.onboardingComplete === true) {
    return true;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = normalizeOnboardingProviderId(llmText?.backend);
  const remoteApiBase =
    llmText?.remoteApiBase?.trim() ?? deploymentTarget.remoteApiBase?.trim();
  const hasCompleteCanonicalRouting =
    (llmText?.transport === "direct" &&
      Boolean(backend && backend !== "elizacloud")) ||
    (llmText?.transport === "remote" && Boolean(remoteApiBase)) ||
    (llmText?.transport === "cloud-proxy" &&
      backend === "elizacloud" &&
      Boolean(llmText.smallModel?.trim() && llmText.largeModel?.trim())) ||
    (deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase?.trim()));

  if (hasCompleteCanonicalRouting) {
    return true;
  }

  if (Array.isArray(config.agents?.list) && config.agents.list.length > 0) {
    return true;
  }

  return Boolean(
    config.agents?.defaults?.workspace?.trim() ||
      config.agents?.defaults?.adminEntityId?.trim(),
  );
}

export function getConfiguredCompatAgentName(): string | null {
  const config = loadElizaConfig();
  const listAgent = config.agents?.list?.[0];
  const listAgentName =
    typeof listAgent?.name === "string" ? listAgent.name.trim() : "";
  if (listAgentName) {
    return listAgentName;
  }

  const assistantName =
    typeof config.ui?.assistant?.name === "string"
      ? config.ui.assistant.name.trim()
      : "";
  return assistantName || null;
}

interface AdapterWithDb {
  db?: unknown;
}

/**
 * Best-effort grab of the Drizzle DB handle off the live runtime adapter.
 * Returns null when the runtime is not yet up or the adapter has not
 * exposed a `db` field. Callers MUST treat null as "service unavailable"
 * — it is never authentication.
 */
export function getCompatDrizzleDb(state: CompatRuntimeState): unknown | null {
  const runtime = state.current;
  if (!runtime) return null;
  const adapter = runtime.adapter as AdapterWithDb | undefined;
  if (!adapter?.db) return null;
  return adapter.db;
}
