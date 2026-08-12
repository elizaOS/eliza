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
  it("passes the room lease to the handler without serializing it", async () => {
    const lease = { release: async () => {} };
    let observedOptions: unknown;
    const action = {
      name: "LEASE_PROBE",
      handler: async (...args: unknown[]) => {
        observedOptions = args[3];
        return { success: true };
      },
    };
    const runtime = { actions: [action] } as unknown as Parameters<
      typeof attachInterceptor
    >[0];
    const interceptor = attachInterceptor(runtime);
    const options = {
      parameters: { attachmentId: "attachment-1" },
      actionContext: {
        previousResults: [{ success: true }],
        getPreviousResult: () => undefined,
      },
      customContext: { traceId: "trace-1" },
      roomHandlerLease: lease,
    };

    await (action.handler as (...args: unknown[]) => Promise<unknown>)(
      runtime,
      { roomId: "room-1" },
      undefined,
      options,
    );

    expect(observedOptions).toBe(options);
    expect(interceptor.actions).toHaveLength(1);
    expect(interceptor.actions[0]?.parameters).toEqual({
      parameters: { attachmentId: "attachment-1" },
      actionContext: { previousResults: [{ success: true }] },
      customContext: { traceId: "trace-1" },
    });
    expect(interceptor.actions[0]?.parameters).not.toHaveProperty(
      "roomHandlerLease",
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
