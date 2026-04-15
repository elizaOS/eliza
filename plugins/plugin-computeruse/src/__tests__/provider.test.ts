/**
 * Tests for the computerState provider.
 */
import { describe, expect, it } from "vitest";
import { computerStateProvider } from "../providers/computer-state.js";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

function createMockRuntime(hasService: boolean) {
  return {
    character: {},
    getService(name: string) {
      if (!hasService || name !== "computeruse") return null;
      return {
        getCapabilities: () => ({
          screenshot: { available: true, tool: "screencapture" },
          computerUse: { available: true, tool: "cliclick" },
          windowList: { available: true, tool: "AppleScript" },
          browser: { available: true, tool: "puppeteer-core" },
          terminal: { available: true, tool: "shell" },
          fileSystem: { available: true, tool: "node:fs" },
        }),
        getScreenDimensions: () => ({ width: 2560, height: 1440 }),
        getRecentActions: () => [
          { action: "click", timestamp: Date.now(), success: true },
          { action: "screenshot", timestamp: Date.now(), success: true },
        ],
        getApprovalSnapshot: () => ({
          mode: "smart_approve",
          pendingCount: 0,
          pending: [],
        }),
      };
    },
  } as unknown as IAgentRuntime;
}

describe("computerStateProvider", () => {
  it("has correct name", () => {
    expect(computerStateProvider.name).toBe("computerState");
  });

  it("returns empty text when service is not available", async () => {
    const runtime = createMockRuntime(false);
    const result = await computerStateProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );
    expect(result.text).toBe("");
  });

  it("returns platform info when service is available", async () => {
    const runtime = createMockRuntime(true);
    const result = await computerStateProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );

    expect(result.text).toContain("Computer Use");
    expect(result.text).toContain("Platform:");
    expect(result.text).toContain("Screen: 2560x1440");
    expect(result.text).toContain("screencapture");
    expect(result.text).toContain("cliclick");
    expect(result.text).toContain("puppeteer-core");
    expect(result.text).toContain("AppleScript");
  });

  it("includes recent actions in output", async () => {
    const runtime = createMockRuntime(true);
    const result = await computerStateProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );

    expect(result.text).toContain("Recent actions");
    expect(result.text).toContain("click");
    expect(result.text).toContain("screenshot");
  });

  it("returns structured data", async () => {
    const runtime = createMockRuntime(true);
    const result = await computerStateProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );

    expect(result.data).toBeDefined();
    const data = result.data as Record<string, unknown>;
    expect(data.capabilities).toBeDefined();
    expect(data.screenSize).toBeDefined();
    expect(data.recentActions).toBeDefined();
  });

  it("returns values with platform and screen dimensions", async () => {
    const runtime = createMockRuntime(true);
    const result = await computerStateProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );

    expect(result.values).toBeDefined();
    expect(result.values!.screenWidth).toBe(2560);
    expect(result.values!.screenHeight).toBe(1440);
    expect(typeof result.values!.platform).toBe("string");
  });
});
