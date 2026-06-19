import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { minecraftAction } from "../src/actions/index.js";
import { minecraftVisionProvider, minecraftWaypointsProvider } from "../src/providers/index.js";
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
  } as IAgentRuntime;
}

describe("MC_ACTION", () => {
  it("routes movement goto through the Minecraft service", async () => {
    const mc = { request: vi.fn().mockResolvedValue({}) };
    const runtime = runtimeWithServices({ [MINECRAFT_SERVICE_TYPE]: mc });

    const result = await minecraftAction.handler(runtime, memory("move"), undefined, {
      parameters: { op: "goto", x: 10, y: 64, z: -20 },
    });

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Moving to");
    expect(mc.request).toHaveBeenCalledWith("goto", { x: 10, y: 64, z: -20 });
  });

  it("routes scan and returns result count", async () => {
    const mc = {
      getWorldState: vi.fn().mockResolvedValue({
        connected: true,
        biome: { name: "plains" },
        position: { x: 10, y: 64, z: -20 },
        lookingAt: { name: "grass_block", position: { x: 10, y: 63, z: -19 } },
        nearbyEntities: [],
      }),
      request: vi.fn().mockResolvedValue({ blocks: [{ name: "oak_log" }, { name: "stone" }] }),
    };
    const runtime = runtimeWithServices({ [MINECRAFT_SERVICE_TYPE]: mc });

    const result = await minecraftVisionProvider.get(runtime, memory("scan nearby blocks"));

    expect(result.text).toContain("NearbyBlocksFound: 2");
    expect(result?.values).toMatchObject({ connected: true, blocksFound: 2 });
    expect(mc.request).toHaveBeenCalledWith("scan", {
      blocks: expect.arrayContaining(["oak_log", "stone"]),
      radius: 16,
      maxResults: 24,
    });
  });

  it("keeps waypoint list/read state in the provider surface", async () => {
    const mc = { request: vi.fn().mockResolvedValue({}) };
    const waypoints = {
      getWaypoint: vi.fn().mockReturnValue({
        name: "Home",
        x: 1,
        y: 65,
        z: 2,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
      listWaypoints: vi
        .fn()
        .mockReturnValue([
          { name: "Home", x: 1, y: 65, z: 2, createdAt: new Date("2026-01-01T00:00:00Z") },
        ]),
    };
    const runtime = runtimeWithServices({
      [MINECRAFT_SERVICE_TYPE]: mc,
      [WAYPOINTS_SERVICE_TYPE]: waypoints,
    });

    const result = await minecraftAction.handler(
      runtime,
      memory("go to waypoint Home"),
      undefined,
      {
        parameters: { op: "waypoint_goto", name: "Home" },
      }
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain('Navigating to waypoint "Home"');
    expect(mc.request).toHaveBeenCalledWith("goto", { x: 1, y: 65, z: 2 });

    const providerResult = await minecraftWaypointsProvider.get(runtime, memory(""));
    expect(providerResult.text).toContain("Home");
    expect(providerResult.values).toMatchObject({ count: 1 });
  });
});
