import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/core";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.js";
import { resolveModelGatewayConfig } from "./model-gateway.js";

const ELIZA_CLOUD_OPENAI_BASE = "https://elizacloud.ai/api/v1";
const OPENCODE_LOCAL_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OPENCODE_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const OPENCODE_CEREBRAS_NPM = "@ai-sdk/cerebras";
const CEREBRAS_DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_DEFAULT_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;

// `webfetch` is a read-only HTTP GET (opencode caps the response at 5MB and
// never mutates the workspace). `websearch` is opencode's general web-search
// tool — a read-only query against the keyless Parallel.ai / Exa MCP search
// endpoints (no PARALLEL_API_KEY required; the tool sends only a User-Agent
// when none is set). opencode defaults BOTH permissions to "ask", so under the
// acpx "standard" approval preset (which answers non-interactive permission
// prompts with "deny") a spawned sub-agent's fetch AND search are silently
// denied — and the model, unable to reach the network, either confabulates an
// answer or falls back to `webfetch` on a guessed search URL (e.g.
// google.com/search), which datacenter IPs get bot-blocked from ("trouble
// accessing Google Search"). Allowing both read-only capabilities lets
// sub-agents do real general web search + live fetches on any provider without
// granting write/exec (`bash`, `edit`) permissions, which stay gated by the
// preset.
//
// SECURITY: read-only does not mean safe-target. opencode's own SSRF guard is
// what blocks fetches to loopback, private ranges, and cloud metadata
// (169.254.169.254). This grant assumes that guard is deployed in the bundled
// opencode build; without it a spawned sub-agent can reach internal endpoints.
const OPENCODE_SPAWN_PERMISSION = {
  webfetch: "allow",
  websearch: "allow",
} as const;

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
    permission: OPENCODE_SPAWN_PERMISSION,
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
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "cerebras.ai" || hostname.endsWith(".cerebras.ai");
  } catch {
    return false;
  }
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

  // Gateway mode (#11536 E2) — checked BEFORE any provider-credential read so
  // no raw key (env, runtime settings, or config-env; `setting()` falls back
  // to all three) can be embedded into OPENCODE_CONFIG_CONTENT, and the
  // opencode child cannot bypass the gateway by talking to Cerebras / Eliza
  // Cloud / a custom base URL directly. Provider auto-detection and custom
  // base URLs are deliberately ignored here: gateway mode centralizes egress.
  // Model names pass through unchanged (the gateway routes by model name),
  // defaulting to the same chain the direct cerebras-api path uses, so
  // flipping the gateway on changes transport + credentials, never the model.
  const gateway = resolveModelGatewayConfig();
  if (gateway) {
    return providerConfig(
      "eliza-gateway",
      "Eliza Model Gateway",
      OPENCODE_OPENAI_COMPATIBLE_NPM,
      gateway.url,
      gateway.token,
      powerful ||
        setting(runtime, env, "CEREBRAS_MODEL") ||
        CEREBRAS_DEFAULT_MODEL,
      fast,
    );
  }

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
    permission: OPENCODE_SPAWN_PERMISSION,
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
    if (existsSync(shim)) {
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

  const config = buildOpencodeSpawnConfig(runtime, env, model) ?? undefined;
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
