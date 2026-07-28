/**
 * Verifies that the TASKS action survives the runtime's asynchronous service-start boundary.
 */

import type { IAgentRuntime, Memory, Service } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

const ACP_SERVICE_TYPE = "ACP_SUBPROCESS_SERVICE";
const LIST_AGENTS_MESSAGE = {
  content: {
    text: "List the active coding agents.",
    action: "list_agents",
  },
} as unknown as Memory;

describe("TASKS service readiness", () => {
  it("waits for the registered ACP service before validating", async () => {
    const acpService = {} as Service;
    let loadCalls = 0;
    const runtime = {
      getService: () => null,
      hasService: (type: string) => type === ACP_SERVICE_TYPE,
      getServiceLoadPromise: async (type: string) => {
        expect(type).toBe(ACP_SERVICE_TYPE);
        loadCalls += 1;
        return acpService;
      },
    } as unknown as IAgentRuntime;

    await expect(
      tasksAction.validate(runtime, LIST_AGENTS_MESSAGE),
    ).resolves.toBe(true);
    expect(loadCalls).toBe(1);
  });

  it("does not expose TASKS when ACP startup fails", async () => {
    const runtime = {
      getService: () => null,
      hasService: (type: string) => type === ACP_SERVICE_TYPE,
      getServiceLoadPromise: async () => {
        throw new Error("startup failed");
      },
    } as unknown as IAgentRuntime;

    await expect(
      tasksAction.validate(runtime, LIST_AGENTS_MESSAGE),
    ).resolves.toBe(false);
  });

  it("does not attempt startup when the ACP service is not registered", async () => {
    let loadCalls = 0;
    const runtime = {
      getService: () => null,
      hasService: () => false,
      getServiceLoadPromise: async () => {
        loadCalls += 1;
        throw new Error("must not load");
      },
    } as unknown as IAgentRuntime;

    await expect(
      tasksAction.validate(runtime, LIST_AGENTS_MESSAGE),
    ).resolves.toBe(false);
    expect(loadCalls).toBe(0);
  });
});
