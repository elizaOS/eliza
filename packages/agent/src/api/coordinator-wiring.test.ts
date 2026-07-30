/**
 * Exercises coordinator bridge wiring against the real AgentRuntime service
 * registry, including parallel bridge setup and optional-plugin absence.
 */

import {
  AgentRuntime,
  SWARM_COORDINATOR_SERVICE_TYPE,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { wireCoordinatorBridgesWhenReady } from "./coordinator-wiring.ts";

function createRuntime(): AgentRuntime {
  return new AgentRuntime({
    agentId: stringToUuid("coordinator-wiring-test"),
    character: { name: "coordinator-wiring-test" },
  });
}

describe("wireCoordinatorBridgesWhenReady", () => {
  it("skips an unregistered optional coordinator without polling", async () => {
    const runtime = createRuntime();
    const wire = vi.fn(() => true);
    const debug = vi.fn();

    const result = await wireCoordinatorBridgesWhenReady(
      { runtime },
      {
        wireChatBridge: wire,
        wireWsBridge: wire,
        wireEventRouting: wire,
        context: "test",
        logger: { warn: vi.fn(), debug },
      },
    );

    expect(result).toEqual({
      chat: false,
      ws: false,
      eventRouting: false,
      swarmSynthesis: false,
    });
    expect(wire).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("is not registered"),
    );
  });

  it("awaits the real service registry and wires every bridge concurrently", async () => {
    const runtime = createRuntime();
    runtime.registerServiceInstance(SWARM_COORDINATOR_SERVICE_TYPE, {
      capabilityDescription: "test coordinator",
      stop: async () => {},
    });
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = (name: string) => async () => {
      started.push(name);
      await gate;
      return true;
    };

    const pending = wireCoordinatorBridgesWhenReady(
      { runtime },
      {
        wireChatBridge: bridge("chat"),
        wireWsBridge: bridge("ws"),
        wireEventRouting: bridge("eventRouting"),
        wireSwarmSynthesis: bridge("swarmSynthesis"),
        context: "test",
        logger: { warn: vi.fn(), debug: vi.fn() },
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["chat", "ws", "eventRouting", "swarmSynthesis"]);
    release?.();
    await expect(pending).resolves.toEqual({
      chat: true,
      ws: true,
      eventRouting: true,
      swarmSynthesis: true,
    });
    await runtime.stop();
  });

  it("treats requested synthesis as required and broadcasts an honest warning", async () => {
    const runtime = createRuntime();
    runtime.registerServiceInstance(SWARM_COORDINATOR_SERVICE_TYPE, {
      capabilityDescription: "test coordinator",
      stop: async () => {},
    });
    const broadcastWs = vi.fn();
    const warn = vi.fn();

    const result = await wireCoordinatorBridgesWhenReady(
      { runtime, broadcastWs },
      {
        wireChatBridge: () => true,
        wireWsBridge: () => true,
        wireEventRouting: () => true,
        wireSwarmSynthesis: () => false,
        context: "test",
        logger: { warn },
      },
    );

    expect(result.swarmSynthesis).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("swarm-synthesis"),
    );
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system-warning",
        message: expect.stringContaining("swarm-synthesis"),
      }),
    );
    await runtime.stop();
  });
});
