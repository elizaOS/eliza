/**
 * Verifies that the swarm coordinator uses the runtime-owned ACP service
 * lifecycle directly, including delayed startup, invalid contracts, and
 * startup failure.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.js";

function makeFakeAcp() {
  const handlers = new Set<
    (sessionId: string, event: string, data: unknown) => void
  >();
  return {
    acp: {
      onSessionEvent: vi.fn(
        (
          handler: (sessionId: string, event: string, data: unknown) => void,
        ) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      ),
    },
    subscriberCount: () => handlers.size,
  };
}

function makeRuntime(load: () => Promise<unknown>): IAgentRuntime {
  return {
    getService: vi.fn(() => null),
    getServiceLoadPromise: vi.fn((serviceType: string) => {
      if (serviceType !== AcpService.serviceType) {
        return Promise.reject(new Error(`Unexpected service ${serviceType}`));
      }
      return load();
    }),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("SwarmCoordinatorService ACP lifecycle", () => {
  it("awaits ACP startup without polling or elapsed-time thresholds", async () => {
    let resolveAcp: ((service: unknown) => void) | undefined;
    const load = new Promise<unknown>((resolve) => {
      resolveAcp = resolve;
    });
    const runtime = makeRuntime(() => load);
    const { acp, subscriberCount } = makeFakeAcp();

    const start = SwarmCoordinatorService.start(runtime);
    await Promise.resolve();
    expect(subscriberCount()).toBe(0);

    resolveAcp?.(acp);
    const service = await start;
    expect(runtime.getServiceLoadPromise).toHaveBeenCalledTimes(1);
    expect(subscriberCount()).toBe(1);
    expect(service.acpBindState).toMatchObject({
      status: "bound",
      attempts: 1,
      reason: null,
    });

    await service.stop();
    expect(subscriberCount()).toBe(0);
  });

  it("binds immediately when ACP is already running", async () => {
    const { acp, subscriberCount } = makeFakeAcp();
    const runtime = makeRuntime(async () => acp);

    const service = await SwarmCoordinatorService.start(runtime);

    expect(subscriberCount()).toBe(1);
    await service.stop();
  });

  it("fails fast with the ACP startup failure preserved as its cause", async () => {
    const dependencyError = new Error("acp subprocess crashed");
    const runtime = makeRuntime(async () => {
      throw dependencyError;
    });

    await expect(SwarmCoordinatorService.start(runtime)).rejects.toMatchObject({
      code: "SWARM_COORDINATOR_ACP_START_FAILED",
      cause: dependencyError,
      context: { serviceType: AcpService.serviceType },
    });
  });

  it("rejects an ACP instance without the session-event contract", async () => {
    const runtime = makeRuntime(async () => ({}));

    await expect(SwarmCoordinatorService.start(runtime)).rejects.toMatchObject({
      code: "SWARM_COORDINATOR_ACP_CONTRACT_INVALID",
    });
  });
});
