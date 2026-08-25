import { describe, expect, it, vi } from "vitest";
import { handleNoToolAvailable } from "./handler";

describe("handleNoToolAvailable", () => {
  it("returns a successful fallback result with default reasoning when no tool selection is given", async () => {
    const result = await handleNoToolAvailable(undefined, undefined);
    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({
      success: true,
      noToolAvailable: true,
      fallbackToDirectAssistance: true,
    });
    expect(result.data).toMatchObject({
      actionName: "MCP",
      op: "call_tool",
      noToolAvailable: true,
      reason: "No appropriate tool available",
    });
  });

  it("uses the tool selection reasoning when present", async () => {
    const result = await handleNoToolAvailable(undefined, {
      noToolAvailable: true,
      reasoning: "tool requires auth",
    });
    expect(result.data?.reason).toBe("tool requires auth");
  });

  it("does not invoke the callback when it is missing", async () => {
    const result = await handleNoToolAvailable(undefined, {
      noToolAvailable: true,
    });
    expect(result.success).toBe(true);
  });

  it("invokes the callback only when noToolAvailable is set", async () => {
    const callback = vi.fn();
    await handleNoToolAvailable(callback, { noToolAvailable: true });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("I don't have a specific tool"),
      actions: ["REPLY"],
    });

    callback.mockClear();
    await handleNoToolAvailable(callback, { noToolAvailable: false });
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns the same fallback text to the user", async () => {
    const result = await handleNoToolAvailable(undefined, {
      noToolAvailable: true,
      reasoning: "n/a",
    });
    expect(result.text).toContain("assist you directly instead");
  });
});
