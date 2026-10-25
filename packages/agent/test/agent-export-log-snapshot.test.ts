/**
 * Agent export's log collection against two real PGlite runtimes: a log the
 * running agent writes while an export is reading must not duplicate or drop
 * rows in the bundle. The concurrent writer is a real adapter write issued
 * right after the export's first log read.
 */
import {
  ChannelType,
  type Entity,
  type Room,
  stringToUuid,
  type World,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { exportAgent, importAgent } from "../src/services/agent-export.ts";

const PASSWORD = "export-snapshot-password";
const SEEDED_LOGS = 600;

it("exports one consistent log snapshot while the agent keeps writing", async () => {
  const source = await createRealTestRuntime({ characterName: "ExportSource" });
  const target = await createRealTestRuntime({ characterName: "ExportTarget" });
  try {
    const adapter = source.runtime.adapter;
    const entityId = stringToUuid("export-log-entity");
    const roomId = stringToUuid("export-log-room");
    await adapter.createEntities([
      {
        id: entityId,
        agentId: source.runtime.agentId,
        names: ["Writer"],
      } as Entity,
    ]);
    // Export walks worlds → rooms → participants, as for connector rooms.
    const worldId = stringToUuid("export-log-world");
    await adapter.createWorlds([
      {
        id: worldId,
        agentId: source.runtime.agentId,
        name: "Export log world",
        serverId: worldId,
      } as World,
    ]);
    await adapter.createRooms([
      {
        id: roomId,
        worldId,
        agentId: source.runtime.agentId,
        name: "Export log room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    // Export carries room participants' entities; the log author is one.
    await adapter.createRoomParticipants([entityId], roomId);
    for (let index = 0; index < SEEDED_LOGS; index += 1) {
      await adapter.createLogs([
        {
          body: { metadata: { index } },
          entityId,
          roomId,
          type: "export-snapshot",
        },
      ]);
    }

    // The agent keeps logging while the export runs: one write lands right
    // after the export's first log read.
    const readLogs = adapter.getLogs.bind(adapter);
    let reads = 0;
    adapter.getLogs = async (params) => {
      const rows = await readLogs(params);
      reads += 1;
      if (reads === 1) {
        await adapter.createLogs([
          {
            body: { metadata: { index: "late" } },
            entityId,
            roomId,
            type: "export-snapshot",
          },
        ]);
      }
      return rows;
    };

    const bundle = await exportAgent(source.runtime, PASSWORD, {
      includeLogs: true,
    });
    const imported = await importAgent(target.runtime, bundle, PASSWORD);

    expect(imported.counts.logs).toBe(SEEDED_LOGS);
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
}, 300_000);
