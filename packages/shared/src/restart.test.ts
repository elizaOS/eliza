/**
 * Exercises restart delegation and asynchronous completion with registered
 * handlers and a controlled promise; no process exits occur in this suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestRestart, setRestartHandler } from "./restart.js";

describe("restart", () => {
  afterEach(() => setRestartHandler(() => {}));

  it("forwards restart request and reason to the registered handler", () => {
    const handler = vi.fn();
    setRestartHandler(handler);
    requestRestart("reload configuration");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("reload configuration");
  });

  it("waits for asynchronous restart completion", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const handler = vi.fn(() => promise);
    setRestartHandler(handler);
    let finished = false;
    const result = Promise.resolve(requestRestart("graceful shutdown")).then(
      () => {
        finished = true;
      },
    );
    await Promise.resolve();
    expect(finished).toBe(false);
    resolve();
    await result;
    expect(finished).toBe(true);
    expect(handler).toHaveBeenCalledWith("graceful shutdown");
  });
});
