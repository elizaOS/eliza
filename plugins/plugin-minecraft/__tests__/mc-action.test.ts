import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { minecraftAction } from "../src/actions/index.js";
import { minecraftWaypointsProvider } from "../src/providers/index.js";
import { MINECRAFT_SERVICE_TYPE } from "../src/services/minecraft-service.js";
import { WAYPOINTS_SERVICE_TYPE } from "../src/services/waypoints-service.js";

function memory(text: string): Memory {
  return {
    content: { text, source: "test" },
    entityId: "entity-1" as UUID,
    agentId: "agent-1" as UUID,
    roomId: "room-1" as UUID,
  } as Memory;
}

function runtimeWithServices(services: Record<string, unknown>): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    getService: vi.fn((name: string) => services[name] ?? null),
    getSetting: vi.fn(),
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

describe("MC_ACTION", () => {
  it("routes movement goto through the Minecraft service", async () => {
    const mc = { request: vi.fn().mockResolvedValue({}) };
    const runtime = runtimeWithServices({ [MINECRAFT_SERVICE_TYPE]: mc });

    const result = await minecraftAction.handler(runtime, memory("move"), undefined, {
      parameters: { subaction: "movement", operation: "goto", x: 10, y: 64, z: -20 },
    });

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Moving to");
    expect(mc.request).toHaveBeenCalledWith("goto", { x: 10, y: 64, z: -20 });
  });

  it("routes scan and returns result count", async () => {
    const mc = {
      request: vi.fn().mockResolvedValue({ blocks: [{ name: "oak_log" }, { name: "stone" }] }),
    };
    const runtime = runtimeWithServices({ [MINECRAFT_SERVICE_TYPE]: mc });

    const result = await minecraftAction.handler(runtime, memory("scan nearby blocks"), undefined, {
      parameters: { subaction: "scan", blocks: ["oak_log"], radius: 8, maxResults: 4 },
    });

    expect(result?.success).toBe(true);
    expect(result?.values).toMatchObject({ count: 2 });
    expect(mc.request).toHaveBeenCalledWith("scan", {
      blocks: ["oak_log"],
      radius: 8,
      maxResults: 4,
    });
  });

  it("keeps waypoint list/read state in the provider surface", async () => {
    const waypoints = {
      listWaypoints: vi
        .fn()
        .mockReturnValue([
          { name: "Home", x: 1, y: 65, z: 2, createdAt: new Date("2026-01-01T00:00:00Z") },
        ]),
    };
    const runtime = runtimeWithServices({ [WAYPOINTS_SERVICE_TYPE]: waypoints });

    const result = await minecraftAction.handler(runtime, memory("list waypoints"), undefined, {
      parameters: { subaction: "waypoints", operation: "list" },
    });

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("MC_WAYPOINTS");
    expect(result?.data).toMatchObject({ waypointCount: 1 });

    const providerResult = await minecraftWaypointsProvider.get(runtime, memory(""));
    expect(providerResult.text).toContain("Home");
    expect(providerResult.values).toMatchObject({ count: 1 });
  });
});
