/**
 * Check status action for the Zalo User plugin.
 *
 * Checks the authentication and connection status of the Zalo personal account.
 * Maps to the classic "status" tool action.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ZALOUSER_SERVICE_NAME } from "../constants";
import type { ZaloUserService } from "../service";

export const CHECK_STATUS_ACTION = "ZALOUSER_CHECK_STATUS";

export const checkStatusAction: Action = {
  name: CHECK_STATUS_ACTION,
  similes: [
    "ZALOUSER_STATUS",
    "ZALO_STATUS",
    "ZALO_CHECK_AUTH",
    "ZALO_CONNECTION_STATUS",
    "ZALO_IS_CONNECTED",
  ],
  description:
    "Check the authentication and connection status of the Zalo personal account",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const service = await runtime.getService(ZALOUSER_SERVICE_NAME);
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = await runtime.getService(ZALOUSER_SERVICE_NAME) as
      | ZaloUserService
      | undefined;

    if (!service) {
      if (callback) {
        await callback({ text: "Zalo User service not available" });
      }
      return { success: false, error: "Zalo User service not initialized" };
    }

    const probe = await service.probeZaloUser();

    if (!probe.ok) {
      if (callback) {
        await callback({
          text: `Zalo Status: Disconnected\nError: ${probe.error}\nLatency: ${probe.latencyMs}ms`,
        });
      }
      return {
        success: true,
        data: {
          action: CHECK_STATUS_ACTION,
          connected: false,
          error: probe.error,
          latencyMs: probe.latencyMs,
        },
      };
    }

    const lines: string[] = [
      "Zalo Status: Connected",
      `  User: ${probe.user?.displayName || "Unknown"} (${probe.user?.id || "?"})`,
      `  Listener: ${service.isRunning() ? "Running" : "Stopped"}`,
      `  Latency: ${probe.latencyMs}ms`,
    ];

    if (callback) {
      await callback({ text: lines.join("\n") });
    }

    return {
      success: true,
      data: {
        action: CHECK_STATUS_ACTION,
        connected: true,
        running: service.isRunning(),
        user: probe.user,
        latencyMs: probe.latencyMs,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Is Zalo connected?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me check the Zalo connection status.",
          actions: [CHECK_STATUS_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Check Zalo auth status" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Checking Zalo authentication status.",
          actions: [CHECK_STATUS_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
