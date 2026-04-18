/**
 * Build a real AgentRuntime for scenario execution. Uses PGLite for storage
 * (no SQL mocks) and registers the first available live LLM provider via
 * `selectLiveProvider()`. Fails if no provider key is set — the caller must
 * have verified that before invoking.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import {
  AgentRuntime as AgentRuntimeCtor,
  createBasicCapabilitiesPlugin,
  createCharacter,
  logger,
} from "@elizaos/core";
import {
  type LiveProviderConfig,
  type LiveProviderName,
  selectLiveProvider,
} from "../../app-core/test/helpers/live-provider.ts";
import {
  prepareMockedTestEnvironment,
} from "../../../../test/mocks/helpers/mock-runtime.ts";
import { seedBenchmarkLifeOpsFixtures } from "../../../../test/mocks/helpers/seed-benchmark-fixtures.ts";
import {
  seedGoogleConnectorGrant,
  seedXConnectorGrant,
} from "../../../../test/mocks/helpers/seed-grants.ts";

export interface RuntimeFactoryResult {
  runtime: AgentRuntime;
  pgliteDir: string;
  providerName: LiveProviderName;
  providerConfig: LiveProviderConfig;
  cleanup: () => Promise<void>;
}

function applyRuntimeSettings(
  runtime: AgentRuntime,
  settings: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(settings)) {
    runtime.setSetting(
      key,
      value,
      /(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key),
    );
  }
}

function isPlugin(value: unknown): value is Plugin {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { description?: unknown }).description === "string"
  );
}

function extractPlugin(mod: unknown, names: readonly string[]): Plugin | null {
  if (mod === null || typeof mod !== "object") return null;
  const record = mod as Record<string, unknown>;
  for (const key of names) {
    const candidate = record[key];
    if (isPlugin(candidate)) return candidate;
  }
  return null;
}

export interface CreateScenarioRuntimeOptions {
  characterName?: string;
  preferredProvider?: LiveProviderName;
  extraPlugins?: Plugin[];
}

export async function createScenarioRuntime(
  options?: CreateScenarioRuntimeOptions,
): Promise<RuntimeFactoryResult> {
  const providerConfig = selectLiveProvider(options?.preferredProvider);
  if (!providerConfig) {
    throw new Error(
      "[scenario-runner] no LLM provider configured. Set GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / OPENROUTER_API_KEY.",
    );
  }
  const mockedEnvironment = await prepareMockedTestEnvironment();
  for (const [key, value] of Object.entries(providerConfig.env)) {
    process.env[key] = value;
  }

  const pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "scenario-runner-pglite-"),
  );
  const prevPgliteDir = process.env.PGLITE_DATA_DIR;
  const prevWebsiteBlockerHostsFilePath =
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
  const prevSelfControlHostsFilePath = process.env.SELFCONTROL_HOSTS_FILE_PATH;
  const prevMiladyDisableActivityTracker =
    process.env.MILADY_DISABLE_ACTIVITY_TRACKER;
  const prevElizaDisableActivityTracker =
    process.env.ELIZA_DISABLE_ACTIVITY_TRACKER;
  let scenarioHostsRoot: string | null = null;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  process.env.MILADY_DISABLE_ACTIVITY_TRACKER = "1";
  process.env.ELIZA_DISABLE_ACTIVITY_TRACKER = "1";
  if (!process.env.LOCAL_EMBEDDING_DIMENSIONS?.trim()) {
    process.env.LOCAL_EMBEDDING_DIMENSIONS = "384";
  }
  if (!process.env.EMBEDDING_DIMENSION?.trim()) {
    process.env.EMBEDDING_DIMENSION = "384";
  }
  if (
    !prevWebsiteBlockerHostsFilePath?.trim() &&
    !prevSelfControlHostsFilePath?.trim()
  ) {
    scenarioHostsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "scenario-runner-hosts-"),
    );
    const scenarioHostsFilePath = path.join(scenarioHostsRoot, "hosts");
    fs.writeFileSync(
      scenarioHostsFilePath,
      ["127.0.0.1 localhost", "::1 localhost", ""].join("\n"),
      "utf8",
    );
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH = scenarioHostsFilePath;
    process.env.SELFCONTROL_HOSTS_FILE_PATH = scenarioHostsFilePath;
  }

  const character = createCharacter({
    name: options?.characterName ?? "ScenarioAgent",
  });
  const runtime = new AgentRuntimeCtor({
    character,
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
  });

  const { default: pluginSql } = (await import("@elizaos/plugin-sql")) as {
    default: Plugin;
  };
  await runtime.registerPlugin(pluginSql);

  // Basic capabilities: REPLY, CHOICE, IGNORE, NONE actions, core providers
  // (CHARACTER, ACTIONS, MESSAGES, ENTITIES, ...), and baseline services
  // (TaskService, EmbeddingGenerationService). advancedCapabilities also
  // registers contact/message actions (ADD_CONTACT, SEND_MESSAGE, ...).
  // Without this plugin the runtime has no conversational reply action and
  // nearly every scenario fails with "expected 1 call(s) to REPLY, saw 0".
  await runtime.registerPlugin(
    createBasicCapabilitiesPlugin({ advancedCapabilities: true }),
  );

  try {
    const localEmbedding = (await import(
      "@elizaos/plugin-local-embedding"
    )) as { default: Plugin };
    await runtime.registerPlugin(localEmbedding.default);
  } catch (err) {
    logger.warn(
      `[scenario-runner] local-embedding plugin unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  applyRuntimeSettings(runtime, providerConfig.env);
  const providerModule = (await import(providerConfig.pluginPackage)) as Record<
    string,
    unknown
  >;
  const providerPlugin = extractPlugin(providerModule, ["default", "elizaPlugin"]);
  if (!providerPlugin) {
    throw new Error(
      `[scenario-runner] provider package ${providerConfig.pluginPackage} did not export a Plugin`,
    );
  }
  await runtime.registerPlugin(providerPlugin);

  // Default-load @elizaos/plugin-agent-skills so scenarios that declare it in
  // `requires.plugins` resolve without ad-hoc wiring. Graceful-degrade when the
  // package cannot be resolved (fresh checkout, not yet installed).
  try {
    const agentSkillsModule = (await import(
      "@elizaos/plugin-agent-skills"
    )) as Record<string, unknown>;
    const agentSkillsPlugin = extractPlugin(agentSkillsModule, [
      "default",
      "agentSkillsPlugin",
    ]);
    if (agentSkillsPlugin) {
      await runtime.registerPlugin(agentSkillsPlugin);
    } else {
      logger.warn(
        "[scenario-runner] @elizaos/plugin-agent-skills did not export a Plugin; skipping",
      );
    }
  } catch (err) {
    logger.warn(
      `[scenario-runner] @elizaos/plugin-agent-skills unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Default-load @elizaos/app-lifeops after agent-skills (LifeOps action
  // routing depends on agent-skills). Graceful-degrade on resolution failure.
  // Env prerequisites (Gmail OAuth, Twilio, etc.) are NOT required for the
  // plugin to load — they only gate individual action execution at call time.
  try {
    const lifeOpsModule = (await import("@elizaos/app-lifeops/plugin")) as Record<
      string,
      unknown
    >;
    const lifeOpsPlugin = extractPlugin(lifeOpsModule, [
      "default",
      "appLifeOpsPlugin",
    ]);
    if (lifeOpsPlugin) {
      await runtime.registerPlugin(lifeOpsPlugin);
    } else {
      logger.warn(
        "[scenario-runner] @elizaos/app-lifeops did not export a Plugin; skipping",
      );
    }
  } catch (err) {
    logger.warn(
      `[scenario-runner] @elizaos/app-lifeops unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Load the separate LifeOps route bridge plugin so scenario API turns can
  // exercise the same HTTP handlers the app exposes at runtime.
  try {
    const lifeOpsRoutesModule = (await import(
      "@elizaos/app-lifeops/routes/plugin"
    )) as Record<string, unknown>;
    const lifeOpsRoutesPlugin = extractPlugin(lifeOpsRoutesModule, [
      "default",
      "lifeopsPlugin",
    ]);
    if (lifeOpsRoutesPlugin) {
      if (lifeOpsRoutesPlugin.routes?.length) {
        for (const route of lifeOpsRoutesPlugin.routes) {
          const routePath = route.path.startsWith("/")
            ? route.path
            : `/${route.path}`;
          runtime.routes.push({ ...route, path: routePath });
        }
      }
    } else {
      logger.warn(
        "[scenario-runner] @elizaos/app-lifeops/routes/plugin did not export a Plugin; skipping",
      );
    }
  } catch (err) {
    logger.warn(
      `[scenario-runner] @elizaos/app-lifeops/routes/plugin unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const extra of options?.extraPlugins ?? []) {
    await runtime.registerPlugin(extra);
  }

  await runtime.initialize();
  const cleanupRuntimeFixtures =
    await mockedEnvironment.applyRuntimeFixtures?.(runtime);
  await seedGoogleConnectorGrant(runtime);
  await seedXConnectorGrant(runtime);
  await seedBenchmarkLifeOpsFixtures(runtime);

  const cleanup = async (): Promise<void> => {
    try {
      await cleanupRuntimeFixtures?.();
    } catch (err) {
      logger.debug(`[scenario-runner] runtime fixture cleanup error: ${err}`);
    }
    try {
      await runtime.stop();
    } catch (err) {
      logger.debug(`[scenario-runner] runtime.stop() error: ${err}`);
    }
    try {
      await runtime.close();
    } catch (err) {
      logger.debug(`[scenario-runner] runtime.close() error: ${err}`);
    }
    if (prevPgliteDir !== undefined) {
      process.env.PGLITE_DATA_DIR = prevPgliteDir;
    } else {
      delete process.env.PGLITE_DATA_DIR;
    }
    if (prevWebsiteBlockerHostsFilePath !== undefined) {
      process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH =
        prevWebsiteBlockerHostsFilePath;
    } else {
      delete process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
    }
    if (prevSelfControlHostsFilePath !== undefined) {
      process.env.SELFCONTROL_HOSTS_FILE_PATH = prevSelfControlHostsFilePath;
    } else {
      delete process.env.SELFCONTROL_HOSTS_FILE_PATH;
    }
    if (prevMiladyDisableActivityTracker !== undefined) {
      process.env.MILADY_DISABLE_ACTIVITY_TRACKER =
        prevMiladyDisableActivityTracker;
    } else {
      delete process.env.MILADY_DISABLE_ACTIVITY_TRACKER;
    }
    if (prevElizaDisableActivityTracker !== undefined) {
      process.env.ELIZA_DISABLE_ACTIVITY_TRACKER =
        prevElizaDisableActivityTracker;
    } else {
      delete process.env.ELIZA_DISABLE_ACTIVITY_TRACKER;
    }
    try {
      await mockedEnvironment.cleanup();
    } catch (err) {
      logger.debug(
        `[scenario-runner] mocked environment cleanup error: ${err}`,
      );
    }
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    if (scenarioHostsRoot) {
      try {
        fs.rmSync(scenarioHostsRoot, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  };

  return {
    runtime,
    pgliteDir,
    providerName: providerConfig.name,
    providerConfig,
    cleanup,
  };
}
