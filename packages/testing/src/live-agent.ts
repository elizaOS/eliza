/**
 * Builds provider-backed AgentRuntime fixtures for live model and action tests.
 * Callers own domain records and assistant composition; this helper supplies
 * isolated storage, provider settings, credential gates and runtime teardown.
 */

import { randomUUID } from "node:crypto";
import {
  AgentRuntime,
  type Character,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/host/protocol";
import { afterAll, beforeAll, describe, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./sqlite-adapter.ts";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
export type LiveProviderId = "openai" | "anthropic" | "elizacloud" | "cerebras";
export interface LiveAgentTestOptions {
  /** Required env vars. If any is missing, the suite skips with a warning. */
  requiredEnv: string[];
  /** Provider plugin id (e.g. "openai"). Defaults to "openai" + Cerebras. */
  provider?: LiveProviderId;
  /** Character system prompt override. */
  systemPrompt?: string;
  /** Plugins to load in addition to the provider plugin. Workspace path or bare specifier. */
  extraPlugins?: Array<
    | string
    | {
        path: string;
        name?: string;
      }
  >;
}
export interface LiveAgentHarness {
  agentId: string;
  runtime: AgentRuntime;
  /** Stop the runtime and clean up. */
  close(): Promise<void>;
}
const DEFAULT_SYSTEM_PROMPT =
  "Concise, helpful assistant for end-to-end testing. " +
  "Always respond in plain text. Keep answers short (1-3 sentences) unless asked otherwise.";
interface ProviderConfig {
  bareSpecifier: string;
  pluginExportNames: string[];
  defaultRequiredEnv: string[];
}
const PROVIDER_CONFIG: Record<LiveProviderId, ProviderConfig> = {
  openai: {
    bareSpecifier: "@elizaos/plugin-openai",
    pluginExportNames: ["openaiPlugin", "default"],
    defaultRequiredEnv: ["OPENAI_API_KEY"],
  },
  anthropic: {
    bareSpecifier: "@elizaos/plugin-anthropic",
    pluginExportNames: ["anthropicPlugin", "default"],
    defaultRequiredEnv: ["ANTHROPIC_API_KEY"],
  },
  elizacloud: {
    bareSpecifier: "@elizaos/plugin-elizacloud",
    pluginExportNames: ["elizaOSCloudPlugin", "default"],
    defaultRequiredEnv: ["ELIZAOS_CLOUD_API_KEY"],
  },
  // Cerebras is an alias for the openai plugin pre-configured to talk to
  // the Cerebras OpenAI-compatible endpoint. Useful for tests that explicitly
  // want Cerebras even when OPENAI_API_KEY is set to a real OpenAI key.
  cerebras: {
    bareSpecifier: "@elizaos/plugin-openai",
    pluginExportNames: ["openaiPlugin", "default"],
    defaultRequiredEnv: ["CEREBRAS_API_KEY"],
  },
};
async function resolveProviderPlugin(
  provider: LiveProviderId,
): Promise<Plugin | null> {
  const cfg = PROVIDER_CONFIG[provider];
  const mod = (await import(cfg.bareSpecifier)) as Record<string, unknown>;
  for (const name of cfg.pluginExportNames) {
    const candidate = mod[name];
    if (candidate) return candidate as Plugin;
  }
  return null;
}
async function loadExtraPlugin(
  entry:
    | string
    | {
        path: string;
        name?: string;
      },
): Promise<Plugin | null> {
  const path = typeof entry === "string" ? entry : entry.path;
  const named = typeof entry === "string" ? undefined : entry.name;
  const mod = (await import(path)) as Record<string, unknown>;
  const candidate = named ? mod[named] : mod.default;
  return (candidate as Plugin | undefined) ?? null;
}
function applyProviderSettings(
  runtime: AgentRuntime,
  provider: LiveProviderId,
): void {
  switch (provider) {
    case "openai":
      runtime.setSetting(
        "OPENAI_API_KEY",
        process.env.OPENAI_API_KEY ?? "",
        true,
      );
      if (process.env.OPENAI_BASE_URL) {
        runtime.setSetting("OPENAI_BASE_URL", process.env.OPENAI_BASE_URL);
      }
      if (process.env.OPENAI_LARGE_MODEL) {
        runtime.setSetting(
          "OPENAI_LARGE_MODEL",
          process.env.OPENAI_LARGE_MODEL,
        );
      }
      if (process.env.OPENAI_MEDIUM_MODEL) {
        runtime.setSetting(
          "OPENAI_MEDIUM_MODEL",
          process.env.OPENAI_MEDIUM_MODEL,
        );
      }
      if (process.env.OPENAI_SMALL_MODEL) {
        runtime.setSetting(
          "OPENAI_SMALL_MODEL",
          process.env.OPENAI_SMALL_MODEL,
        );
      }
      if (process.env.OPENAI_ACTION_PLANNER_MODEL) {
        runtime.setSetting(
          "OPENAI_ACTION_PLANNER_MODEL",
          process.env.OPENAI_ACTION_PLANNER_MODEL,
        );
      }
      break;
    case "anthropic":
      runtime.setSetting(
        "ANTHROPIC_API_KEY",
        process.env.ANTHROPIC_API_KEY ?? "",
        true,
      );
      break;
    case "elizacloud":
      runtime.setSetting(
        "ELIZAOS_CLOUD_API_KEY",
        process.env.ELIZAOS_CLOUD_API_KEY ?? "",
        true,
      );
      if (process.env.ELIZAOS_CLOUD_BASE_URL) {
        runtime.setSetting(
          "ELIZAOS_CLOUD_BASE_URL",
          process.env.ELIZAOS_CLOUD_BASE_URL,
        );
      }
      if (process.env.ELIZAOS_CLOUD_LARGE_MODEL) {
        runtime.setSetting(
          "ELIZAOS_CLOUD_LARGE_MODEL",
          process.env.ELIZAOS_CLOUD_LARGE_MODEL,
        );
      }
      if (process.env.ELIZAOS_CLOUD_SMALL_MODEL) {
        runtime.setSetting(
          "ELIZAOS_CLOUD_SMALL_MODEL",
          process.env.ELIZAOS_CLOUD_SMALL_MODEL,
        );
      }
      break;
    case "cerebras": {
      // Cerebras = OpenAI plugin pinned at the Cerebras endpoint. Pick the
      // dedicated key first; fall back to OPENAI_API_KEY if a caller is
      // already aliasing it themselves.
      const key =
        process.env.CEREBRAS_API_KEY?.trim() ||
        process.env.OPENAI_API_KEY?.trim() ||
        "";
      runtime.setSetting("OPENAI_API_KEY", key, true);
      runtime.setSetting(
        "OPENAI_BASE_URL",
        process.env.OPENAI_BASE_URL || "https://api.cerebras.ai/v1",
      );
      runtime.setSetting(
        "OPENAI_LARGE_MODEL",
        process.env.OPENAI_LARGE_MODEL || DEFAULT_CEREBRAS_TEXT_MODEL,
      );
      runtime.setSetting(
        "OPENAI_MEDIUM_MODEL",
        process.env.OPENAI_MEDIUM_MODEL ||
          process.env.OPENAI_LARGE_MODEL ||
          DEFAULT_CEREBRAS_TEXT_MODEL,
      );
      runtime.setSetting(
        "OPENAI_SMALL_MODEL",
        process.env.OPENAI_SMALL_MODEL || DEFAULT_CEREBRAS_TEXT_MODEL,
      );
      runtime.setSetting(
        "OPENAI_ACTION_PLANNER_MODEL",
        process.env.OPENAI_ACTION_PLANNER_MODEL ||
          process.env.OPENAI_LARGE_MODEL ||
          DEFAULT_CEREBRAS_TEXT_MODEL,
      );
      runtime.setSetting(
        "OPENAI_PLANNER_MODEL",
        process.env.OPENAI_PLANNER_MODEL ||
          process.env.OPENAI_ACTION_PLANNER_MODEL ||
          process.env.OPENAI_LARGE_MODEL ||
          DEFAULT_CEREBRAS_TEXT_MODEL,
      );
      break;
    }
  }
}
/**
 * Apply the Cerebras alias for OpenAI-provider live tests. Mirrors the logic
 * in `scripts/test-env.ts`: when CEREBRAS_API_KEY is present and OPENAI_API_KEY
 * isn't, populate OPENAI_* env vars so plugin-openai talks to Cerebras.
 *
 * Returns a disposer that restores the previous values.
 */
function maybeApplyCerebrasAlias(provider: LiveProviderId): () => void {
  if (provider !== "openai") return () => {};
  const cerebras = process.env.CEREBRAS_API_KEY?.trim();
  if (!cerebras) return () => {};
  if (process.env.OPENAI_API_KEY?.trim()) return () => {};
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,
    OPENAI_MEDIUM_MODEL: process.env.OPENAI_MEDIUM_MODEL,
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,
    OPENAI_ACTION_PLANNER_MODEL: process.env.OPENAI_ACTION_PLANNER_MODEL,
    OPENAI_PLANNER_MODEL: process.env.OPENAI_PLANNER_MODEL,
  };
  process.env.OPENAI_API_KEY = cerebras;
  process.env.OPENAI_BASE_URL ||= "https://api.cerebras.ai/v1";
  process.env.OPENAI_LARGE_MODEL ||= DEFAULT_CEREBRAS_TEXT_MODEL;
  process.env.OPENAI_MEDIUM_MODEL ||= process.env.OPENAI_LARGE_MODEL;
  process.env.OPENAI_SMALL_MODEL ||= DEFAULT_CEREBRAS_TEXT_MODEL;
  process.env.OPENAI_ACTION_PLANNER_MODEL ||= process.env.OPENAI_LARGE_MODEL;
  process.env.OPENAI_PLANNER_MODEL ||= process.env.OPENAI_ACTION_PLANNER_MODEL;
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
function effectiveRequiredEnv(opts: LiveAgentTestOptions): {
  missing: string[];
  hasCerebrasFallback: boolean;
} {
  const provider = opts.provider ?? "openai";
  const required = [...opts.requiredEnv];
  const missing = required.filter((k) => !process.env[k]?.trim());
  // Cerebras fallback: if missing list mentions OPENAI_API_KEY but
  // CEREBRAS_API_KEY is set, that satisfies the requirement.
  const hasCerebrasFallback =
    provider === "openai" &&
    missing.includes("OPENAI_API_KEY") &&
    Boolean(process.env.CEREBRAS_API_KEY?.trim());
  const filtered = hasCerebrasFallback
    ? missing.filter((k) => k !== "OPENAI_API_KEY")
    : missing;
  return { missing: filtered, hasCerebrasFallback };
}
export async function buildLiveHarness(
  opts: LiveAgentTestOptions,
): Promise<LiveAgentHarness> {
  const provider = opts.provider ?? "openai";
  const restoreEnv = maybeApplyCerebrasAlias(provider);
  let runtime: AgentRuntime | undefined;
  const close = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      if (runtime) {
        try {
          await runtime.stop();
        } catch (error) {
          failures.push(error);
        }
        try {
          await runtime.close();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      try {
        restoreEnv();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Live runtime cleanup failed");
    }
  };
  try {
    const providerPlugin = await resolveProviderPlugin(provider);
    if (!providerPlugin) {
      throw new Error(
        `[live-agent-test] failed to resolve provider plugin for ${provider}`,
      );
    }
    const plugins: Plugin[] = [providerPlugin];
    for (const entry of opts.extraPlugins ?? []) {
      const extra = await loadExtraPlugin(entry);
      if (!extra) {
        throw new Error(
          `[live-agent-test] failed to load extra plugin: ${typeof entry === "string" ? entry : entry.path}`,
        );
      }
      plugins.push(extra);
    }
    const agentId = randomUUID() as UUID;
    const character: Character = {
      id: agentId,
      name: "LiveTestAgent",
      system: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      bio: ["Live e2e test agent"],
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful", "concise"],
      knowledge: [],
      plugins: [],
      secrets: {},
      settings: {},
    };
    runtime = new AgentRuntime({
      agentId,
      character,
      plugins,
      checkShouldRespond: false,
      logLevel: "warn",
    });
    const adapter = SQLiteDatabaseAdapter.create(":memory:", runtime.agentId);
    runtime.registerDatabaseAdapter(adapter);
    await adapter.init();
    applyProviderSettings(runtime, provider);
    await runtime.initialize();
    return { agentId, runtime, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Live runtime startup and cleanup failed",
      );
    }
    throw error;
  }
}

/**
 * Resolve the auto-defaulted required env for a provider. Callers may pass
 * `requiredEnv: []` to fall back entirely on the provider's defaults.
 */
function defaultedRequiredEnv(opts: LiveAgentTestOptions): string[] {
  const provider = opts.provider ?? "openai";
  if (opts.requiredEnv.length > 0) return opts.requiredEnv;
  return PROVIDER_CONFIG[provider].defaultRequiredEnv;
}
function emitSkip(name: string, reason: string): void {
  process.env.SKIP_REASON ||= reason;
  console.warn(
    `${YELLOW}[live-agent-test] ${name} skipped — ${reason}${RESET}`,
  );
  describe(name, () => {
    it.skip(`[live] suite skipped — ${reason}`, () => {});
  });
}
/**
 * Register a vitest `describe` block that boots a real AgentRuntime against a
 * live LLM provider. When required env is missing, the suite is skipped with
 * a yellow warning.
 */
export function describeLive(
  name: string,
  opts: LiveAgentTestOptions,
  body: (ctx: { harness: () => LiveAgentHarness }) => void,
): void {
  const required = defaultedRequiredEnv({
    ...opts,
    requiredEnv: opts.requiredEnv,
  });
  const { missing } = effectiveRequiredEnv({ ...opts, requiredEnv: required });
  if (missing.length > 0) {
    const reason = `missing required env: ${missing.join(", ")} (set ${missing.join(", ")} to enable)`;
    emitSkip(name, reason);
    return;
  }
  describe(name, () => {
    let harness: LiveAgentHarness | null = null;
    beforeAll(async () => {
      harness = await buildLiveHarness(opts);
    }, 120000);
    afterAll(async () => {
      if (harness) {
        await harness.close();
        harness = null;
      }
    });
    body({
      harness: () => {
        if (!harness) {
          throw new Error(
            "[live-agent-test] harness accessed before beforeAll",
          );
        }
        return harness;
      },
    });
  });
}
