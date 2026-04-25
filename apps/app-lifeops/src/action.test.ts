import type { Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createBrowserSession = vi.fn(async (request: Record<string, unknown>) => ({
  id: "session-1",
  title: String(request.title ?? "Session"),
  status: "queued",
  browser: null,
  profileId: null,
  tabId: null,
}));

vi.mock("@elizaos/agent", () => ({
  hasAdminAccess: vi.fn(async () => true),
}));

vi.mock("./lifeops/service.js", () => ({
  LifeOpsService: class LifeOpsService {
    createBrowserSession = createBrowserSession;
  },
  LifeOpsServiceError: class LifeOpsServiceError extends Error {
    status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

describe("manageBrowserBridgeAction", () => {
  beforeEach(() => {
    createBrowserSession.mockClear();
  });

  it("returns a structured failure for desktop-only aliases", async () => {
    const { manageBrowserBridgeAction } = await import("./action.js");

    const result = await manageBrowserBridgeAction.handler(
      {} as never,
      { content: { text: "Open Finder for me." } } as Memory,
      undefined,
      { parameters: { command: "open_finder" } } as never,
    );

    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      data: {
        error: "DESKTOP_WORKFLOW",
        command: "open_finder",
      },
    });
    expect(String(result.text)).toContain("LIFEOPS_COMPUTER_USE");
  });

  it("maps start to an open browser session request", async () => {
    const { manageBrowserBridgeAction } = await import("./action.js");

    const result = await manageBrowserBridgeAction.handler(
      {} as never,
      {
        content: {
          text: "Start the browser at https://example.com.",
        },
      } as Memory,
      undefined,
      {
        parameters: {
          command: "start",
          url: "https://example.com",
        },
      } as never,
    );

    expect(createBrowserSession).toHaveBeenCalledTimes(1);
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            kind: "open",
            url: "https://example.com",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({ success: true });
  });
});
