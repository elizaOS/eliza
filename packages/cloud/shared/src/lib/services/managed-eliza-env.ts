import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { resolveServerStewardApiUrlFromEnv } from "../steward-url";
import { resolveStewardContainerUrl } from "./docker-sandbox-utils";
import {
  type ManagedElizaEnvironmentResult,
  prepareManagedElizaSharedEnvironment,
} from "./managed-eliza-config";

export type { ManagedElizaEnvironmentResult } from "./managed-eliza-config";

export const DEFAULT_STEWARD_KEYLESS_OPENAI_CAPABILITY = "openai.chat.completions";

function envFlagEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isStewardKeylessOpenAIEnabled(
  env: Pick<
    NodeJS.ProcessEnv,
    "STEWARD_KEYLESS_HOSTED_AGENTS" | "STEWARD_KEYLESS_OPENAI"
  > = process.env,
): boolean {
  return (
    envFlagEnabled(env.STEWARD_KEYLESS_HOSTED_AGENTS) && envFlagEnabled(env.STEWARD_KEYLESS_OPENAI)
  );
}

export function allowsStewardKeylessRawOpenAIFallback(
  env: Pick<NodeJS.ProcessEnv, "STEWARD_KEYLESS_FALLBACK_RAW_ENV"> = process.env,
): boolean {
  return envFlagEnabled(env.STEWARD_KEYLESS_FALLBACK_RAW_ENV);
}

export function shouldStripRawOpenAIForKeyless(
  env: Pick<
    NodeJS.ProcessEnv,
    "STEWARD_KEYLESS_HOSTED_AGENTS" | "STEWARD_KEYLESS_OPENAI" | "STEWARD_KEYLESS_FALLBACK_RAW_ENV"
  > = process.env,
): boolean {
  return isStewardKeylessOpenAIEnabled(env) && !allowsStewardKeylessRawOpenAIFallback(env);
}

export function resolveStewardKeylessOpenAICapability(
  env: Pick<NodeJS.ProcessEnv, "STEWARD_KEYLESS_OPENAI_CAPABILITY"> = process.env,
): string {
  return env.STEWARD_KEYLESS_OPENAI_CAPABILITY?.trim() || DEFAULT_STEWARD_KEYLESS_OPENAI_CAPABILITY;
}

export function resolveStewardKeylessOpenAIBaseURL(params: {
  stewardApiUrl: string;
  env?: Pick<
    NodeJS.ProcessEnv,
    "STEWARD_KEYLESS_OPENAI_BASE_URL" | "STEWARD_KEYLESS_OPENAI_CAPABILITY"
  >;
}): string {
  const override = params.env?.STEWARD_KEYLESS_OPENAI_BASE_URL?.trim();
  if (override) return stripTrailingSlash(override);
  const stewardApiUrl = params.stewardApiUrl.trim();
  if (!stewardApiUrl) {
    throw new Error("[managed-eliza-env] STEWARD_API_URL is required for keyless OpenAI wiring");
  }
  const capability = encodeURIComponent(resolveStewardKeylessOpenAICapability(params.env));
  return `${stripTrailingSlash(stewardApiUrl)}/capabilities/${capability}/openai/v1`;
}

export function buildManagedKeylessOpenAIEnv(params: {
  stewardApiUrl: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = params.env ?? process.env;
  if (!isStewardKeylessOpenAIEnabled(env) || allowsStewardKeylessRawOpenAIFallback(env)) return {};
  const capability = resolveStewardKeylessOpenAICapability(env);
  return {
    STEWARD_INVOKE_URL: `${stripTrailingSlash(params.stewardApiUrl)}/capabilities`,
    STEWARD_CAPABILITIES: JSON.stringify({ openai: capability }),
    STEWARD_CAP_OPENAI_CHAT: capability,
    STEWARD_KEYLESS_MODE: "capability-openai",
    STEWARD_KEYLESS_SERVICES: "openai",
    OPENAI_BASE_URL: resolveStewardKeylessOpenAIBaseURL({
      stewardApiUrl: params.stewardApiUrl,
      env,
    }),
  };
}

export function buildKeylessOpenAIContainerEnv(params: {
  stewardApiUrl: string;
  stewardAuthToken?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = params.env ?? process.env;
  if (!isStewardKeylessOpenAIEnabled(env) || allowsStewardKeylessRawOpenAIFallback(env)) return {};
  const token = params.stewardAuthToken?.trim();
  if (!token) {
    throw new Error(
      "[docker-sandbox] STEWARD_AGENT_TOKEN or STEWARD_JWT is required for keyless OpenAI wiring",
    );
  }
  return {
    ...buildManagedKeylessOpenAIEnv({ stewardApiUrl: params.stewardApiUrl, env }),
    OPENAI_API_KEY: token,
  };
}

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

  if (shouldStripRawOpenAIForKeyless(env)) {
    if (!stewardContainerUrl) {
      throw new Error(
        "[managed-eliza-env] Steward API URL is required when keyless OpenAI fallback is disabled",
      );
    }
    delete environmentVars.OPENAI_API_KEY;
    Object.assign(
      environmentVars,
      buildManagedKeylessOpenAIEnv({ stewardApiUrl: stewardContainerUrl, env }),
    );
  }

  const changed = JSON.stringify(existingEnv) !== JSON.stringify(environmentVars);

  return {
    apiToken: environmentVars.ELIZA_API_TOKEN,
    changed,
    environmentVars,
    agentApiKey: sharedEnvironment.agentApiKey,
  };
}
