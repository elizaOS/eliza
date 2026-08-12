/**
 * Unit tests for scenario action capture, including connector-delivery truth
 * and the boundary between reportable handler input and live capabilities.
 */
import type { CapturedConnectorDispatch } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  attachInterceptor,
  captureConnectorDispatchesFromAction,
} from "./interceptor.ts";

describe("action option capture", () => {
  it("projects action input once while keeping the live room lease exact", async () => {
    const lease = { release: async () => {} };
    let observedParameterizedOptions: unknown;
    let observedMessageOptions: unknown;
    const parameterizedAction = {
      name: "LEASE_PROBE",
      handler: async (...args: unknown[]) => {
        observedParameterizedOptions = args[3];
        return { success: true };
      },
    };
    const parameterlessMessage = {
      name: "MESSAGE",
      handler: async (...args: unknown[]) => {
        observedMessageOptions = args[3];
        return { success: true, data: { channel: "sms" } };
      },
    };
    const runtime = {
      actions: [parameterizedAction, parameterlessMessage],
    } as unknown as Parameters<typeof attachInterceptor>[0];
    const interceptor = attachInterceptor(runtime);
    const parameterizedOptions = {
      parameters: {
        attachmentId: "attachment-1",
        roomHandlerLease: lease,
      },
      actionContext: {
        previousResults: [{ success: true }],
        getPreviousResult: () => undefined,
      },
      customContext: { traceId: "trace-1" },
      roomHandlerLease: lease,
    };
    const messageOptions = {
      actionContext: {
        previousResults: [],
        getPreviousResult: () => undefined,
      },
      roomHandlerLease: lease,
    };

    await (
      parameterizedAction.handler as (...args: unknown[]) => Promise<unknown>
    )(runtime, { roomId: "room-1" }, undefined, parameterizedOptions);
    await (
      parameterlessMessage.handler as (...args: unknown[]) => Promise<unknown>
    )(runtime, { roomId: "room-1" }, undefined, messageOptions);

    expect(observedParameterizedOptions).toBe(parameterizedOptions);
    expect(observedMessageOptions).toBe(messageOptions);
    expect(interceptor.actions).toHaveLength(2);
    expect(interceptor.actions[0]?.parameters).toEqual({
      attachmentId: "attachment-1",
    });
    expect(interceptor.actions[1]?.parameters).toBeUndefined();
    expect(interceptor.connectorDispatches).toHaveLength(1);
    expect(interceptor.connectorDispatches[0]).toMatchObject({
      actionName: "MESSAGE",
      channel: "sms",
      delivered: true,
      payload: { channel: "sms" },
    });

    // Captured parameters feed planner/judge text and the same object graph is
    // serialized into reports. No sink may receive the capability key, its
    // release function, or the empty object produced by function stripping.
    const reportJson = JSON.stringify({
      actions: interceptor.actions,
      connectorDispatches: interceptor.connectorDispatches,
    });
    expect(reportJson).not.toContain("roomHandlerLease");
    expect(reportJson).not.toContain('"release"');
    expect(reportJson).not.toContain("getPreviousResult");
    expect(reportJson).not.toContain("{}");
    expect(JSON.stringify(interceptor.actions[0]?.parameters)).toBe(
      '{"attachmentId":"attachment-1"}',
    );
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
