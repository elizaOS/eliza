import {
  ChannelType,
  type Entity,
  type Room,
  stringToUuid,
  type World,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { exportAgent, importAgent } from "../src/services/agent-export.ts";

const PASSWORD = "export-log-time-password";

it("keeps imported log timestamps and order", async () => {
  const source = await createRealTestRuntime({
    characterName: "LogTimeSource",
  });
  const target = await createRealTestRuntime({
    characterName: "LogTimeTarget",
  });
  try {
    const adapter = source.runtime.adapter;
    const entityId = stringToUuid("log-time-entity");
    const roomId = stringToUuid("log-time-room");
    const worldId = stringToUuid("log-time-world");
    await adapter.createEntities([
      {
        id: entityId,
        agentId: source.runtime.agentId,
        names: ["Writer"],
      } as Entity,
    ]);
    await adapter.createWorlds([
      {
        id: worldId,
        agentId: source.runtime.agentId,
        name: "Log time world",
        serverId: worldId,
      } as World,
    ]);
    await adapter.createRooms([
      {
        id: roomId,
        worldId,
        agentId: source.runtime.agentId,
        name: "Log time room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createRoomParticipants([entityId], roomId);
    for (const step of ["first", "second", "third"]) {
      await adapter.createLogs([
        {
          body: { metadata: { step } },
          entityId,
          roomId,
          type: "log-time",
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const sourceLogs = await adapter.getLogs({ type: "log-time", limit: 10 });

    const bundle = await exportAgent(source.runtime, PASSWORD, {
      includeLogs: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await importAgent(target.runtime, bundle, PASSWORD);

    const targetDb = (await target.runtime.adapter.getConnection()) as {
      execute: (query: ReturnType<typeof sql>) => Promise<{
        rows: Array<{ body: { metadata: { step: string } }; created_at: Date }>;
      }>;
    };
    const importedRows = await targetDb.execute(
      sql`SELECT body, created_at FROM logs WHERE type = 'log-time' ORDER BY created_at DESC, id DESC`,
    );
    const importedTimeline = importedRows.rows.map((row) => ({
      step: row.body.metadata.step,
      createdAt: new Date(row.created_at).toISOString(),
    }));
    const sourceTimeline = sourceLogs.map((log) => ({
      step: (log.body as { metadata: { step: string } }).metadata.step,
      createdAt: log.createdAt.toISOString(),
    }));

    expect(sourceTimeline.map((entry) => entry.step)).toEqual([
      "third",
      "second",
      "first",
    ]);
    expect(importedTimeline).toEqual(sourceTimeline);
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
}, 300_000);
