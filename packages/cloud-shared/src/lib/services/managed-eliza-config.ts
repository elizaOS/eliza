import crypto from "node:crypto";
import { getElizaAgentPublicWebUiUrl } from "../eliza-agent-web-ui";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { apiKeysService } from "./api-keys";

const DEFAULT_ELIZA_APP_URL = "https://eliza.app";
const DEFAULT_CLOUD_PUBLIC_URL = "https://www.elizacloud.ai";
const DEV_ELIZA_APP_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
] as const;

export interface ManagedElizaEnvironmentResult {
  apiToken: string;
  changed: boolean;
  environmentVars: Record<string, string>;
  agentApiKey: string;
}

export interface ManagedElizaBaseEnvironmentResult {
  apiToken: string;
  environmentVars: Record<string, string>;
  agentApiKey: string;
}

export interface PrepareManagedElizaSharedEnvironmentParams {
  existingEnv?: Record<string, string> | null;
  organizationId: string;
  userId: string;
  agentSandboxId: string;
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function resolveElizaAppUrl(): string {
  const env = getCloudAwareEnv();
  return normalizeBaseUrl(
    env.NEXT_PUBLIC_ELIZA_APP_URL || env.ELIZA_APP_URL || DEFAULT_ELIZA_APP_URL,
  );
}

export function resolveCloudPublicUrl(): string {
  const env = getCloudAwareEnv();
  return normalizeBaseUrl(
    env.NEXT_PUBLIC_APP_URL || env.ELIZA_CLOUD_URL || DEFAULT_CLOUD_PUBLIC_URL,
  );
}

export function resolveCloudApiBaseUrl(): string {
  const env = getCloudAwareEnv();
  const explicit =
    env.ELIZAOS_CLOUD_BASE_URL || env.ELIZA_CLOUD_API_BASE_URL || env.NEXT_PUBLIC_API_URL;
  if (explicit) {
    return normalizeBaseUrl(explicit);
  }
  return `${resolveCloudPublicUrl()}/api/v1`;
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function resolveManagedAllowedOrigins(): string[] {
  const origins = new Set<string>();
  const appOrigin = parseOrigin(resolveElizaAppUrl());
  const cloudOrigin = parseOrigin(resolveCloudPublicUrl());
  if (appOrigin) origins.add(appOrigin);
  if (cloudOrigin) origins.add(cloudOrigin);

  const env = getCloudAwareEnv();
  if (env.NODE_ENV !== "production") {
    for (const origin of DEV_ELIZA_APP_ORIGINS) {
      origins.add(origin);
    }
  }

  const extraOrigins = env.ELIZA_MANAGED_ALLOWED_ORIGINS;
  if (extraOrigins) {
    for (const item of extraOrigins.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const normalized = parseOrigin(trimmed);
      if (normalized) origins.add(normalized);
    }
  }

  return [...origins];
}

export function mergeManagedAllowedOrigins(existingValue?: string): string {
  const merged = new Set<string>();
  if (existingValue) {
    for (const entry of existingValue.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const origin = parseOrigin(trimmed);
      if (origin) merged.add(origin);
    }
  }

  for (const origin of resolveManagedAllowedOrigins()) {
    merged.add(origin);
  }

  return [...merged].join(",");
}

function isManagedPublicBaseUrlCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (
    trimmed.includes("(new-agent-id)") ||
    trimmed.includes("<agent-id>") ||
    trimmed.includes("${agentId}")
  ) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return true;
  }

  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol !== "https:" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".trycloudflare.com") ||
    hostname.endsWith(".ngrok-free.app") ||
    hostname.endsWith(".ngrok.io")
  );
}

export function mergeManagedPublicBaseUrl(
  existingValue: string | undefined,
  agentSandboxId: string,
): string {
  const publicUrl = getElizaAgentPublicWebUiUrl({
    id: agentSandboxId,
    headscale_ip: null,
  });
  const trimmed = existingValue?.trim();

  if (!publicUrl) {
    return trimmed ?? "";
  }

  if (!trimmed || isManagedPublicBaseUrlCandidate(trimmed)) {
    return publicUrl;
  }

  return trimmed;
}

export async function prepareManagedElizaBaseEnvironment(
  params: PrepareManagedElizaSharedEnvironmentParams,
): Promise<ManagedElizaBaseEnvironmentResult> {
  const existingEnv = { ...(params.existingEnv ?? {}) };
  const { plainKey: agentApiKey } = await apiKeysService.createForAgent({
    organizationId: params.organizationId,
    userId: params.userId,
    agentSandboxId: params.agentSandboxId,
  });
  const apiToken =
    existingEnv.ELIZA_API_TOKEN?.trim() || `agent_${crypto.randomUUID().replace(/-/g, "")}`;

  return {
    apiToken,
    agentApiKey,
    environmentVars: {
      ...existingEnv,
      ELIZA_API_TOKEN: apiToken,
      ELIZA_ALLOW_WS_QUERY_TOKEN: "1",
      ELIZA_ALLOWED_ORIGINS: mergeManagedAllowedOrigins(existingEnv.ELIZA_ALLOWED_ORIGINS),
      // Public web UI on by default — users access it via the agent
      // subdomain (https://<agent-id>.elizacloud.ai), gated by
      // ELIZA_API_TOKEN at the agent-router. Set ELIZA_UI_ENABLE=false in
      // existingEnv to opt out per-agent.
      ELIZA_UI_ENABLE: existingEnv.ELIZA_UI_ENABLE ?? "true",
      ELIZAOS_CLOUD_API_KEY: agentApiKey,
      ELIZAOS_CLOUD_ENABLED: "true",
      ELIZAOS_CLOUD_BASE_URL: resolveCloudApiBaseUrl(),
      ELIZA_CLOUD_AGENT_ID: params.agentSandboxId,
      PUBLIC_BASE_URL: mergeManagedPublicBaseUrl(
        existingEnv.PUBLIC_BASE_URL,
        params.agentSandboxId,
      ),
      WAIFU_ELIZA_CLOUD_AGENT_ID: params.agentSandboxId,
    },
  };
}

export async function prepareManagedElizaSharedEnvironment(
  params: PrepareManagedElizaSharedEnvironmentParams,
): Promise<ManagedElizaEnvironmentResult> {
  const existingEnv = { ...(params.existingEnv ?? {}) };
  const baseEnvironment = await prepareManagedElizaBaseEnvironment({
    existingEnv,
    organizationId: params.organizationId,
    userId: params.userId,
    agentSandboxId: params.agentSandboxId,
  });
  const environmentVars: Record<string, string> = {
    ...baseEnvironment.environmentVars,
  };

  return {
    apiToken: environmentVars.ELIZA_API_TOKEN,
    changed: JSON.stringify(existingEnv) !== JSON.stringify(environmentVars),
    environmentVars,
    agentApiKey: baseEnvironment.agentApiKey,
  };
}
