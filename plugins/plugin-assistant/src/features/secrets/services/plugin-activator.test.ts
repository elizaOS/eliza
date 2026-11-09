/**
 * PluginActivator polls for secrets only while a plugin waits for them. An
 * idle activator holds no timer, and a pending one does not keep the process
 * alive. The SECRETS service is a stub whose missing-key answer the test sets.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PluginActivatorService } from "./plugin-activator.ts";

let missing: string[] = ["PENDING_API_KEY"];

function createRuntime(): IAgentRuntime {
  const secrets = {
    onAnySecretChanged: () => () => {},
    getMissingSecrets: async () => missing,
    checkPluginRequirements: async () => ({
      ready: missing.length === 0,
      missingRequired: missing,
      missingOptional: [],
      invalid: [],
    }),
  };
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: (name: string) => (name === "SECRETS" ? secrets : null),
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  missing = ["PENDING_API_KEY"];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("polls only while a plugin waits for its secrets", async () => {
  const activator = await PluginActivatorService.start(createRuntime(), {
    pollingIntervalMs: 1000,
    maxWaitMs: 0,
  });
  expect(vi.getTimerCount()).toBe(0);

  const activated = vi.fn(async () => {});
  const ready = await activator.registerPlugin(
    {
      name: "pending-plugin",
      description: "Waits for a key",
      requiredSecrets: {
        PENDING_API_KEY: {
          description: "Key",
          type: "api_key",
          required: true,
        },
      },
    },
    activated,
  );
  expect(ready).toBe(false);
  expect(activator.isPending("pending-plugin")).toBe(true);
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(1000);
  expect(activated).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);

  missing = [];
  await vi.advanceTimersByTimeAsync(1000);
  expect(activated).toHaveBeenCalledTimes(1);
  expect(activator.isPending("pending-plugin")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);

  await activator.stop();
});
