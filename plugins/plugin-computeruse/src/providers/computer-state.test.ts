/** Verifies the computer-state provider's unavailable and crash-safe contracts. */

import { describe, expect, it, vi } from "vitest";
import { currentPlatform } from "../platform/helpers";
import { computerStateProvider } from "./computer-state";

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    getCapabilities: vi.fn().mockReturnValue({
      screenshot: { available: true, tool: "screenshot" },
      computerUse: { available: true, tool: "computerUse" },
      browser: { available: false, tool: "" },
      windowList: { available: true, tool: "windowList" },
      terminal: { available: false, tool: "" },
      fileSystem: { available: true, tool: "fileSystem" },
    }),
    getScreenDimensions: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    getRecentActions: vi
      .fn()
      .mockReturnValue([{ action: "click", success: true }]),
    getApprovalSnapshot: vi.fn().mockReturnValue({
      mode: "auto",
      pendingCount: 1,
      pendingApprovals: [{ id: "a1", command: "rm -rf /tmp/x" }],
    }),
    getDisplays: vi.fn().mockReturnValue([
      {
        id: 1,
        name: "DP-1",
        bounds: { x: 0, y: 0, w: 1920, h: 1080 },
        scaleFactor: 1,
        primary: true,
      },
    ]),
    ...overrides,
  };
}

function makeRuntime(service: unknown) {
  return {
    getService: vi.fn().mockReturnValue(service),
    reportError: vi.fn(),
  } as never;
}

describe("computerStateProvider", () => {
  it("degrades to an empty text when no computeruse service is registered", async () => {
    const runtime = makeRuntime(undefined);
    await expect(
      computerStateProvider.get(runtime, {} as never, {} as never),
    ).resolves.toEqual({ text: "" });
  });

  it("renders a JSON snapshot of screen, capabilities, approvals and recent actions", async () => {
    const runtime = makeRuntime(makeService());
    const result = await computerStateProvider.get(
      runtime,
      {} as never,
      {} as never,
    );
    expect(result.text).toContain(`"platform": "${currentPlatform()}"`);
    expect(result.text).toContain('"screen": {');
    expect(result.text).toContain('"width": 1920');
    expect(result.text).toContain('"height": 1080');
    expect(result.text).toContain('"screenshot": "screenshot"');
    expect(result.text).toContain('"browser": "unavailable"');
    expect(result.text).toContain('"pendingCount": 1');
    expect(result.text).toContain('"command": "rm -rf /tmp/x"');
    expect(result.values).toEqual({
      platform: currentPlatform(),
      screenWidth: 1920,
      screenHeight: 1080,
      displayCount: 1,
      primaryDisplayId: 1,
    });
    expect(result.data).toBeDefined();
  });

  it("flags unavailable capabilities instead of omitting them", async () => {
    const service = makeService();
    service.getCapabilities.mockReturnValue({
      screenshot: { available: false, tool: "" },
      computerUse: { available: false, tool: "" },
      browser: { available: false, tool: "" },
      windowList: { available: false, tool: "" },
      terminal: { available: false, tool: "" },
      fileSystem: { available: false, tool: "" },
    });
    const runtime = makeRuntime(service);
    const result = await computerStateProvider.get(
      runtime,
      {} as never,
      {} as never,
    );
    for (const label of [
      "screenshot",
      "mouseKeyboard",
      "browser",
      "windowList",
      "terminal",
      "fileSystem",
    ]) {
      expect(result.text).toContain(`"${label}": "unavailable"`);
    }
  });

  it("reports and degrades to an empty provider result when a service method throws (error-policy J4)", async () => {
    const boom = new Error("display probe failed");
    const service = makeService();
    service.getDisplays.mockImplementation(() => {
      throw boom;
    });
    const runtime = makeRuntime(service);
    const result = await computerStateProvider.get(
      runtime,
      {} as never,
      {} as never,
    );
    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(runtime.reportError).toHaveBeenCalledWith(
      "Computeruse.computerStateProvider",
      boom,
    );
  });

  it("keeps the provider from ever throwing to the caller", async () => {
    const service = makeService({
      getScreenDimensions: () => {
        throw new Error("boom");
      },
    });
    const runtime = makeRuntime(service);
    await expect(
      computerStateProvider.get(runtime, {} as never, {} as never),
    ).resolves.toBeDefined();
    expect(runtime.reportError).toHaveBeenCalled();
  });

  it("falls back to display id 0 when no primary display is flagged", async () => {
    const service = makeService();
    service.getDisplays.mockReturnValue([
      { id: 7, name: "DP-2", bounds: {}, scaleFactor: 2, primary: false },
    ]);
    const runtime = makeRuntime(service);
    const result = await computerStateProvider.get(
      runtime,
      {} as never,
      {} as never,
    );
    expect(result.values.primaryDisplayId).toBe(0);
    expect(result.values.displayCount).toBe(1);
  });
});
