import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { browserAction } from "../actions/browser-action.js";

function runtimeWithBrowserService(service: unknown): IAgentRuntime {
  return {
    getService(name: string) {
      return name === "computeruse" ? service : null;
    },
  } as IAgentRuntime;
}

describe("BROWSER_ACTION", () => {
  it("auto-opens the browser once when a first non-lifecycle action reports that it is closed", async () => {
    const executeBrowserAction = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "Browser not open. Use the open action first.",
      })
      .mockResolvedValueOnce({
        success: true,
        content: "Browser opened.",
      })
      .mockResolvedValueOnce({
        success: true,
        content: "Navigated.",
      });
    const callback = vi.fn();

    const result = await browserAction.handler(
      runtimeWithBrowserService({ executeBrowserAction }),
      { content: { action: "navigate", url: "https://example.com" } } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe("Navigated.");
    expect(executeBrowserAction).toHaveBeenNthCalledWith(1, {
      action: "navigate",
      url: "https://example.com",
    });
    expect(executeBrowserAction).toHaveBeenNthCalledWith(2, {
      action: "open",
      url: "https://example.com",
    });
    expect(executeBrowserAction).toHaveBeenNthCalledWith(3, {
      action: "navigate",
      url: "https://example.com",
    });
    expect(callback).toHaveBeenCalledWith({ text: "Navigated." });
  });

  it("does not auto-open for lifecycle close failures", async () => {
    const executeBrowserAction = vi.fn().mockResolvedValueOnce({
      success: false,
      error: "Browser not open. Use the open action first.",
    });

    const result = await browserAction.handler(
      runtimeWithBrowserService({ executeBrowserAction }),
      { content: { action: "close" } } as Memory,
    );

    expect(result.success).toBe(false);
    expect(executeBrowserAction).toHaveBeenCalledTimes(1);
  });
});
