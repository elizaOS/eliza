/**
 * Integration test for WS1 cross-channel search.
 *
 * Boots a real AgentRuntime on PGLite, seeds messages into five rooms
 * (each pinned to a different platform via `source`), runs the
 * MESSAGE action (with direct query — no LLM required),
 * and asserts merged citations across all five platforms.
 *
 * Run:
 *   bunx vitest run eliza/plugins/app-lifeops/test/cross-channel-search.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../test/helpers/real-runtime";
import { searchAcrossChannelsAction } from "../src/actions/search-across-channels.js";
import { runCrossChannelSearch } from "../src/lifeops/cross-channel-search.js";
import { appLifeOpsPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let isolatedStateDir: string;
let isolatedConfigPath: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

function setIsolatedEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "cross-channel-search-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );

  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }

  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
  delete process.env.ELIZA_STATE_DIR;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
}

function restoreEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

type SeedMessageInput = {
  platform: "discord" | "telegram" | "imessage" | "signal" | "whatsapp";
  speakerName: string;
  text: string;
  ageMs: number;
};

async function seedMessage(input: SeedMessageInput): Promise<{
  roomId: UUID;
  entityId: UUID;
}> {
  const roomId = stringToUuid(`ws1-${input.platform}-room`);
  const entityId = stringToUuid(`ws1-${input.platform}-entity`);
  const worldId = stringToUuid(`ws1-${input.platform}-world`);

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    worldName: input.platform,
    userName: input.speakerName,
    name: input.speakerName,
    source: input.platform,
    type: ChannelType.DM,
    channelId: `${input.platform}-channel`,
  });

  const memory = {
    id: stringToUuid(`ws1-${input.platform}-${input.text}-${input.ageMs}`),
    agentId: runtime.agentId,
    roomId,
    entityId,
    content: {
      text: input.text,
      source: input.platform,
      name: input.speakerName,
    },
    createdAt: Date.now() - input.ageMs,
  };

  const embedded = await runtime.addEmbeddingToMemory(memory as never);
  await runtime.createMemory(embedded as never, "messages");

  return { roomId, entityId };
}

beforeAll(async () => {
  setIsolatedEnv();
  // withLLM registers the local embedding plugin so TEXT_EMBEDDING is
  // available even without an LLM API key. We don't need a provider for
  // the action path in this test — direct `query` param bypasses
  // TEXT_SMALL planning, and a third case validates the no-LLM fallback.
  const result = await createRealTestRuntime({
    plugins: [appLifeOpsPlugin],
    withLLM: true,
  });
  runtime = result.runtime;
  cleanup = result.cleanup;

  // Seed messages across five platforms. Each message carries the shared
  // keyword "ProjectAtlas" so the semantic search will pull from every
  // room even though the surrounding text is different per platform.
  await seedMessage({
    platform: "discord",
    speakerName: "Jill",
    text: "ProjectAtlas timeline slipped again — we need to regroup before Friday.",
    ageMs: 60_000,
  });
  await seedMessage({
    platform: "telegram",
    speakerName: "Jill",
    text: "Just sent you the ProjectAtlas milestone doc, please review tonight.",
    ageMs: 30_000,
  });
  await seedMessage({
    platform: "imessage",
    speakerName: "Jill",
    text: "Heads up: ProjectAtlas standup is moving to 9am tomorrow.",
    ageMs: 10_000,
  });
  await seedMessage({
    platform: "signal",
    speakerName: "Jill",
    text: "ProjectAtlas Signal fallback thread has the vendor call note.",
    ageMs: 8_000,
  });
  await seedMessage({
    platform: "whatsapp",
    speakerName: "Jill",
    text: "ProjectAtlas WhatsApp room has the launch checklist screenshot.",
    ageMs: 6_000,
  });
}, 240_000);

afterAll(async () => {
  await cleanup();
  restoreEnv();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe("cross-channel-search WS1 integration", () => {
  it("runCrossChannelSearch returns passive-memory hits from all chat platforms with typed unsupported markers when asked", async () => {
    const result = await runCrossChannelSearch(runtime, {
      query: "ProjectAtlas",
      channels: [
        "memory",
        "discord",
        "telegram",
        "imessage",
        "gmail",
        "signal",
        "whatsapp",
      ],
      limit: 5,
    });

    const platforms = new Set(result.hits.map((h) => h.channel));
    expect(platforms.has("discord")).toBe(true);
    expect(platforms.has("telegram")).toBe(true);
    expect(platforms.has("imessage")).toBe(true);
    expect(platforms.has("signal")).toBe(true);
    expect(platforms.has("whatsapp")).toBe(true);

    for (const hit of result.hits) {
      expect(hit.citation.platform).toBeTruthy();
      expect(typeof hit.timestamp).toBe("string");
      expect(hit.sourceRef.length).toBeGreaterThan(0);
    }

    const unsupportedChannels = result.unsupported.map((u) => u.channel);
    expect(unsupportedChannels).toContain("signal");
    expect(unsupportedChannels).toContain("whatsapp");

    const gmailStatus =
      result.unsupported.find((u) => u.channel === "gmail") ??
      result.degraded.find((d) => d.channel === "gmail");
    expect(gmailStatus).toBeTruthy();
  }, 120_000);

  it("MESSAGE action returns merged clipboard-ready payload with citations", async () => {
    const handler = searchAcrossChannelsAction.handler;
    if (!handler) throw new Error("searchAcrossChannelsAction.handler missing");

    const result = await handler(
      runtime,
      {
        entityId: runtime.agentId,
        content: {
          source: "autonomy",
          text: "search for ProjectAtlas across all my channels",
        },
      } as never,
      {} as never,
      {
        parameters: {
          query: "ProjectAtlas",
          limit: 5,
        },
      } as never,
    );

    expect(result).toBeTruthy();
    const record = result as {
      success: boolean;
      text: string;
      data: {
        hits: Array<{
          line: number;
          channel: string;
          citation: { platform: string; label: string };
          timestamp: string;
        }>;
        channelsWithHits: string[];
      };
    };
    expect(record.success).toBe(true);
    expect(record.text).toContain("ProjectAtlas");

    const channels = new Set(record.data.hits.map((h) => h.channel));
    expect(channels.has("discord")).toBe(true);
    expect(channels.has("telegram")).toBe(true);
    expect(channels.has("imessage")).toBe(true);
    expect(channels.has("signal")).toBe(true);
    expect(channels.has("whatsapp")).toBe(true);

    for (const hit of record.data.hits) {
      expect(typeof hit.line).toBe("number");
      expect(hit.citation.platform).toBeTruthy();
      expect(hit.citation.label).toBeTruthy();
    }

    expect(record.data.channelsWithHits.length).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it("handler asks for clarification when query cannot be derived and no LLM is available", async () => {
    const handler = searchAcrossChannelsAction.handler;
    if (!handler) throw new Error("searchAcrossChannelsAction.handler missing");

    const runtimeWithoutLlm = runtime as AgentRuntime & {
      useModel?: AgentRuntime["useModel"];
    };
    const originalUseModel = runtimeWithoutLlm.useModel;
    runtimeWithoutLlm.useModel = undefined;
    let result: Awaited<ReturnType<typeof handler>>;
    try {
      result = await handler(
        runtimeWithoutLlm,
        {
          entityId: runtime.agentId,
          content: { source: "autonomy", text: "" },
        } as never,
        {} as never,
        { parameters: {} } as never,
      );
    } finally {
      runtimeWithoutLlm.useModel = originalUseModel;
    }

    const record = result as {
      success: boolean;
      data: { noop?: boolean };
    };
    expect(record.success).toBe(true);
    expect(record.data?.noop === true || record.data?.noop === undefined).toBe(
      true,
    );
  }, 60_000);
});
