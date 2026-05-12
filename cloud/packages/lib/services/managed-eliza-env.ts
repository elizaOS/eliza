import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { resolveStewardContainerUrl } from "@/lib/services/docker-sandbox-utils";
import {
  type ManagedElizaEnvironmentResult,
  prepareManagedElizaSharedEnvironment,
} from "@/lib/services/managed-eliza-config";
import { resolveServerStewardApiUrlFromEnv } from "@/lib/steward-url";

export type { ManagedElizaEnvironmentResult } from "@/lib/services/managed-eliza-config";

export async function prepareManagedElizaEnvironment(params: {
  existingEnv?: Record<string, string> | null;
  organizationId: string;
  userId: string;
  /** Sandbox/agent ID — used as STEWARD_AGENT_ID for Docker-backed agents. */
  sandboxId?: string;
}): Promise<ManagedElizaEnvironmentResult> {
  const existingEnv = { ...(params.existingEnv ?? {}) };
  const sharedEnvironment = await prepareManagedElizaSharedEnvironment({
    existingEnv,
    organizationId: params.organizationId,
    userId: params.userId,
  });
  const environmentVars: Record<string, string> = {
    ...sharedEnvironment.environmentVars,
  };

  // Steward env vars — Docker-backed agents need these to talk to the wallet vault.
  // STEWARD_API_URL is resolved for container reachability (host.docker.internal
  // or the explicit override). STEWARD_AGENT_ID maps to the sandbox ID.
  // STEWARD_AGENT_TOKEN is set during provisioning in docker-sandbox-provider.ts.
  const env = getCloudAwareEnv();
  const stewardContainerUrl = resolveStewardContainerUrl(
    resolveServerStewardApiUrlFromEnv(env),
    env.STEWARD_CONTAINER_URL,
  );

  if (!existingEnv.STEWARD_API_URL) {
    environmentVars.STEWARD_API_URL = stewardContainerUrl;
  }
  if (params.sandboxId && !existingEnv.STEWARD_AGENT_ID) {
    environmentVars.STEWARD_AGENT_ID = params.sandboxId;
  }

  const changed = JSON.stringify(existingEnv) !== JSON.stringify(environmentVars);

  return {
    apiToken: environmentVars.ELIZA_API_TOKEN,
    changed,
    environmentVars,
    userApiKey: sharedEnvironment.userApiKey,
  };
}
