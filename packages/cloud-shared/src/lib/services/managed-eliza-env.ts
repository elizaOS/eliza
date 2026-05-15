import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { resolveServerStewardApiUrlFromEnv } from "../steward-url";
import { resolveStewardContainerUrl } from "./docker-sandbox-utils";
import {
  type ManagedElizaEnvironmentResult,
  prepareManagedElizaSharedEnvironment,
} from "./managed-eliza-config";

export type { ManagedElizaEnvironmentResult } from "./managed-eliza-config";

export async function prepareManagedElizaEnvironment(params: {
  existingEnv?: Record<string, string> | null;
  organizationId: string;
  userId: string;
  sandboxId: string;
}): Promise<ManagedElizaEnvironmentResult> {
  const existingEnv = { ...(params.existingEnv ?? {}) };
  const sharedEnvironment = await prepareManagedElizaSharedEnvironment({
    existingEnv,
    organizationId: params.organizationId,
    userId: params.userId,
    agentSandboxId: params.sandboxId,
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
    agentApiKey: sharedEnvironment.agentApiKey,
  };
}
