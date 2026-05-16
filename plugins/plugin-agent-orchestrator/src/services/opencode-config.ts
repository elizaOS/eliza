import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.js";

const ELIZA_CLOUD_OPENAI_BASE = "https://www.elizacloud.ai/api/v1";
const OPENCODE_LOCAL_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OPENCODE_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const OPENCODE_CEREBRAS_NPM = "@ai-sdk/cerebras";
const CEREBRAS_DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_DEFAULT_MODEL = "gpt-oss-120b";

type RuntimeLike = Pick<IAgentRuntime, "getSetting">;

export interface OpencodeSpawnConfig {
  configContent: string;
  providerLabel: string;
  providerId: string;
  model: string;
  smallModel?: string;
}

export interface OpencodeAcpEnvResult {
  env: Record<string, string>;
  config?: OpencodeSpawnConfig;
  vendoredShimDir?: string;
}

function runtimeSetting(
  runtime: RuntimeLike | undefined,
  key: string,
): string | undefined {
  const value = runtime?.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function setting(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  const fromRuntime = runtimeSetting(runtime, key);
  if (fromRuntime) return fromRuntime;
  const fromEnv = env?.[key];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  if (env && env !== process.env) return undefined;
  const fromConfig = readConfigEnvKey(key);
  return fromConfig?.trim() || undefined;
}

function providerConfig(
  providerId: string,
  name: string,
  npm: string,
  baseURL: string,
  apiKey: string | undefined,
  powerful: string,
  fast: string | undefined,
): OpencodeSpawnConfig {
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm,
        name,
        options: { baseURL, ...(apiKey ? { apiKey } : {}) },
        models: {
          [powerful]: { name: powerful },
          ...(fast && fast !== powerful ? { [fast]: { name: fast } } : {}),
        },
      },
    },
    model: `${providerId}/${powerful}`,
    ...(fast && fast !== powerful
      ? { small_model: `${providerId}/${fast}` }
      : {}),
  };
  return {
    configContent: JSON.stringify(config),
    providerLabel: name,
    providerId,
    model: `${providerId}/${powerful}`,
    smallModel: fast && fast !== powerful ? `${providerId}/${fast}` : undefined,
  };
}

function isCerebrasBaseUrl(value: string | undefined): boolean {
  return Boolean(value && /(^|[/.])cerebras\.ai(?:\/|$)/i.test(value));
}

function usableApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("vault://")) return undefined;
  return value;
}

export function buildOpencodeSpawnConfig(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  overrideModel?: string,
): OpencodeSpawnConfig | null {
  const llmProvider =
    setting(runtime, env, "ELIZA_LLM_PROVIDER") || "subscription";
  const customBaseUrl = setting(runtime, env, "ELIZA_OPENCODE_BASE_URL");
  const cerebrasBaseUrl =
    setting(runtime, env, "CEREBRAS_BASE_URL") || CEREBRAS_DEFAULT_BASE_URL;
  const localOptIn = ["1", "true"].includes(
    (setting(runtime, env, "ELIZA_OPENCODE_LOCAL") ?? "").toLowerCase(),
  );
  const powerful =
    overrideModel?.trim() ||
    setting(runtime, env, "ELIZA_OPENCODE_MODEL_POWERFUL") ||
    setting(runtime, env, "OPENCODE_MODEL");
  const fast = setting(runtime, env, "ELIZA_OPENCODE_MODEL_FAST");

  if (llmProvider === "cloud") {
    const cloudKey = readConfigCloudKey("apiKey");
    if (!cloudKey) return null;
    return providerConfig(
      "elizacloud",
      "Eliza Cloud",
      OPENCODE_OPENAI_COMPATIBLE_NPM,
      ELIZA_CLOUD_OPENAI_BASE,
      cloudKey,
      powerful || "claude-opus-4-7",
      fast || "claude-haiku-4-5",
    );
  }

  const opencodeApiKey = usableApiKey(
    setting(runtime, env, "ELIZA_OPENCODE_API_KEY"),
  );
  const cerebrasApiKey =
    usableApiKey(setting(runtime, env, "CEREBRAS_API_KEY")) ||
    usableApiKey(setting(runtime, env, "ELIZA_E2E_CEREBRAS_API_KEY"));
  const wantsCerebras =
    isCerebrasBaseUrl(customBaseUrl) ||
    Boolean(cerebrasApiKey) ||
    (!customBaseUrl &&
      !localOptIn &&
      Boolean(opencodeApiKey) &&
      isCerebrasBaseUrl(cerebrasBaseUrl));
  if (wantsCerebras && (opencodeApiKey || cerebrasApiKey || customBaseUrl)) {
    return providerConfig(
      "cerebras",
      "Cerebras",
      OPENCODE_CEREBRAS_NPM,
      customBaseUrl || cerebrasBaseUrl,
      opencodeApiKey || cerebrasApiKey,
      powerful ||
        setting(runtime, env, "CEREBRAS_MODEL") ||
        CEREBRAS_DEFAULT_MODEL,
      fast,
    );
  }

  if (localOptIn || customBaseUrl) {
    return providerConfig(
      "eliza-local",
      "Local model",
      OPENCODE_OPENAI_COMPATIBLE_NPM,
      customBaseUrl || OPENCODE_LOCAL_DEFAULT_BASE_URL,
      opencodeApiKey,
      powerful || "eliza-1-4b",
      fast,
    );
  }

  if (!powerful) return null;
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model: powerful,
    ...(fast ? { small_model: fast } : {}),
  };
  return {
    configContent: JSON.stringify(config),
    providerLabel: "User-configured opencode.json",
    providerId: "user",
    model: powerful,
    smallModel: fast,
  };
}

function parentDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(start);
  while (!dirs.includes(current)) {
    dirs.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return dirs;
}

function candidateRoots(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return Array.from(
    new Set([...parentDirs(process.cwd()), ...parentDirs(moduleDir)]),
  );
}

export function resolveVendoredOpencodeShim(): string | undefined {
  const executable = process.platform === "win32" ? "opencode.cmd" : "opencode";
  for (const root of candidateRoots()) {
    const shim = path.join(
      root,
      "plugins",
      "plugin-agent-orchestrator",
      "bin",
      executable,
    );
    const sourceEntry = path.join(
      root,
      "plugins",
      "plugin-agent-orchestrator",
      "vendor",
      "opencode",
      "packages",
      "opencode",
      "src",
      "index.ts",
    );
    if (existsSync(shim) && existsSync(sourceEntry)) {
      return path.dirname(shim);
    }
  }
  return undefined;
}

function commandArg(value: string): string {
  return /^[A-Za-z0-9_/:.=+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function resolveVendoredOpencodeAcpCommand(): string | undefined {
  const shimDir = resolveVendoredOpencodeShim();
  if (!shimDir) return undefined;
  const executable = process.platform === "win32" ? "opencode.cmd" : "opencode";
  return `${commandArg(path.join(shimDir, executable))} acp`;
}

export function prependPathDir(
  currentPath: string | undefined,
  dir: string,
): string {
  const parts = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  return [
    dir,
    ...parts.filter((part) => path.resolve(part) !== path.resolve(dir)),
  ].join(path.delimiter);
}

export function buildOpencodeAcpEnv(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  model?: string,
): OpencodeAcpEnvResult {
  const next: Record<string, string> = {};
  const vendoredShimDir = resolveVendoredOpencodeShim();
  if (vendoredShimDir) {
    next.PATH = prependPathDir(env.PATH, vendoredShimDir);
  }

  const config =
    typeof env.OPENCODE_CONFIG_CONTENT === "string" &&
    env.OPENCODE_CONFIG_CONTENT.trim()
      ? undefined
      : (buildOpencodeSpawnConfig(runtime, env, model) ?? undefined);
  if (config) {
    next.OPENCODE_CONFIG_CONTENT = config.configContent;
    next.OPENCODE_MODEL = config.model;
    if (config.smallModel) next.OPENCODE_SMALL_MODEL = config.smallModel;
  }

  next.OPENCODE_DISABLE_AUTOUPDATE =
    typeof env.OPENCODE_DISABLE_AUTOUPDATE === "string"
      ? env.OPENCODE_DISABLE_AUTOUPDATE
      : "1";
  next.OPENCODE_DISABLE_TERMINAL_TITLE =
    typeof env.OPENCODE_DISABLE_TERMINAL_TITLE === "string"
      ? env.OPENCODE_DISABLE_TERMINAL_TITLE
      : "1";

  return { env: next, config, vendoredShimDir };
}
