/**
 * Unit tests for ToolCallEventLog helpers: validates event state derivation and naming.
 */
import { describe, expect, it } from "vitest";
import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import {
  getToolCallEventDisplayState,
  getToolCallName,
} from "./ToolCallEventLog.helpers.ts";

describe("ToolCallEventLog.helpers", () => {
  it("derives failure state for errors or failed status", () => {
    const ev1: NativeToolCallEvent = {
      error: "failed",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev1)).toBe("failure");

    const ev2: NativeToolCallEvent = {
      status: "failed",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev2)).toBe("failure");
  });

  it("derives success state for completed status or success flag", () => {
    const ev1: NativeToolCallEvent = {
      status: "completed",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev1)).toBe("success");

    const ev2: NativeToolCallEvent = {
      success: true,
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev2)).toBe("success");
  });

  it("defaults to running state for in-flight events", () => {
    const ev: NativeToolCallEvent = {
      status: "started",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev)).toBe("running");
  });

  it("resolves tool call name from available event fields", () => {
    expect(
      getToolCallName({
        actionName: "git_commit",
      } as unknown as NativeToolCallEvent),
    ).toBe("git_commit");
    expect(
      getToolCallName({ toolName: "bash" } as unknown as NativeToolCallEvent),
    ).toBe("bash");
    expect(
      getToolCallName({ name: "edit" } as unknown as NativeToolCallEvent),
    ).toBe("edit");
    expect(getToolCallName({} as unknown as NativeToolCallEvent)).toBe("tool");
  });

  it("derives failure state from the tool_error event type", () => {
    const ev: NativeToolCallEvent = { id: "e1", type: "tool_error" };
    expect(getToolCallEventDisplayState(ev)).toBe("failure");
  });

  it("keeps failure precedence over success signals", () => {
    const byError: NativeToolCallEvent = {
      id: "e2",
      type: "tool_call",
      success: true,
      error: "boom",
    };
    expect(getToolCallEventDisplayState(byError)).toBe("failure");

    const byStatus: NativeToolCallEvent = {
      id: "e3",
      type: "tool_error",
      status: "completed",
    };
    expect(getToolCallEventDisplayState(byStatus)).toBe("failure");
  });

  it("derives success state from the tool_result event type", () => {
    const ev: NativeToolCallEvent = { id: "s1", type: "tool_result" };
    expect(getToolCallEventDisplayState(ev)).toBe("success");
  });

  it("does not treat success=false as success", () => {
    const ev: NativeToolCallEvent = {
      id: "r1",
      type: "tool_call",
      status: "running",
      success: false,
    };
    expect(getToolCallEventDisplayState(ev)).toBe("running");
  });

  it("falls back through callId and toolCallId before the default", () => {
    expect(
      getToolCallName({ id: "n1", type: "tool_call", callId: "call-9" }),
    ).toBe("call-9");
    expect(
      getToolCallName({ id: "n2", type: "tool_call", toolCallId: "tc-4" }),
    ).toBe("tc-4");
  });

  it("prefers earlier name fields when several are populated", () => {
    const ev: NativeToolCallEvent = {
      id: "n3",
      type: "tool_call",
      actionName: "deploy",
      toolName: "bash",
      name: "edit",
      callId: "call-1",
      toolCallId: "tc-2",
    };
    expect(getToolCallName(ev)).toBe("deploy");
  });

  it("skips empty-string names in the fallback chain", () => {
    const ev: NativeToolCallEvent = {
      id: "n4",
      type: "tool_call",
      actionName: "",
      toolName: "",
      name: "edit",
    };
    expect(getToolCallName(ev)).toBe("edit");
  });
});
