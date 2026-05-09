import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../../../../test/helpers/http.ts";
import { createLiveRuntimeChildEnv } from "../../../../test/helpers/live-child-env.ts";

export const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
export const LIVE_PROVIDER_OVERRIDE =
  process.env.ELIZA_LIVE_PROVIDER?.trim().toLowerCase() ?? "";
export const LIVE_CHAT_TEST_TIMEOUT_MS = 300_000;
export const LIVE_RUNTIME_BOOT_TIMEOUT_MS = 180_000;
/** Monorepo root. */
export const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const ENV_PATH = path.join(REPO_ROOT, ".env");
const LIVE_HTTP_REQUEST_TIMEOUT_MS = 120_000;
const LIVE_BOOT_HTTP_TIMEOUT_MS = 15_000;
const LIVE_CONVERSATION_REQUEST_TIMEOUT_MS = 45_000;
const LIVE_ENTITY_RESOLUTION_TIMEOUT_MS = 20_000;
const LIVE_ENTITY_RESOLUTION_RETRY_MS = 500;
const LIVE_TEST_LANGUAGE = process.env.ELIZA_LIVE_TEST_LANGUAGE?.trim() || "en";

try {
  const { config } = await import("dotenv");
  config({ path: ENV_PATH });
} catch {
  // dotenv is optional in this environment.
}

const LIVE_PROVIDER_CANDIDATES = [
  {
    name: "cerebras",
    plugin: "@elizaos/plugin-openai",
    keys: ["CEREBRAS_API_KEY", "ELIZA_E2E_CEREBRAS_API_KEY"],
  },
  {
    name: "openai",
    plugin: "@elizaos/plugin-openai",
    keys: ["OPENAI_API_KEY"],
  },
  {
    name: "openrouter",
    plugin: "@elizaos/plugin-openrouter",
    keys: ["OPENROUTER_API_KEY"],
  },
  {
    name: "google",
    plugin: "@elizaos/plugin-google-genai",
    keys: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    name: "anthropic",
    plugin: "@elizaos/plugin-anthropic",
    keys: ["ANTHROPIC_API_KEY"],
  },
  {
    name: "groq",
    plugin: "@elizaos/plugin-groq",
    keys: ["GROQ_API_KEY"],
  },
] as const;

export const LIVE_PROVIDER_ENV_KEYS = [
  "MILADY_PROVIDER",
  "CEREBRAS_API_KEY",
  "ELIZA_E2E_CEREBRAS_API_KEY",
  "CEREBRAS_SMALL_MODEL",
  "CEREBRAS_LARGE_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_SMALL_MODEL",
  "OPENROUTER_LARGE_MODEL",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_SMALL_MODEL",
  "GOOGLE_LARGE_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_SMALL_MODEL",
  "ANTHROPIC_LARGE_MODEL",
  "GROQ_API_KEY",
  "GROQ_SMALL_MODEL",
  "GROQ_LARGE_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
] as const;

const LIVE_PROVIDER_PLUGIN_NAMES = new Set(
  LIVE_PROVIDER_CANDIDATES.map((candidate) => candidate.plugin),
);
export const LIVE_CLOUD_ENV_PREFIXES = [
  "ELIZAOS_CLOUD_",
  "ELIZA_CLOUD_",
] as const;

const LIVE_PROVIDER_CHEAP_MODELS = {
  cerebras: {
    smallKey: "OPENAI_SMALL_MODEL",
    smallModel: "gpt-oss-120b",
    largeKey: "OPENAI_LARGE_MODEL",
    largeModel: "gpt-oss-120b",
  },
  anthropic: {
    smallKey: "ANTHROPIC_SMALL_MODEL",
    smallModel: "claude-haiku-4-5-20251001",
    largeKey: "ANTHROPIC_LARGE_MODEL",
    largeModel: "claude-haiku-4-5-20251001",
  },
  google: {
    smallKey: "GOOGLE_SMALL_MODEL",
    smallModel: "gemini-2.5-flash",
    largeKey: "GOOGLE_LARGE_MODEL",
    largeModel: "gemini-2.5-flash",
  },
  groq: {
    smallKey: "GROQ_SMALL_MODEL",
    smallModel: "llama-3.1-8b-instant",
    largeKey: "GROQ_LARGE_MODEL",
    largeModel: "llama-3.1-8b-instant",
  },
  openai: {
    smallKey: "OPENAI_SMALL_MODEL",
    smallModel: "gpt-5.4-mini",
    largeKey: "OPENAI_LARGE_MODEL",
    largeModel: "gpt-5.4-mini",
  },
  openrouter: {
    smallKey: "OPENROUTER_SMALL_MODEL",
    smallModel: "google/gemini-2.5-flash",
    largeKey: "OPENROUTER_LARGE_MODEL",
    largeModel: "google/gemini-2.5-flash",
  },
} as const;

export type LiveProviderName = keyof typeof LIVE_PROVIDER_CHEAP_MODELS;

export type SelectedLiveProvider = {
  name: LiveProviderName;
  env: Record<string, string>;
  plugin: string;
};

export type StartedLifeOpsLiveRuntime = {
  close: () => Promise<void>;
  getLogTail: () => string;
  port: number;
  providerName: LiveProviderName;
};

export type LifeOpsDefinitionEntry = {
  definition?: Record<string, unknown>;
  reminderPlan?: Record<string, unknown> | null;
};

export type LifeOpsGoalEntry = {
  goal?: Record<string, unknown>;
};

export type LifeOpsOverviewRecord = {
  occurrences?: Array<Record<string, unknown>>;
  reminders?: Array<Record<string, unknown>>;
  goals?: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  owner?: Record<string, unknown>;
  agentOps?: Record<string, unknown>;
};

const ELIZA_CLOUD_OPENAI_BASE_URL = "https://elizacloud.ai/api/v1";

function resolveLiveProviderModelEnv(
  providerName: LiveProviderName,
): Record<string, string> {
  const defaults = LIVE_PROVIDER_CHEAP_MODELS[providerName];
  const smallModel =
    process.env[defaults.smallKey]?.trim() || defaults.smallModel;
  const largeModel =
    process.env[defaults.largeKey]?.trim() ||
    process.env[defaults.smallKey]?.trim() ||
    defaults.largeModel;

  return {
    [defaults.smallKey]: smallModel,
    [defaults.largeKey]: largeModel,
    SMALL_MODEL: process.env.SMALL_MODEL?.trim() || smallModel,
    LARGE_MODEL: process.env.LARGE_MODEL?.trim() || largeModel,
  };
}

function resolveCerebrasModelEnv(): Record<string, string> {
  const smallModel =
    process.env.ELIZA_LIVE_TEST_SMALL_MODEL?.trim() ||
    process.env.CEREBRAS_SMALL_MODEL?.trim() ||
    "gpt-oss-120b";
  const largeModel =
    process.env.ELIZA_LIVE_TEST_LARGE_MODEL?.trim() ||
    process.env.CEREBRAS_LARGE_MODEL?.trim() ||
    smallModel;

  return {
    OPENAI_SMALL_MODEL: smallModel,
    OPENAI_LARGE_MODEL: largeModel,
    SMALL_MODEL: smallModel,
    LARGE_MODEL: largeModel,
  };
}

async function canImportLiveProviderPlugin(
  pluginName: string,
): Promise<boolean> {
  try {
    await import(pluginName);
    return true;
  } catch {
    return false;
  }
}

function detectOpenAiCompatibleBaseUrlProvider(
  baseUrl: string | undefined,
): "groq" | null {
  if (!baseUrl) {
    return null;
  }

  try {
    const hostname = new URL(baseUrl).hostname.trim().toLowerCase();
    if (hostname === "api.groq.com" || hostname.endsWith(".groq.com")) {
      return "groq";
    }
  } catch {
    return null;
  }

  return null;
}

function looksLikeGroqApiKey(value: string | undefined): boolean {
  return Boolean(value && /^gsk[-_]/i.test(value));
}

export async function selectLifeOpsLiveProvider(): Promise<SelectedLiveProvider | null> {
  const baseConfig = await loadBaseLiveConfig();
  const configuredCloudApiKey =
    baseConfig.cloud &&
    typeof baseConfig.cloud === "object" &&
    typeof (baseConfig.cloud as { apiKey?: unknown }).apiKey === "string"
      ? ((baseConfig.cloud as { apiKey?: string }).apiKey ?? "").trim()
      : "";
  const cerebrasApiKey =
    process.env.CEREBRAS_API_KEY?.trim() ||
    process.env.ELIZA_E2E_CEREBRAS_API_KEY?.trim() ||
    "";
  if (
    cerebrasApiKey &&
    (!LIVE_PROVIDER_OVERRIDE || LIVE_PROVIDER_OVERRIDE === "cerebras") &&
    (await canImportLiveProviderPlugin("@elizaos/plugin-openai"))
  ) {
    return {
      name: "cerebras",
      env: {
        CEREBRAS_API_KEY: cerebrasApiKey,
        OPENAI_API_KEY: cerebrasApiKey,
        OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
        MILADY_PROVIDER: "cerebras",
        ...resolveCerebrasModelEnv(),
      },
      plugin: "@elizaos/plugin-openai",
    };
  }

  const openAiCompatProvider = detectOpenAiCompatibleBaseUrlProvider(
    process.env.OPENAI_BASE_URL?.trim(),
  );
  if (
    openAiCompatProvider === "groq" &&
    (!LIVE_PROVIDER_OVERRIDE ||
      LIVE_PROVIDER_OVERRIDE === "openai" ||
      LIVE_PROVIDER_OVERRIDE === "groq") &&
    (await canImportLiveProviderPlugin("@elizaos/plugin-groq"))
  ) {
    const groqApiKey =
      process.env.GROQ_API_KEY?.trim() ||
      (looksLikeGroqApiKey(process.env.OPENAI_API_KEY?.trim())
        ? process.env.OPENAI_API_KEY?.trim()
        : "");
    if (groqApiKey) {
      return {
        name: "groq",
        env: {
          GROQ_API_KEY: groqApiKey,
          ...resolveLiveProviderModelEnv("groq"),
        },
        plugin: "@elizaos/plugin-groq",
      };
    }
  }

  const candidates =
    LIVE_PROVIDER_OVERRIDE.length > 0
      ? LIVE_PROVIDER_CANDIDATES.filter(
          (candidate) => candidate.name === LIVE_PROVIDER_OVERRIDE,
        )
      : LIVE_PROVIDER_CANDIDATES;

  for (const candidate of candidates) {
    const env: Record<string, string> = {};
    for (const key of candidate.keys) {
      const value = process.env[key]?.trim();
      if (value) {
        env[key] = value;
      }
    }

    if (Object.keys(env).length === 0) {
      continue;
    }

    if (!(await canImportLiveProviderPlugin(candidate.plugin))) {
      continue;
    }

    Object.assign(
      env,
      resolveLiveProviderModelEnv(candidate.name as LiveProviderName),
    );
    if (candidate.name === "cerebras") {
      const apiKey = env.CEREBRAS_API_KEY ?? env.ELIZA_E2E_CEREBRAS_API_KEY;
      env.CEREBRAS_API_KEY = apiKey;
      env.OPENAI_API_KEY = apiKey;
      env.OPENAI_BASE_URL = "https://api.cerebras.ai/v1";
      env.MILADY_PROVIDER = "cerebras";
      Object.assign(env, resolveCerebrasModelEnv());
    }
    if (candidate.name === "openai" && process.env.OPENAI_BASE_URL?.trim()) {
      env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL.trim();
    }

    return {
      name: candidate.name as LiveProviderName,
      env,
      plugin: candidate.plugin,
    };
  }

  if (
    configuredCloudApiKey &&
    (!LIVE_PROVIDER_OVERRIDE || LIVE_PROVIDER_OVERRIDE === "openai") &&
    (await canImportLiveProviderPlugin("@elizaos/plugin-openai"))
  ) {
    return {
      name: "openai",
      env: {
        OPENAI_API_KEY: configuredCloudApiKey,
        OPENAI_BASE_URL: ELIZA_CLOUD_OPENAI_BASE_URL,
        ...resolveLiveProviderModelEnv("openai"),
      },
      plugin: "@elizaos/plugin-openai",
    };
  }

  return null;
}

export function getLifeOpsLiveSetupWarnings(
  selectedProvider: SelectedLiveProvider | null,
): string[] {
  return [
    !LIVE_TESTS_ENABLED ? "set ELIZA_LIVE_TEST=1" : null,
    !selectedProvider
      ? "provide a live provider key such as CEREBRAS_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY, or configure cloud.apiKey in the Eliza config"
      : null,
  ].filter((entry): entry is string => Boolean(entry));
}

export function applyLocalEmbeddingDefaults(
  env: Record<string, string | undefined>,
): void {
  delete env.ELIZA_DISABLE_LOCAL_EMBEDDINGS;

  if (!env.LOCAL_EMBEDDING_DIMENSIONS?.trim()) {
    env.LOCAL_EMBEDDING_DIMENSIONS = "384";
  }
  if (!env.EMBEDDING_DIMENSION?.trim()) {
    env.EMBEDDING_DIMENSION = "384";
  }
}

export function getSelectedLiveProviderEnv(
  selectedProvider: SelectedLiveProvider | null,
  options?: { omitOpenAiBaseUrl?: boolean },
): Record<string, string> {
  if (!selectedProvider) {
    return {};
  }

  const env = Object.fromEntries(
    Object.entries(selectedProvider.env).filter(
      ([, value]) => value.trim().length > 0,
    ),
  ) as Record<string, string>;

  if (options?.omitOpenAiBaseUrl && selectedProvider.name === "openai") {
    delete env.OPENAI_BASE_URL;
  }

  return env;
}

export function buildSelectedLiveProviderEnv(
  selectedProvider: SelectedLiveProvider,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(
      ([key, value]) =>
        typeof value === "string" &&
        !LIVE_CLOUD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        !LIVE_PROVIDER_ENV_KEYS.includes(
          key as (typeof LIVE_PROVIDER_ENV_KEYS)[number],
        ),
    ),
  ) as Record<string, string>;

  applyLocalEmbeddingDefaults(env);
  Object.assign(env, getSelectedLiveProviderEnv(selectedProvider));
  return env;
}

async function loadBaseLiveConfig(): Promise<Record<string, unknown>> {
  const configuredPath =
    process.env.ELIZA_CONFIG_PATH?.trim() ||
    path.join(os.homedir(), ".eliza", "eliza.json");

  try {
    const raw = await readFile(configuredPath, "utf8");
    const { default: JSON5 } = await import("json5");
    const parsed = JSON5.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode != null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const handleExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("close", handleExit);
    };

    child.once("exit", handleExit);
    child.once("close", handleExit);
  });
}

export async function waitForJsonPredicate<T>(
  url: string,
  predicate: (value: T) => boolean,
  timeoutMs: number = LIVE_RUNTIME_BOOT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(LIVE_BOOT_HTTP_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)),
      );
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${url}`);
      }

      const data = (await response.json()) as T;
      if (predicate(data)) {
        return data;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(1_000);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

async function waitForLiveRuntimeBootstrap(
  port: number,
  timeoutMs: number = LIVE_RUNTIME_BOOT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const conversation = await createConversation(
        port,
        {
          title: `Live LifeOps Bootstrap ${Date.now()}`,
        },
        undefined,
        { timeoutMs: LIVE_BOOT_HTTP_TIMEOUT_MS },
      );
      if (conversation.conversationId) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(2_000);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for the live runtime bootstrap");
}

export async function startLifeOpsLiveRuntime(options?: {
  bootTimeoutMs?: number;
  selectedProvider?: SelectedLiveProvider | null;
}): Promise<StartedLifeOpsLiveRuntime> {
  const selectedProvider =
    options?.selectedProvider ?? (await selectLifeOpsLiveProvider());

  if (!selectedProvider) {
    throw new Error(
      "No live provider was configured. Set ELIZA_LIVE_PROVIDER or provide a supported provider API key.",
    );
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-lifeops-live-"));
  const stateDir = path.join(tempRoot, "state");
  const pgliteDir = path.join(tempRoot, "pglite");
  const configPath = path.join(tempRoot, "eliza.json");
  const apiPort = await getFreePort();
  const logs: string[] = [];
  const baseConfig = await loadBaseLiveConfig();
  const basePlugins =
    baseConfig.plugins &&
    typeof baseConfig.plugins === "object" &&
    Array.isArray((baseConfig.plugins as { allow?: unknown }).allow)
      ? ((baseConfig.plugins as { allow?: unknown }).allow as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
  const basePluginsWithoutProviders = basePlugins.filter(
    (entry) => !LIVE_PROVIDER_PLUGIN_NAMES.has(entry),
  );
  const assistantConfig =
    baseConfig.ui &&
    typeof baseConfig.ui === "object" &&
    (baseConfig.ui as { assistant?: unknown }).assistant &&
    typeof (baseConfig.ui as { assistant?: unknown }).assistant === "object"
      ? ((baseConfig.ui as { assistant?: unknown }).assistant as Record<
          string,
          unknown
        >)
      : {};
  const baseUi =
    baseConfig.ui && typeof baseConfig.ui === "object"
      ? (baseConfig.ui as Record<string, unknown>)
      : {};
  const baseServiceRouting =
    baseConfig.serviceRouting && typeof baseConfig.serviceRouting === "object"
      ? (baseConfig.serviceRouting as Record<string, unknown>)
      : {};
  const llmTextRouting =
    baseServiceRouting.llmText && typeof baseServiceRouting.llmText === "object"
      ? (baseServiceRouting.llmText as Record<string, unknown>)
      : {};
  const embeddingsRouting =
    baseServiceRouting.embeddings &&
    typeof baseServiceRouting.embeddings === "object"
      ? (baseServiceRouting.embeddings as Record<string, unknown>)
      : {};
  const baseCloud =
    baseConfig.cloud && typeof baseConfig.cloud === "object"
      ? (baseConfig.cloud as Record<string, unknown>)
      : {};

  await mkdir(stateDir, { recursive: true });
  await mkdir(pgliteDir, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...baseConfig,
        logging: { level: "info" },
        ui: {
          ...baseUi,
          language: LIVE_TEST_LANGUAGE,
          assistant: {
            ...assistantConfig,
            name:
              typeof assistantConfig.name === "string" &&
              assistantConfig.name.trim().length > 0
                ? assistantConfig.name
                : "Eliza",
          },
        },
        plugins: {
          ...(baseConfig.plugins && typeof baseConfig.plugins === "object"
            ? (baseConfig.plugins as Record<string, unknown>)
            : {}),
          allow: [
            ...new Set(
              [...basePluginsWithoutProviders, selectedProvider.plugin].filter(
                (entry): entry is string => typeof entry === "string",
              ),
            ),
          ],
        },
        serviceRouting: {
          ...baseServiceRouting,
          llmText: {
            ...llmTextRouting,
            backend: selectedProvider.name,
            transport: "direct",
          },
          embeddings: {
            ...embeddingsRouting,
            backend: "local",
            transport: "direct",
          },
        },
        cloud: {
          ...baseCloud,
          enabled: false,
          inferenceMode: "local",
          services: {
            inference: false,
            tts: false,
            media: false,
            embeddings: false,
            rpc: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const child = spawn("bun", ["run", "start:eliza"], {
    cwd: REPO_ROOT,
    env: createLiveRuntimeChildEnv({
      ...buildSelectedLiveProviderEnv(selectedProvider),
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      PGLITE_DATA_DIR: pgliteDir,
      ELIZA_PORT: String(apiPort),
      ELIZA_API_PORT: String(apiPort),
      ENABLE_AUTONOMY: "false",
      ELIZA_DISABLE_PROACTIVE_AGENT: "1",
      ALLOW_NO_DATABASE: "",
      DISCORD_API_TOKEN: "",
      DISCORD_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => logs.push(chunk));
  child.stderr.on("data", (chunk: string) => logs.push(chunk));

  const bootTimeoutMs = options?.bootTimeoutMs ?? LIVE_RUNTIME_BOOT_TIMEOUT_MS;

  try {
    await waitForJsonPredicate<{ ready?: boolean; runtime?: string }>(
      `http://127.0.0.1:${apiPort}/api/health`,
      (value) => value.ready === true && value.runtime === "ok",
      bootTimeoutMs,
    );
    await waitForJsonPredicate<{ trajectories?: unknown[] }>(
      `http://127.0.0.1:${apiPort}/api/trajectories?limit=1`,
      (value) => Array.isArray(value.trajectories),
      bootTimeoutMs,
    );
    await waitForJsonPredicate<{
      occurrences?: unknown[];
      summary?: Record<string, unknown>;
    }>(
      `http://127.0.0.1:${apiPort}/api/lifeops/overview`,
      (value) =>
        Array.isArray(value.occurrences) &&
        !!value.summary &&
        typeof value.summary === "object",
      bootTimeoutMs,
    );
    await waitForLiveRuntimeBootstrap(apiPort, bootTimeoutMs);
  } catch (error) {
    const logTail = logs.join("").slice(-8_000);
    if (child.exitCode == null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 5_000);
    }
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(
      `Live runtime failed to start: ${error instanceof Error ? error.message : String(error)}\n${logTail}`,
    );
  }

  return {
    port: apiPort,
    providerName: selectedProvider.name,
    getLogTail: () => logs.join("").slice(-8_000),
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        const exited = await waitForChildExit(child, 10_000);
        if (!exited && child.exitCode == null) {
          child.kill("SIGKILL");
          await waitForChildExit(child, 5_000);
        }
      }
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeLiveText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

async function postLiveConversationMessageWithAttempts(
  runtime: StartedLifeOpsLiveRuntime,
  conversationId: string,
  text: string,
  turnName: string,
  options: {
    attempts: number;
    retryDelayMs?: number;
    source?: string;
  },
): Promise<string> {
  let lastError: unknown = null;
  const retryDelayMs = options.retryDelayMs ?? 2_000;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const response = await postConversationMessage(
        runtime.port,
        conversationId,
        {
          text,
          mode: "power",
          ...(options.source ? { source: options.source } : {}),
        },
        undefined,
        { timeoutMs: LIVE_CONVERSATION_REQUEST_TIMEOUT_MS },
      );
      const responseText = String(response.data.text ?? "");

      if (response.status === 200 && !/provider issue/i.test(responseText)) {
        return responseText;
      }

      lastError =
        response.status === 200
          ? new Error(
              `${turnName} returned a provider issue reply on attempt ${attempt}\n${runtime.getLogTail()}`,
            )
          : new Error(
              `${turnName} failed with status ${response.status} on attempt ${attempt}\n${runtime.getLogTail()}`,
            );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lastError = new Error(
        `${turnName} request failed on attempt ${attempt}: ${detail}\n${runtime.getLogTail()}`,
      );
    }

    if (attempt < options.attempts) {
      await sleep(retryDelayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${turnName} failed after ${options.attempts} attempts`);
}

export async function postLiveConversationMessage(
  runtime: StartedLifeOpsLiveRuntime,
  conversationId: string,
  text: string,
  turnName: string,
  source?: string,
): Promise<string> {
  return await postLiveConversationMessageWithAttempts(
    runtime,
    conversationId,
    text,
    turnName,
    {
      attempts: 1,
      source,
    },
  );
}

export async function postLiveConversationMessageWithRecovery(
  runtime: StartedLifeOpsLiveRuntime,
  conversationId: string,
  text: string,
  turnName: string,
  options?: {
    attempts?: number;
    retryDelayMs?: number;
    source?: string;
  },
): Promise<string> {
  return await postLiveConversationMessageWithAttempts(
    runtime,
    conversationId,
    text,
    turnName,
    {
      attempts: options?.attempts ?? 3,
      retryDelayMs: options?.retryDelayMs,
      source: options?.source,
    },
  );
}

export function assertNoProviderIssue(
  turnName: string,
  text: string,
  runtime: StartedLifeOpsLiveRuntime,
): void {
  if (!/provider issue/i.test(text)) {
    return;
  }

  throw new Error(
    `${turnName} returned a provider issue reply.\nresponse=${text}\n${runtime.getLogTail()}`,
  );
}

export async function waitForTrajectoryCall(
  port: number,
  expectedUserPrompt: string,
  timeoutMs: number = 120_000,
): Promise<{
  trajectoryId: string;
  llmCall: {
    systemPrompt?: string;
    userPrompt?: string;
    response?: string;
  };
}> {
  const deadline = Date.now() + timeoutMs;
  const normalizedCandidates = [
    expectedUserPrompt,
    ...Array.from(
      expectedUserPrompt.matchAll(/"([^"]{4,})"/g),
      (match) => match[1] ?? "",
    ),
    ...expectedUserPrompt
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 12),
  ]
    .map((candidate) => normalizePromptText(candidate))
    .filter(
      (candidate, index, all) =>
        candidate.length > 0 && all.indexOf(candidate) === index,
    );

  while (Date.now() < deadline) {
    const trajectoryMap = new Map<string, { id?: string }>();
    const searchQueries = normalizedCandidates.slice(0, 4);

    for (const searchQuery of searchQueries) {
      const list = await req(
        port,
        "GET",
        `/api/trajectories?limit=100&search=${encodeURIComponent(searchQuery)}`,
        undefined,
        undefined,
        { timeoutMs: LIVE_HTTP_REQUEST_TIMEOUT_MS },
      );
      const trajectories = Array.isArray(list.data.trajectories)
        ? (list.data.trajectories as Array<{ id?: string }>)
        : [];
      for (const trajectory of trajectories) {
        const trajectoryId = String(trajectory.id ?? "");
        if (trajectoryId) {
          trajectoryMap.set(trajectoryId, trajectory);
        }
      }
    }

    if (trajectoryMap.size === 0) {
      const list = await req(
        port,
        "GET",
        "/api/trajectories?limit=100",
        undefined,
        undefined,
        { timeoutMs: LIVE_HTTP_REQUEST_TIMEOUT_MS },
      );
      const trajectories = Array.isArray(list.data.trajectories)
        ? (list.data.trajectories as Array<{ id?: string }>)
        : [];
      for (const trajectory of trajectories) {
        const trajectoryId = String(trajectory.id ?? "");
        if (trajectoryId) {
          trajectoryMap.set(trajectoryId, trajectory);
        }
      }
    }

    for (const trajectory of trajectoryMap.values()) {
      const trajectoryId = String(trajectory.id ?? "");
      if (!trajectoryId) continue;

      const detail = await req(
        port,
        "GET",
        `/api/trajectories/${encodeURIComponent(trajectoryId)}`,
        undefined,
        undefined,
        { timeoutMs: LIVE_HTTP_REQUEST_TIMEOUT_MS },
      );
      const llmCalls = Array.isArray(detail.data.llmCalls)
        ? (detail.data.llmCalls as Array<{
            systemPrompt?: string;
            userPrompt?: string;
            response?: string;
          }>)
        : [];

      const match = llmCalls.find((call) => {
        const normalizedActual = normalizePromptText(
          String(call.userPrompt ?? ""),
        );
        return (
          normalizedActual.length > 0 &&
          normalizedCandidates.some(
            (normalizedCandidate) =>
              normalizedActual === normalizedCandidate ||
              normalizedActual.includes(normalizedCandidate) ||
              normalizedCandidate.includes(normalizedActual),
          )
        );
      });

      if (match) {
        return { trajectoryId, llmCall: match };
      }
    }

    await sleep(1_000);
  }

  throw new Error(
    `Timed out waiting for a live LifeOps trajectory for prompt=${expectedUserPrompt}`,
  );
}

export async function listDefinitionEntries(
  port: number,
): Promise<LifeOpsDefinitionEntry[]> {
  const response = await req(
    port,
    "GET",
    "/api/lifeops/definitions",
    undefined,
    undefined,
    { timeoutMs: LIVE_HTTP_REQUEST_TIMEOUT_MS },
  );
  if (response.status !== 200) {
    throw new Error(
      `Failed to load LifeOps definitions (${response.status}): ${JSON.stringify(response.data)}`,
    );
  }
  return Array.isArray(response.data.definitions)
    ? (response.data.definitions as LifeOpsDefinitionEntry[])
    : [];
}

export async function listGoalEntries(
  port: number,
): Promise<LifeOpsGoalEntry[]> {
  const response = await req(
    port,
    "GET",
    "/api/lifeops/goals",
    undefined,
    undefined,
    { timeoutMs: LIVE_HTTP_REQUEST_TIMEOUT_MS },
  );
  if (response.status !== 200) {
    throw new Error(
      `Failed to load LifeOps goals (${response.status}): ${JSON.stringify(response.data)}`,
    );
  }
  return Array.isArray(response.data.goals)
    ? (response.data.goals as LifeOpsGoalEntry[])
    : [];
}

export async function getLifeOpsOverview(
  port: number,
): Promise<LifeOpsOverviewRecord> {
  const response = await req(
    port,
    "GET",
    "/api/lifeops/overview",
    undefined,
    undefined,
    { timeoutMs: LIVE_HTTP_REQUEST_TIMEOUT_MS },
  );
  if (response.status !== 200) {
    throw new Error(
      `Failed to load LifeOps overview (${response.status}): ${JSON.stringify(response.data)}`,
    );
  }
  return response.data as LifeOpsOverviewRecord;
}

export async function resolveDefinitionIdByTitle(
  port: number,
  title: string,
): Promise<string> {
  const normalizedTitle = normalizeLiveText(title);
  const deadline = Date.now() + LIVE_ENTITY_RESOLUTION_TIMEOUT_MS;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const definitions = await listDefinitionEntries(port);
      const match = definitions.find(
        (entry) =>
          normalizeLiveText(String(entry.definition?.title ?? "")) ===
          normalizedTitle,
      );
      const definitionId = String(match?.definition?.id ?? "");
      if (definitionId) {
        return definitionId;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(LIVE_ENTITY_RESOLUTION_RETRY_MS);
  }

  throw new Error(
    `Could not resolve LifeOps definition id for title "${title}"${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

export async function resolveOccurrenceIdByTitle(
  port: number,
  title: string,
): Promise<string> {
  const normalizedTitle = normalizeLiveText(title);
  const deadline = Date.now() + LIVE_ENTITY_RESOLUTION_TIMEOUT_MS;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const overview = await getLifeOpsOverview(port);
      const occurrences = Array.isArray(overview.occurrences)
        ? overview.occurrences
        : [];
      const match = occurrences.find(
        (entry) =>
          normalizeLiveText(String(entry.title ?? "")) === normalizedTitle,
      );
      const occurrenceId = String(match?.id ?? "");
      if (occurrenceId) {
        return occurrenceId;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(LIVE_ENTITY_RESOLUTION_RETRY_MS);
  }

  throw new Error(
    `Could not resolve LifeOps occurrence id for title "${title}"${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

export async function waitForDefinitionByTitle(
  port: number,
  title: string,
  predicate?: (entry: LifeOpsDefinitionEntry) => boolean,
): Promise<LifeOpsDefinitionEntry> {
  const response = await waitForJsonPredicate<{
    definitions?: LifeOpsDefinitionEntry[];
  }>(
    `http://127.0.0.1:${port}/api/lifeops/definitions`,
    (value) =>
      Array.isArray(value.definitions) &&
      value.definitions.some(
        (entry) =>
          entry.definition?.title === title && (predicate?.(entry) ?? true),
      ),
  );

  const match = response.definitions?.find(
    (entry) =>
      entry.definition?.title === title && (predicate?.(entry) ?? true),
  );
  if (!match) {
    throw new Error(`Timed out waiting for ${title} definition`);
  }
  return match;
}

export async function waitForGoalByTitle(
  port: number,
  title: string,
  predicate?: (entry: LifeOpsGoalEntry) => boolean,
): Promise<LifeOpsGoalEntry> {
  const response = await waitForJsonPredicate<{
    goals?: LifeOpsGoalEntry[];
  }>(
    `http://127.0.0.1:${port}/api/lifeops/goals`,
    (value) =>
      Array.isArray(value.goals) &&
      value.goals.some(
        (entry) => entry.goal?.title === title && (predicate?.(entry) ?? true),
      ),
  );

  const match = response.goals?.find(
    (entry) => entry.goal?.title === title && (predicate?.(entry) ?? true),
  );
  if (!match) {
    throw new Error(`Timed out waiting for ${title} goal`);
  }
  return match;
}

export async function getReminderPreference(
  port: number,
  definitionId: string,
): Promise<Record<string, unknown>> {
  const response = await req(
    port,
    "GET",
    `/api/lifeops/reminder-preferences?definitionId=${encodeURIComponent(definitionId)}`,
    undefined,
    undefined,
    { timeoutMs: LIVE_HTTP_REQUEST_TIMEOUT_MS },
  );
  if (response.status !== 200) {
    throw new Error(
      `Failed to load reminder preference for ${definitionId}: ${JSON.stringify(response.data)}`,
    );
  }
  return response.data;
}
