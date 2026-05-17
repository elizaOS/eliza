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
  //
  // Resolution may throw when no Steward URL is configured (typical for local
  // dev or operators who don't use the hosted wallet vault). In that case we
  // skip the STEWARD_API_URL injection — the agent boots without wallet-vault
  // integration and any code path that actually needs Steward will surface a
  // clear error at the call site instead of crashing provisioning.
  const env = getCloudAwareEnv();
  let stewardContainerUrl: string | undefined;
  try {
    stewardContainerUrl = resolveStewardContainerUrl(
      resolveServerStewardApiUrlFromEnv(env),
      env.STEWARD_CONTAINER_URL,
    );
  } catch {
    stewardContainerUrl = undefined;
  }

  if (stewardContainerUrl && !existingEnv.STEWARD_API_URL) {
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
