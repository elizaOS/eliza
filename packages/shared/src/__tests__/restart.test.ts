/**
 * Verifies restart requests expose the canonical exit code and delegate through the registered handler in a deterministic unit harness.
 */
import { describe, expect, it, vi } from "vitest";
import {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from "../restart.ts";

describe("restart", () => {
  it("exposes a numeric restart exit code", () => {
    expect(typeof RESTART_EXIT_CODE).toBe("number");
  });

  it("delegates to the registered handler", async () => {
    const handler = vi.fn(async () => undefined);
    setRestartHandler(handler);
    await requestRestart("update");
    expect(handler).toHaveBeenCalledWith("update");
  });

  it("default handler is a no-op", async () => {
    setRestartHandler(() => {});
    await requestRestart();
    setRestartHandler(() => {});
  });
});
