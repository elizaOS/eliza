/**
 * Routing and zone action tests for structured command parameters.
 *
 * They verify routing and zone mutations come from action options rather than
 * parsed prose.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ZoneManager } from "../router";
import { manageRouting } from "./manageRouting";
import { manageZones } from "./manageZones";

function message(text: string): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

function runtime(service: unknown): IAgentRuntime {
  return {
    getService: vi.fn((name: string) => (name === "music" ? service : null)),
  } as unknown as IAgentRuntime;
}

function routingService() {
  const zoneManager = new ZoneManager();
  let mode: "simulcast" | "independent" = "independent";
  const startBroadcastRoute = vi.fn(
    async (
      sourceId: string,
      targetIds: string[],
      routeMode: "simulcast" | "independent" = mode,
    ) => ({ sourceId, targetIds, mode: routeMode }),
  );
  const stopBroadcastRoute = vi.fn(async () => undefined);
  return {
    getAudioRouter: vi.fn(() => ({})),
    getZoneManager: vi.fn(() => zoneManager),
    setRoutingMode: vi.fn((next: "simulcast" | "independent") => {
      mode = next;
    }),
    getRoutingMode: vi.fn(() => mode),
    listRoutingTargets: vi.fn(() => ["speaker-a", "speaker-b"]),
    startBroadcastRoute,
    stopBroadcastRoute,
    getRoutingStatus: vi.fn(() => ({
      mode,
      activeRoutes: [],
      registeredTargets: ["speaker-a", "speaker-b"],
      zoneCount: zoneManager.count(),
    })),
  };
}

describe("music routing and zone structured params", () => {
  it("routes by structured routing params instead of message text", async () => {
    const service = routingService();
    const callback = vi.fn();

    const result = await manageRouting.handler?.(
      runtime(service),
      message("please do whatever"),
      undefined,
      {
        parameters: {
          routingAction: "start_route",
          sourceId: "main-stream",
          targetIds: ["speaker-a"],
          mode: "simulcast",
        },
      },
      callback,
    );

    expect(result).toMatchObject({ success: true });
    expect(service.startBroadcastRoute).toHaveBeenCalledWith(
      "main-stream",
      ["speaker-a"],
      "simulcast",
    );
  });

  it("accepts singular structured routing targetId", async () => {
    const service = routingService();

    const result = await manageRouting.handler?.(
      runtime(service),
      message("ignore routing prose"),
      undefined,
      {
        parameters: {
          routingAction: "start_route",
          sourceId: "main-stream",
          targetId: "speaker-a",
        },
      },
      vi.fn(),
    );

    expect(result).toMatchObject({ success: true });
    expect(service.startBroadcastRoute).toHaveBeenCalledWith(
      "main-stream",
      ["speaker-a"],
      "independent",
    );
  });

  it("does not parse routing commands from natural-language message text", async () => {
    const service = routingService();
    const result = await manageRouting.handler?.(
      runtime(service),
      message("set mode simulcast"),
      undefined,
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      success: false,
      data: expect.objectContaining({
        error: "UNRECOGNIZED_ROUTING_COMMAND",
      }),
    });
    expect(service.setRoutingMode).not.toHaveBeenCalled();
  });

  it("updates zones by structured params instead of message text", async () => {
    const zoneManager = new ZoneManager();
    const service = { getZoneManager: vi.fn(() => zoneManager) };

    const result = await manageZones.handler?.(
      runtime(service),
      message("ignore the text"),
      undefined,
      {
        parameters: {
          operation: "create",
          zoneName: "main-stage",
          targetIds: ["speaker-a", "speaker-b"],
        },
      },
      vi.fn(),
    );

    expect(result).toMatchObject({ success: true });
    expect(zoneManager.get("main-stage")?.targetIds).toEqual([
      "speaker-a",
      "speaker-b",
    ]);
  });

  it("updates zones by singular structured targetId", async () => {
    const zoneManager = new ZoneManager();
    zoneManager.create("main-stage", ["speaker-a"]);
    const service = { getZoneManager: vi.fn(() => zoneManager) };

    const addResult = await manageZones.handler?.(
      runtime(service),
      message("ignore the text"),
      undefined,
      {
        parameters: {
          operation: "add",
          zoneName: "main-stage",
          targetId: "speaker-b",
        },
      },
      vi.fn(),
    );
    const removeResult = await manageZones.handler?.(
      runtime(service),
      message("ignore the text"),
      undefined,
      {
        parameters: {
          operation: "remove",
          zoneName: "main-stage",
          targetId: "speaker-a",
        },
      },
      vi.fn(),
    );

    expect(addResult).toMatchObject({ success: true });
    expect(removeResult).toMatchObject({ success: true });
    expect(zoneManager.get("main-stage")?.targetIds).toEqual(["speaker-b"]);
  });

  it("does not parse zone commands from natural-language message text", async () => {
    const zoneManager = new ZoneManager();
    const service = { getZoneManager: vi.fn(() => zoneManager) };

    const result = await manageZones.handler?.(
      runtime(service),
      message("create zone main-stage with speaker-a"),
      undefined,
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      success: false,
      data: expect.objectContaining({
        error: "UNRECOGNIZED_ZONE_COMMAND",
      }),
    });
    expect(zoneManager.get("main-stage")).toBeUndefined();
  });
});
