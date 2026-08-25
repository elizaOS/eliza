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
});
