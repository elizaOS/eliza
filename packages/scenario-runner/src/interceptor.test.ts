import type { CapturedConnectorDispatch } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import { captureConnectorDispatchesFromAction } from "./interceptor.ts";

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
    // Previously this defaulted to true, letting a "messageDelivered" final
    // check pass on a handler that never reported success. The safe default
    // mirrors the action-result success capture (undefined, never true).
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
