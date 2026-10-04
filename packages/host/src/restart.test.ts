import { describe, expect, it } from "vitest";
import {
  requestRestart,
  requireRestartHandler,
  setRestartHandler,
} from "./restart.js";

describe("host restart dispatch", () => {
  it("requires a handler and preserves its completion and failures", async () => {
    expect(() => requestRestart("startup")).toThrowError(
      expect.objectContaining({ code: "RESTART_HANDLER_NOT_INSTALLED" }),
    );
    expect(() => requireRestartHandler()).toThrowError(
      expect.objectContaining({ code: "RESTART_HANDLER_NOT_INSTALLED" }),
    );
    let reason: string | undefined;
    const completion = Promise.resolve();
    setRestartHandler((value) => {
      reason = value;
      return completion;
    });
    const admittedRestart = requireRestartHandler();
    expect(requestRestart("configuration changed")).toBe(completion);
    expect(reason).toBe("configuration changed");
    const failure = new Error("host restart failed");
    setRestartHandler(() => {
      throw failure;
    });
    expect(() => requestRestart()).toThrow(failure);
    expect(admittedRestart("admitted before handler replacement")).toBe(
      completion,
    );
    expect(reason).toBe("admitted before handler replacement");
    setRestartHandler(() => Promise.reject(failure));
    await expect(requestRestart()).rejects.toBe(failure);
  });
});
