/**
 * Unit tests for action and connector-dispatch evidence captured by the
 * scenario interceptor.
 */
import type { Action, IAgentRuntime } from "@elizaos/core";
import type { CapturedConnectorDispatch } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  attachInterceptor,
  captureConnectorDispatchesFromAction,
} from "./interceptor.ts";

describe("action parameter capture", () => {
  it("omits runtime action-context callbacks without mutating handler options", async () => {
    const getPreviousResult = () => undefined;
    const options = {
      parameters: { action: "interact", view: "scenario-active-ledger" },
      actionContext: {
        previousResults: [],
        getPreviousResult,
      },
    };
    const action = {
      name: "VIEWS",
      description: "Scenario action",
      validate: async () => true,
      handler: async () => ({ success: true }),
    } as Action;
    const runtime = { actions: [action] } as unknown as IAgentRuntime;
    const interceptor = attachInterceptor(runtime);

    await action.handler(
      runtime,
      {} as never,
      undefined,
      options as never,
      undefined,
    );

    expect(interceptor.actions).toHaveLength(1);
    expect(interceptor.actions[0]?.parameters).toEqual({
      parameters: options.parameters,
      actionContext: { previousResults: [] },
    });
    expect(options.actionContext.getPreviousResult).toBe(getPreviousResult);
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
