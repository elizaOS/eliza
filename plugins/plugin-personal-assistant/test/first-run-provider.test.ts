/**
 * Covers the firstRun provider's local-backup affordance: offering restore-vs-start-fresh
 * when encrypted local backups exist, else the defaults/customize prompt. Deterministic,
 * stubbed agent backup state.
 */
import { ChannelType, type IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAgentBackupStubState,
  setAgentBackupStubState,
} from "./stubs/agent.ts";

vi.mock("@elizaos/agent", async () => import("./stubs/agent.ts"));

function createProviderRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "test-agent-first-run-provider" as never,
    async getCache<T>(key: string): Promise<T | null> {
      return (cache.get(key) as T | undefined) ?? null;
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
  } as unknown as IAgentRuntime;
}

function firstRunMessage(
  runtime: IAgentRuntime,
  text: string,
  channelType: ChannelType,
) {
  return {
    id: "msg" as never,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    agentId: runtime.agentId,
    content: { text, channelType },
    createdAt: Date.now(),
  } as never;
}

async function getFirstRunProvider() {
  const module = await import("../src/providers/first-run.ts");
  return module.firstRunProvider;
}

describe("firstRunProvider local backup affordance", () => {
  beforeEach(() => {
    resetAgentBackupStubState();
  });

  it("prompts restore-vs-start-fresh when encrypted local backups exist before setup", async () => {
    const runtime = createProviderRuntime();
    setAgentBackupStubState({
      localBackups: [
        {
          fileName: "agent-2026-06-29.agent-backup.json",
          path: "/tmp/agent-2026-06-29.agent-backup.json",
          createdAt: "2026-06-29T12:00:00.000Z",
          agentId: runtime.agentId,
          stateSha256: "abc123",
          sizeBytes: 4096,
        },
      ],
    });
    const firstRunProvider = await getFirstRunProvider();

    const surface = await firstRunProvider.get(
      runtime,
      firstRunMessage(runtime, "hello", ChannelType.DM),
      { values: {}, data: {}, text: "" } as never,
    );

    expect(surface.values?.firstRunPending).toBe(true);
    expect(surface.values?.firstRunLocalBackupAvailable).toBe(true);
    expect(surface.values?.firstRunLocalBackupCount).toBe(1);
    expect(surface.text).toMatch(/restore the latest local backup/i);
    expect(surface.data?.affordance).toMatchObject({
      localBackup: {
        available: true,
        count: 1,
        latestCreatedAt: "2026-06-29T12:00:00.000Z",
      },
    });
  });

  it("keeps the defaults/customize prompt when no local backup exists", async () => {
    const runtime = createProviderRuntime();
    const firstRunProvider = await getFirstRunProvider();

    const surface = await firstRunProvider.get(
      runtime,
      firstRunMessage(runtime, "hello", ChannelType.DM),
      { values: {}, data: {}, text: "" } as never,
    );

    expect(surface.values?.firstRunPending).toBe(true);
    expect(surface.values?.firstRunLocalBackupAvailable).toBe(false);
    expect(surface.text).toMatch(/defaults or customize/i);
    expect(surface.data?.affordance).not.toHaveProperty("localBackup");
  });
});
