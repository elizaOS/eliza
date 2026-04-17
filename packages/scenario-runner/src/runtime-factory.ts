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
import { AgentRuntime as AgentRuntimeCtor, createCharacter, logger } from "@elizaos/core";
import {
  type LiveProviderConfig,
  type LiveProviderName,
  selectLiveProvider,
} from "../../app-core/test/helpers/live-provider.ts";

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
  for (const [key, value] of Object.entries(providerConfig.env)) {
    process.env[key] = value;
  }

  const pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "scenario-runner-pglite-"),
  );
  const prevPgliteDir = process.env.PGLITE_DATA_DIR;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  if (!process.env.LOCAL_EMBEDDING_DIMENSIONS?.trim()) {
    process.env.LOCAL_EMBEDDING_DIMENSIONS = "384";
  }
  if (!process.env.EMBEDDING_DIMENSION?.trim()) {
    process.env.EMBEDDING_DIMENSION = "384";
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

  for (const extra of options?.extraPlugins ?? []) {
    await runtime.registerPlugin(extra);
  }

  await runtime.initialize();

  const cleanup = async (): Promise<void> => {
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
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
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
