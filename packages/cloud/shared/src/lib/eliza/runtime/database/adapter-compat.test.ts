import { describe, expect, test } from "bun:test";
import type { IDatabaseAdapter, Log, UUID } from "@elizaos/core";
import { applyLegacyDatabaseAdapterCompat } from "./adapter-compat";

const roomA = "00000000-0000-0000-0000-00000000000a" as UUID;
const entity = "00000000-0000-0000-0000-0000000000e1" as UUID;

function log(id: string, type: string, createdAt: number): Log {
  return {
    id: id as UUID,
    entityId: entity,
    roomId: roomA,
    type,
    body: { prompt: "large prompt", response: "large response" },
    createdAt: new Date(createdAt),
  };
}

describe("applyLegacyDatabaseAdapterCompat getLogInventory", () => {
  test("projects getLogs rows in order, without bodies, minus excluded types", async () => {
    const rows = [
      log("00000000-0000-0000-0000-000000000003", "model", 3000),
      log("00000000-0000-0000-0000-000000000002", "role_audit", 2000),
      log("00000000-0000-0000-0000-000000000001", "action", 1000),
    ];
    const calls: unknown[] = [];
    const adapter = applyLegacyDatabaseAdapterCompat({
      getLogs: async (params: unknown) => {
        calls.push(params);
        return rows;
      },
    } as unknown as IDatabaseAdapter);

    const inventory = await adapter.getLogInventory({ excludeTypes: ["role_audit"] });

    expect(calls).toEqual([{ limit: Number.MAX_SAFE_INTEGER }]);
    expect(inventory).toEqual([
      { id: rows[0].id, roomId: roomA, createdAt: rows[0].createdAt },
      { id: rows[2].id, roomId: roomA, createdAt: rows[2].createdAt },
    ]);
  });

  test("returns an empty inventory when the adapter has no getLogs", async () => {
    const adapter = applyLegacyDatabaseAdapterCompat({} as unknown as IDatabaseAdapter);
    expect(await adapter.getLogInventory({})).toEqual([]);
  });

  test("keeps an adapter's own getLogInventory", async () => {
    const own = async () => [];
    const adapter = applyLegacyDatabaseAdapterCompat({
      getLogInventory: own,
    } as unknown as IDatabaseAdapter);
    expect(adapter.getLogInventory).toBe(own);
  });
});
