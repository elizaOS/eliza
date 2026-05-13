import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import type { AgentSandbox } from "@/db/schemas/agent-sandboxes";
import { cache } from "@/lib/cache/client";
import { OPENROUTER_DEFAULT_TEXT_MODEL } from "@/lib/models";
import {
  type ManagedElizaEnvironmentResult,
  type PrepareManagedElizaSharedEnvironmentParams,
  prepareManagedElizaSharedEnvironment,
  resolveCloudPublicUrl,
  resolveElizaAppUrl,
  resolveManagedAllowedOrigins,
} from "@/lib/services/managed-eliza-config";
import { logger } from "@/lib/utils/logger";
import { elizaSandboxService } from "./eliza-sandbox";

const DEFAULT_SMALL_MODEL = OPENROUTER_DEFAULT_TEXT_MODEL;
const DEFAULT_LARGE_MODEL = OPENROUTER_DEFAULT_TEXT_MODEL;
const LAUNCH_SESSION_TTL_SECONDS = 300;

export interface ManagedLaunchConnection {
  apiBase: string;
  token: string;
}

export interface ManagedLaunchSessionPayload {
  agentId: string;
  agentName: string;
  connection: ManagedLaunchConnection;
  issuedAt: string;
}

export interface ManagedLaunchResult extends ManagedLaunchSessionPayload {
  appUrl: string;
  launchSessionId: string | null;
}

export type { ManagedElizaEnvironmentResult } from "@/lib/services/managed-eliza-config";

export class ManagedElizaLaunchError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "ManagedElizaLaunchError";
  }
}

function resolveAgentBaseDomain(): string | null {
  const configured = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN?.trim();
  if (!configured) return null;
  return configured
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "");
}

function resolveManagedAgentApiBase(sandbox: AgentSandbox): string | null {
  const configuredDomain = resolveAgentBaseDomain();
  if (configuredDomain) {
    return `https://${sandbox.id}.${configuredDomain}`;
  }

  if (sandbox.health_url?.trim()) {
    return sandbox.health_url.trim().replace(/\/+$/, "");
  }

  const port = sandbox.web_ui_port ?? sandbox.bridge_port;
  if (sandbox.headscale_ip && port) {
    return `http://${sandbox.headscale_ip}:${port}`;
  }

  return null;
}

async function requestManagedAgent(
  apiBase: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${apiBase.trim().replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
}

async function ensureManagedOnboarding(
  sandbox: AgentSandbox,
  apiBase: string,
  token: string,
  userApiKey: string,
): Promise<void> {
  const statusResponse = await requestManagedAgent(
    apiBase,
    token,
    "/api/onboarding/status",
  );

  if (!statusResponse.ok) {
    throw new ManagedElizaLaunchError(
      `Failed to read onboarding status (HTTP ${statusResponse.status})`,
      502,
    );
  }

  const onboardingStatus = (await statusResponse.json()) as {
    complete?: boolean;
  };
  if (onboardingStatus.complete) {
    return;
  }

  const onboardingBody = {
    name: sandbox.agent_name?.trim() || "Agent",
    runMode: "cloud" as const,
    sandboxMode: "light" as const,
    bio: ["An autonomous AI agent running on Eliza Cloud."],
    systemPrompt: `You are ${sandbox.agent_name?.trim() || "Agent"}, an autonomous AI agent running on Eliza Cloud.`,
    cloudProvider: "elizacloud",
    providerApiKey: userApiKey,
    smallModel: DEFAULT_SMALL_MODEL,
    largeModel: DEFAULT_LARGE_MODEL,
    inventoryProviders: [
      { chain: "evm", rpcProvider: "eliza-cloud" },
      { chain: "bsc", rpcProvider: "eliza-cloud" },
      { chain: "solana", rpcProvider: "eliza-cloud" },
    ],
  };

  const onboardingResponse = await requestManagedAgent(
    apiBase,
    token,
    "/api/onboarding",
    {
      method: "POST",
      body: JSON.stringify(onboardingBody),
    },
  );

  if (!onboardingResponse.ok) {
    const text = await onboardingResponse.text().catch(() => "");
    throw new ManagedElizaLaunchError(
      `Failed to bootstrap managed onboarding (HTTP ${onboardingResponse.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
      502,
    );
  }

  // Best-effort runtime restart so the persisted cloud config is loaded
  // before the web app attaches to this backend.
  await requestManagedAgent(apiBase, token, "/api/agent/restart", {
    method: "POST",
  }).catch((error) => {
    logger.warn(
      "[agent-managed-launch] Agent restart after onboarding failed",
      {
        agentId: sandbox.id,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  });
}

export async function prepareManagedElizaEnvironment(
  params: PrepareManagedElizaSharedEnvironmentParams,
): Promise<ManagedElizaEnvironmentResult> {
  return prepareManagedElizaSharedEnvironment(params);
}

export function resolveLaunchSessionCacheKey(sessionId: string): string {
  return `agent:launch-session:${sessionId}`;
}

export function resolveElizaLaunchAllowedOrigins(): string[] {
  return resolveManagedAllowedOrigins();
}

export async function launchManagedElizaAgent(params: {
  agentId: string;
  organizationId: string;
  userId: string;
}): Promise<ManagedLaunchResult> {
  let sandbox = await elizaSandboxService.getAgent(
    params.agentId,
    params.organizationId,
  );
  if (!sandbox) {
    throw new ManagedElizaLaunchError("Agent not found", 404);
  }

  const managedEnvironment = await prepareManagedElizaEnvironment({
    existingEnv: sandbox.environment_vars,
    organizationId: params.organizationId,
    userId: params.userId,
    agentSandboxId: sandbox.id,
  });

  if (managedEnvironment.changed) {
    await agentSandboxesRepository.update(sandbox.id, {
      environment_vars: managedEnvironment.environmentVars,
    });
    sandbox = {
      ...sandbox,
      environment_vars: managedEnvironment.environmentVars,
    };

    if (sandbox.status === "running") {
      const shutdownResult = await elizaSandboxService.shutdown(
        sandbox.id,
        params.organizationId,
      );
      if (!shutdownResult.success) {
        throw new ManagedElizaLaunchError(
          shutdownResult.error || "Failed to refresh sandbox environment",
          shutdownResult.error === "Agent not found" ? 404 : 409,
        );
      }
      sandbox =
        (await elizaSandboxService.getAgent(
          sandbox.id,
          params.organizationId,
        )) ?? sandbox;
    }
  }

  if (sandbox.status !== "running" || !sandbox.health_url) {
    const provisionResult = await elizaSandboxService.provision(
      sandbox.id,
      params.organizationId,
    );

    if (!provisionResult.success) {
      throw new ManagedElizaLaunchError(
        provisionResult.error || "Provisioning failed",
        provisionResult.error === "Agent not found" ? 404 : 500,
      );
    }

    if (!provisionResult.sandboxRecord) {
      throw new ManagedElizaLaunchError("Provisioning failed", 500);
    }

    sandbox = provisionResult.sandboxRecord;
  }

  const apiBase = resolveManagedAgentApiBase(sandbox);
  if (!apiBase) {
    throw new ManagedElizaLaunchError(
      "Managed launch is unavailable because no agent web endpoint is configured",
      503,
    );
  }

  await ensureManagedOnboarding(
    sandbox,
    apiBase,
    managedEnvironment.apiToken,
    managedEnvironment.agentApiKey,
  );

  const connection: ManagedLaunchConnection = {
    apiBase,
    token: managedEnvironment.apiToken,
  };
  const payload: ManagedLaunchSessionPayload = {
    agentId: sandbox.id,
    agentName: sandbox.agent_name ?? "Agent",
    connection,
    issuedAt: new Date().toISOString(),
  };

  const appUrl = new URL(resolveElizaAppUrl());
  let launchSessionId: string | null = null;

  if (cache.isAvailable()) {
    try {
      launchSessionId = crypto.randomUUID();
      await cache.set(
        resolveLaunchSessionCacheKey(launchSessionId),
        payload,
        LAUNCH_SESSION_TTL_SECONDS,
      );
      appUrl.searchParams.set("cloudLaunchSession", launchSessionId);
      // `cloudLaunchBase` is the Cloud web origin consumed by the Agent app,
      // not the agent-runtime API base. The runtime env uses `/api/v1`; the
      // launch URL intentionally does not.
      appUrl.searchParams.set("cloudLaunchBase", resolveCloudPublicUrl());
    } catch (error) {
      launchSessionId = null;
      logger.warn(
        "[agent-managed-launch] Failed to persist launch session; falling back to direct launch params",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  if (!launchSessionId) {
    logger.error(
      "[agent-managed-launch] Cache unavailable; cannot launch safely without leaking token",
    );
    throw new ManagedElizaLaunchError(
      "Managed launch is unavailable because the session cache is unreachable.",
      503,
    );
  }

  return {
    ...payload,
    appUrl: appUrl.toString(),
    launchSessionId,
  };
}
