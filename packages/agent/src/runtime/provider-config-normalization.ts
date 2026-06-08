import {
  resolveElizaCloudTopology,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";

import type { ElizaConfig } from "../config/config.ts";

const DEFAULT_CEREBRAS_TEXT_MODEL = "gpt-oss-120b";

type MutableConfigEnv = Record<string, unknown> & {
  vars?: Record<string, unknown>;
};

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getMutableConfigEnv(
  config: ElizaConfig,
): MutableConfigEnv | undefined {
  const configEnv = config.env;
  if (!configEnv || typeof configEnv !== "object" || Array.isArray(configEnv)) {
    return undefined;
  }
  return configEnv as MutableConfigEnv;
}

function getMutableConfigEnvVars(
  configEnv: MutableConfigEnv | undefined,
): Record<string, unknown> | undefined {
  const vars = configEnv?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    return undefined;
  }
  return vars as Record<string, unknown>;
}

function readConfigEnvValue(
  config: ElizaConfig,
  key: string,
): string | undefined {
  const configEnv = getMutableConfigEnv(config);
  if (!configEnv) return undefined;
  const vars = getMutableConfigEnvVars(configEnv);
  return trimEnvString(vars?.[key]) ?? trimEnvString(configEnv[key]);
}

function readEffectiveEnvValue(
  config: ElizaConfig,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return trimEnvString(env[key]) ?? readConfigEnvValue(config, key);
}

function setConfigEnvValue(
  config: ElizaConfig,
  key: string,
  value: string,
): void {
  if (
    !config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env)
  ) {
    config.env = {};
  }
  const configEnv = config.env as MutableConfigEnv;
  const vars = getMutableConfigEnvVars(configEnv);
  if (vars) {
    vars[key] = value;
    delete configEnv[key];
    return;
  }
  configEnv[key] = value;
}

function isLikelyOpenAiOnlyTextModel(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("gpt-oss-")) return false;
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("openai/") ||
    normalized.startsWith("chatgpt-") ||
    /^o\d/.test(normalized)
  );
}

function normalizeCerebrasTextModel(value: unknown): string | undefined {
  const trimmed = trimEnvString(value);
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (
    normalized === "cerebras" ||
    normalized === "openai" ||
    normalized === "elizacloud" ||
    normalized === "cloud"
  ) {
    return undefined;
  }
  return isLikelyOpenAiOnlyTextModel(trimmed) ? undefined : trimmed;
}

function readCerebrasTextModel(
  config: ElizaConfig,
  key: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return normalizeCerebrasTextModel(readEffectiveEnvValue(config, key, env));
}

function isCerebrasBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.trim().toLowerCase();
    return hostname === "api.cerebras.ai" || hostname.endsWith(".cerebras.ai");
  } catch {
    return false;
  }
}

function setEffectiveConfigEnvValue(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
): void {
  env[key] = value;
  setConfigEnvValue(config, key, value);
}

/** @internal Exported for testing. */
export function normalizeDirectCerebrasProviderConfig(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cloudInferenceEnabled = resolveElizaCloudTopology(
    config as Record<string, unknown>,
  ).services.inference;
  if (cloudInferenceEnabled) {
    return false;
  }

  const routing = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  );
  const llmText = routing?.llmText;
  const backend = trimEnvString(llmText?.backend)?.toLowerCase();
  const transport = trimEnvString(llmText?.transport)?.toLowerCase();
  const routeWantsCerebras =
    backend === "cerebras" &&
    (!transport || transport === "direct" || transport === "remote");
  const providerHint =
    trimEnvString(
      readEffectiveEnvValue(config, "ELIZA_PROVIDER", env),
    )?.toLowerCase() === "cerebras";
  const openaiBaseUrl = readEffectiveEnvValue(config, "OPENAI_BASE_URL", env);
  const baseUrlWantsCerebras = isCerebrasBaseUrl(openaiBaseUrl);
  const hasCerebrasKey = Boolean(
    readEffectiveEnvValue(config, "CEREBRAS_API_KEY", env),
  );
  const hasOpenAiKey = Boolean(
    readEffectiveEnvValue(config, "OPENAI_API_KEY", env),
  );
  const keyWantsCerebras = hasCerebrasKey && !hasOpenAiKey && !openaiBaseUrl;

  if (
    !routeWantsCerebras &&
    !providerHint &&
    !baseUrlWantsCerebras &&
    !keyWantsCerebras
  ) {
    return false;
  }

  const models = (config as Record<string, unknown>).models as
    | {
        nano?: unknown;
        small?: unknown;
        medium?: unknown;
        large?: unknown;
        mega?: unknown;
      }
    | undefined;
  const routePrimary = normalizeCerebrasTextModel(llmText?.primaryModel);
  const configPrimary = normalizeCerebrasTextModel(
    config.agents?.defaults?.model?.primary,
  );
  const currentCerebrasModel = readCerebrasTextModel(
    config,
    "CEREBRAS_MODEL",
    env,
  );
  const fallbackPrimary =
    routePrimary ??
    currentCerebrasModel ??
    configPrimary ??
    normalizeCerebrasTextModel(models?.large) ??
    normalizeCerebrasTextModel(models?.small) ??
    DEFAULT_CEREBRAS_TEXT_MODEL;

  const smallModel =
    normalizeCerebrasTextModel(llmText?.smallModel) ??
    readCerebrasTextModel(config, "OPENAI_SMALL_MODEL", env) ??
    readCerebrasTextModel(config, "SMALL_MODEL", env) ??
    normalizeCerebrasTextModel(models?.small) ??
    fallbackPrimary;
  const largeModel =
    normalizeCerebrasTextModel(llmText?.largeModel) ??
    readCerebrasTextModel(config, "OPENAI_LARGE_MODEL", env) ??
    readCerebrasTextModel(config, "LARGE_MODEL", env) ??
    normalizeCerebrasTextModel(models?.large) ??
    fallbackPrimary;
  const baseUrl =
    readEffectiveEnvValue(config, "CEREBRAS_BASE_URL", env) ??
    "https://api.cerebras.ai/v1";

  setEffectiveConfigEnvValue(config, env, "ELIZA_PROVIDER", "cerebras");
  setEffectiveConfigEnvValue(config, env, "CEREBRAS_BASE_URL", baseUrl);
  setEffectiveConfigEnvValue(config, env, "CEREBRAS_MODEL", fallbackPrimary);
  setEffectiveConfigEnvValue(config, env, "OPENAI_SMALL_MODEL", smallModel);
  setEffectiveConfigEnvValue(config, env, "OPENAI_LARGE_MODEL", largeModel);

  return true;
}
