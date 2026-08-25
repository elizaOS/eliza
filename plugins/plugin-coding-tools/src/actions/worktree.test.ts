import { beforeEach, describe, expect, it, vi } from "vitest";
import { worktreeAction } from "./worktree";

const h = vi.hoisted(() => ({
  format: {
    failureToActionResult: vi.fn(),
    readStringParam: vi.fn(),
  },
  enter: { enterWorktreeHandler: vi.fn() },
  exit: { exitWorktreeHandler: vi.fn() },
}));

vi.mock("../lib/format.js", () => ({
  failureToActionResult: h.format.failureToActionResult,
  readStringParam: h.format.readStringParam,
}));

vi.mock("../types.js", () => ({
  CODING_TOOLS_CONTEXTS: ["coding", "terminal"],
}));

vi.mock("./enter-worktree.js", () => ({
  enterWorktreeHandler: h.enter.enterWorktreeHandler,
}));

vi.mock("./exit-worktree.js", () => ({
  exitWorktreeHandler: h.exit.exitWorktreeHandler,
}));

const runtime = {} as never;
const message = { id: "m1" } as never;
const callback = vi.fn() as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.enter.enterWorktreeHandler.mockResolvedValue({
    success: true,
    action: "enter",
  });
  h.exit.exitWorktreeHandler.mockResolvedValue({
    success: true,
    action: "exit",
  });
});

describe("worktreeAction metadata", () => {
  it("declares the WORKTREE umbrella with an ADMIN role gate", () => {
    expect(worktreeAction.name).toBe("WORKTREE");
    expect(worktreeAction.similes).toContain("GIT_WORKTREE");
    expect(worktreeAction.roleGate).toEqual({ minRole: "ADMIN" });
    expect(worktreeAction.contexts).toEqual(["coding", "terminal"]);
    expect(worktreeAction.contextGate).toEqual({
      anyOf: ["coding", "terminal"],
    });
    expect(worktreeAction.parameters?.[0]?.name).toBe("action");
  });
});

describe("worktreeAction.handler dispatch", () => {
  it("routes action=enter to the enter handler and returns its result", async () => {
    h.format.readStringParam.mockReturnValue("enter");
    const options = { action: "enter", name: "feat/login" };
    const result = await worktreeAction.handler(
      runtime,
      message,
      undefined,
      options,
      callback,
    );
    expect(h.format.readStringParam).toHaveBeenCalledWith(options, "action");
    expect(h.enter.enterWorktreeHandler).toHaveBeenCalledWith(
      runtime,
      message,
      undefined,
      options,
      callback,
    );
    expect(result).toEqual({ success: true, action: "enter" });
  });

  it("routes action=exit to the exit handler", async () => {
    h.format.readStringParam.mockReturnValue("exit");
    const options = { action: "exit", cleanup: true };
    const result = await worktreeAction.handler(
      runtime,
      message,
      undefined,
      options,
      callback,
    );
    expect(h.exit.exitWorktreeHandler).toHaveBeenCalledWith(
      runtime,
      message,
      undefined,
      options,
      callback,
    );
    expect(result).toEqual({ success: true, action: "exit" });
  });

  it.each(["add", "open", "create"])(
    "normalizes the %s alias to action=enter",
    async (alias) => {
      h.format.readStringParam.mockReturnValue(alias);
      await worktreeAction.handler(
        runtime,
        message,
        undefined,
        { action: alias },
        callback,
      );
      expect(h.enter.enterWorktreeHandler).toHaveBeenCalledTimes(1);
      expect(h.exit.exitWorktreeHandler).not.toHaveBeenCalled();
    },
  );

  it.each(["leave", "pop", "remove"])(
    "normalizes the %s alias to action=exit",
    async (alias) => {
      h.format.readStringParam.mockReturnValue(alias);
      await worktreeAction.handler(
        runtime,
        message,
        undefined,
        { action: alias },
        callback,
      );
      expect(h.exit.exitWorktreeHandler).toHaveBeenCalledTimes(1);
      expect(h.enter.enterWorktreeHandler).not.toHaveBeenCalled();
    },
  );

  it("case-normalizes and hyphen-normalizes the raw action", async () => {
    h.format.readStringParam.mockReturnValue("  ADD  ");
    await worktreeAction.handler(
      runtime,
      message,
      undefined,
      { action: "  ADD  " },
      callback,
    );
    expect(h.enter.enterWorktreeHandler).toHaveBeenCalledTimes(1);
  });

  it("fails closed with missing_param for an unknown operation", async () => {
    h.format.readStringParam.mockReturnValue("fly");
    h.format.failureToActionResult.mockReturnValue({
      success: false,
      reason: "missing_param",
      message: "WORKTREE requires action=enter/exit",
    });
    const result = await worktreeAction.handler(
      runtime,
      message,
      undefined,
      { action: "fly" },
      callback,
    );
    expect(h.format.failureToActionResult).toHaveBeenCalledWith({
      reason: "missing_param",
      message: "WORKTREE requires action=enter/exit",
    });
    expect(result).toEqual({
      success: false,
      reason: "missing_param",
      message: "WORKTREE requires action=enter/exit",
    });
    expect(h.enter.enterWorktreeHandler).not.toHaveBeenCalled();
    expect(h.exit.exitWorktreeHandler).not.toHaveBeenCalled();
  });

  it("fails closed when the action parameter is absent", async () => {
    h.format.readStringParam.mockReturnValue(undefined);
    await worktreeAction.handler(runtime, message, undefined, {}, callback);
    expect(h.format.failureToActionResult).toHaveBeenCalled();
    expect(h.enter.enterWorktreeHandler).not.toHaveBeenCalled();
  });

  it("fails closed when the action parameter is an empty string", async () => {
    h.format.readStringParam.mockReturnValue("");
    await worktreeAction.handler(
      runtime,
      message,
      undefined,
      { action: "   " },
      callback,
    );
    expect(h.format.failureToActionResult).toHaveBeenCalled();
    expect(h.exit.exitWorktreeHandler).not.toHaveBeenCalled();
  });

  it("propagates handler failures to the caller", async () => {
    h.format.readStringParam.mockReturnValue("enter");
    h.enter.enterWorktreeHandler.mockRejectedValue(
      new Error("worktree exists"),
    );
    await expect(
      worktreeAction.handler(
        runtime,
        message,
        undefined,
        { action: "enter" },
        callback,
      ),
    ).rejects.toThrow("worktree exists");
  });
});

describe("worktreeAction.summarize", () => {
  it("summarizes successful worktree management", () => {
    expect(
      worktreeAction.summarize?.({ success: true, action: "enter" } as never),
    ).toBe("managed a git worktree");
  });

  it("returns undefined for failed results", () => {
    expect(
      worktreeAction.summarize?.({ success: false } as never),
    ).toBeUndefined();
  });
});

describe("worktreeAction.validate", () => {
  it("accepts the action", async () => {
    await expect(worktreeAction.validate?.({} as never)).resolves.toBe(true);
  });
});
