#!/usr/bin/env bun
/**
 * Validates the production autonomy + prompt-batcher path against Cerebras.
 *
 * Usage:
 *   CEREBRAS_API_KEY=<key> bun run packages/scripts/run-autonomy-cerebras-loops.ts --loops 6
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerateTextParams, Memory, Plugin, UUID } from "@elizaos/core";
import {
  AgentRuntime,
  InMemoryDatabaseAdapter,
  ModelType,
} from "@elizaos/core";
import { AutonomyService } from "../core/src/features/autonomy/service";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  // dotenv is optional for this one-off verifier.
}

type Args = {
  loops: number;
  model: string;
  seedThoughts: number;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let loops = 6;
  let model =
    process.env.CEREBRAS_MODEL?.trim() ||
    process.env.OPENAI_LARGE_MODEL?.trim() ||
    "gpt-oss-120b";
  let seedThoughts = 14;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--loops" && next) {
      loops = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--model" && next) {
      model = next;
      i += 1;
    } else if (arg === "--seed-thoughts" && next) {
      seedThoughts = Number.parseInt(next, 10);
      i += 1;
    }
  }

  return {
    loops: Number.isFinite(loops) && loops > 0 ? loops : 6,
    model,
    seedThoughts:
      Number.isFinite(seedThoughts) && seedThoughts > 0 ? seedThoughts : 14,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createCerebrasTextPlugin(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): Plugin {
  const complete = async (
    _runtime: unknown,
    params: GenerateTextParams,
  ): Promise<string> => {
    const promptText =
      typeof params.prompt === "string" ? params.prompt : JSON.stringify(params);
    const response = await fetch(
      `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            ...(params.system
              ? [{ role: "system", content: params.system }]
              : []),
            { role: "user", content: promptText },
          ],
          temperature: params.temperature ?? 0.2,
          max_tokens: params.maxTokens ?? 512,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Cerebras request failed ${response.status}: ${await response.text()}`,
      );
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  };

  return {
    name: "cerebras-live-text-verifier",
    description:
      "Minimal Cerebras text model plugin for autonomy verification.",
    models: {
      [ModelType.TEXT_NANO]: complete,
      [ModelType.TEXT_SMALL]: complete,
      [ModelType.TEXT_MEDIUM]: complete,
      [ModelType.TEXT_LARGE]: complete,
      [ModelType.RESPONSE_HANDLER]: complete,
      [ModelType.ACTION_PLANNER]: complete,
    },
  };
}

async function buildRuntime(model: string): Promise<AgentRuntime> {
  const apiKey = requireEnv("CEREBRAS_API_KEY");
  const baseUrl =
    process.env.CEREBRAS_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.cerebras.ai/v1";

  process.env.OPENAI_API_KEY = apiKey;
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.OPENAI_SMALL_MODEL = model;
  process.env.OPENAI_MEDIUM_MODEL = model;
  process.env.OPENAI_LARGE_MODEL = model;
  process.env.OPENAI_NANO_MODEL = model;
  process.env.OPENAI_RESPONSE_HANDLER_MODEL = model;
  process.env.OPENAI_ACTION_PLANNER_MODEL = model;
  process.env.ALLOW_NO_DATABASE = "true";
  process.env.PROMPT_BATCHER_BATCH_SIZE = "1";
  process.env.PROMPT_BATCHER_MAX_SECTIONS_PER_CALL = "1";

  const runtime = new AgentRuntime({
    character: {
      name: "AutonomyCerebrasVerifier",
      bio: ["A verifier agent for autonomous recurring thought loops."],
      system:
        "During autonomy verification, always produce a concise text field that states the loop's next concrete action.",
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: ["autonomy verification", "stateful loops"],
      adjectives: ["concise", "stateful", "practical"],
      knowledge: [],
      plugins: [],
      secrets: {
        CEREBRAS_API_KEY: apiKey,
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: baseUrl,
        OPENAI_SMALL_MODEL: model,
        OPENAI_MEDIUM_MODEL: model,
        OPENAI_LARGE_MODEL: model,
        OPENAI_NANO_MODEL: model,
        OPENAI_RESPONSE_HANDLER_MODEL: model,
        OPENAI_ACTION_PLANNER_MODEL: model,
      },
    },
    adapter: new InMemoryDatabaseAdapter(),
    plugins: [createCerebrasTextPlugin({ apiKey, baseUrl, model })],
    settings: {
      CEREBRAS_API_KEY: apiKey,
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: baseUrl,
      OPENAI_SMALL_MODEL: model,
      OPENAI_MEDIUM_MODEL: model,
      OPENAI_LARGE_MODEL: model,
      OPENAI_NANO_MODEL: model,
      OPENAI_RESPONSE_HANDLER_MODEL: model,
      OPENAI_ACTION_PLANNER_MODEL: model,
      ALLOW_NO_DATABASE: "true",
    },
    enableAutonomy: true,
    logLevel: "warn",
    disableBasicCapabilities: false,
  });

  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

async function seedAutonomousThoughts(
  runtime: AgentRuntime,
  service: AutonomyService,
  count: number,
): Promise<void> {
  const serviceState = service as unknown as { autonomousRoomId: UUID };
  const startedAt = Date.now() - count * 60_000;
  for (let index = 0; index < count; index += 1) {
    const memory: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: serviceState.autonomousRoomId,
      createdAt: startedAt + index * 60_000,
      content: {
        text: `Seed autonomous thought ${index + 1}: continue the verification plan, remember previous loop ${index}, and preserve unresolved state.`,
        source: "autonomy-cerebras-verifier",
        metadata: {
          type: "autonomous-response",
          isAutonomous: true,
          isInternalThought: true,
          autonomyMode: "continuous",
          channelId: "autonomous",
          timestamp: startedAt + index * 60_000,
        },
      },
    };
    await runtime.createMemory(memory, "memories");
  }
}

async function countAutonomyMemories(
  runtime: AgentRuntime,
  service: AutonomyService,
): Promise<{ prompts: number; responses: number; total: number }> {
  const serviceState = service as unknown as { autonomousRoomId: UUID };
  const memories = await runtime.getMemories({
    roomId: serviceState.autonomousRoomId,
    tableName: "memories",
    limit: 500,
  });
  let prompts = 0;
  let responses = 0;
  for (const memory of memories) {
    const metadata = memory.content.metadata as
      | Record<string, unknown>
      | undefined;
    if (metadata?.type === "autonomous-prompt") prompts += 1;
    if (metadata?.type === "autonomous-response") responses += 1;
  }
  return { prompts, responses, total: memories.length };
}

async function run(): Promise<void> {
  const args = parseArgs();
  const runtime = await buildRuntime(args.model);
  const service = await AutonomyService.start(runtime);
  await seedAutonomousThoughts(runtime, service, args.seedThoughts);

  const serviceInternals = service as unknown as {
    getTargetRoomContextText: () => Promise<string>;
  };

  const firstContext = await serviceInternals.getTargetRoomContextText();
  const secondContext = await serviceInternals.getTargetRoomContextText();
  const contextCacheStable = firstContext === secondContext;

  const loopResults: Array<{
    loop: number;
    totalCalls: number;
    totalDrains: number;
    prompts: number;
    responses: number;
  }> = [];

  for (let loop = 1; loop <= args.loops; loop += 1) {
    await runtime.promptBatcher.drainAffinityGroup("autonomy");
    const stats = runtime.promptBatcher.getStats();
    const memoryCounts = await countAutonomyMemories(runtime, service);
    loopResults.push({
      loop,
      totalCalls: stats.totalCalls,
      totalDrains: stats.totalDrains,
      prompts: memoryCounts.prompts,
      responses: memoryCounts.responses,
    });
  }

  const batcherStats = runtime.promptBatcher.getStats();
  const compactionStats = service.getAutonomyCompactionStats();
  const memoryCounts = await countAutonomyMemories(runtime, service);
  const sectionCount =
    runtime.promptBatcher.getSectionCountForAffinity("autonomy");
  const passed =
    sectionCount === 1 &&
    contextCacheStable &&
    batcherStats.totalCalls >= args.loops &&
    batcherStats.totalDrains >= args.loops &&
    batcherStats.totalFallbacks === 0 &&
    compactionStats.compactions >= 1 &&
    compactionStats.cacheWrites >= 1 &&
    compactionStats.cacheHits >= 1 &&
    memoryCounts.prompts >= args.loops;

  console.log(
    JSON.stringify(
      {
        passed,
        model: args.model,
        loopsRequested: args.loops,
        sectionCount,
        contextCacheStable,
        batcherStats,
        compactionStats,
        memoryCounts,
        loopResults,
      },
      null,
      2,
    ),
  );

  await service.stop();
  await runtime.stop();
  await runtime.close();

  if (!passed) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
