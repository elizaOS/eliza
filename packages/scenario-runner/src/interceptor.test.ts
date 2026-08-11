/** Tests action-option and connector-dispatch capture at the scenario report boundary. */
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import type { CapturedConnectorDispatch } from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import {
  attachInterceptor,
  captureConnectorDispatchesFromAction,
} from "./interceptor.ts";

describe("attachInterceptor handler-option capture", () => {
  it("excludes the room lease while preserving ordinary handler context and parameters", async () => {
    const capabilityMarker = "opaque-room-lease-must-not-enter-report";
    const action: Action = {
      name: "MESSAGE",
      description: "Send a message",
      validate: async () => true,
      handler: async () => ({
        success: true,
        text: "sent",
        data: { channel: "sms" },
      }),
    };
    const runtime = { actions: [action] } as unknown as IAgentRuntime;
    const interceptor = attachInterceptor(runtime);
    const message = {
      id: "00000000-0000-0000-0000-000000000201" as UUID,
      entityId: "00000000-0000-0000-0000-000000000202" as UUID,
      roomId: "00000000-0000-0000-0000-000000000203" as UUID,
      content: { text: "send it" },
    } as Memory;
    const options = {
      parameters: { channel: "sms", body: "hello" },
      actionContext: {
        previousResults: [{ success: true, data: { actionName: "PREPARE" } }],
        getPreviousResult: vi.fn(),
      },
      context: { source: "planned-tool" },
      roomHandlerLease: {
        release: vi.fn(async () => {}),
        capabilityMarker,
      },
    } as HandlerOptions;

    await action.handler(runtime, message, undefined, options);

    expect(interceptor.actions).toEqual([
      expect.objectContaining({
        actionName: "MESSAGE",
        parameters: {
          parameters: { channel: "sms", body: "hello" },
          actionContext: {
            previousResults: [
              { success: true, data: { actionName: "PREPARE" } },
            ],
          },
          context: { source: "planned-tool" },
        },
      }),
    ]);
    expect(interceptor.connectorDispatches).toEqual([
      expect.objectContaining({
        channel: "sms",
        payload: { channel: "sms", body: "hello" },
        delivered: true,
      }),
    ]);
    expect(
      JSON.stringify({
        actions: interceptor.actions,
        connectorDispatches: interceptor.connectorDispatches,
      }),
    ).not.toContain("roomHandlerLease");
    expect(JSON.stringify(interceptor.actions)).not.toContain(capabilityMarker);
    interceptor.detach();
  });
});

describe("captureConnectorDispatchesFromAction delivered default", () => {
  it("marks delivered=true only when the action reports success: true", () => {
    const dispatches: CapturedConnectorDispatch[] = [];
    captureConnectorDispatchesFromAction(
      dispatches,
      "MESSAGE",
      { channel: "sms" },
      { success: true, data: {} },
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.delivered).toBe(true);
  });

  it("marks delivered=false when the action reports success: false", () => {
    const dispatches: CapturedConnectorDispatch[] = [];
    captureConnectorDispatchesFromAction(
      dispatches,
      "MESSAGE",
      { channel: "sms" },
      { success: false, data: {} },
    );
    expect(dispatches[0]!.delivered).toBe(false);
  });

  it("defaults delivered to false when no boolean success is present", () => {
    // Absent an explicit boolean success, delivered stays false so a
    // "messageDelivered" final check cannot pass on a handler that never
    // reported success. Mirrors the action-result success capture (undefined,
    // never true).
    const dispatches: CapturedConnectorDispatch[] = [];
    captureConnectorDispatchesFromAction(
      dispatches,
      "MESSAGE",
      { channel: "sms" },
      { data: {} },
    );
    expect(dispatches[0]!.delivered).toBe(false);
  });
});
