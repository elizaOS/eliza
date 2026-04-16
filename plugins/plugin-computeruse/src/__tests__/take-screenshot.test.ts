import { describe, expect, it, vi } from "vitest";
import type { HandlerCallback } from "@elizaos/core";
import { takeScreenshotAction } from "../actions/take-screenshot";

describe("TAKE_SCREENSHOT action", () => {
  it("routes through executeDesktopAction so approvals and history stay in sync", async () => {
    const executeDesktopAction = vi.fn(async () => ({
      success: true,
      screenshot: Buffer.from("fake-png").toString("base64"),
    }));
    const callback = vi.fn<HandlerCallback>();

    const result = await takeScreenshotAction.handler?.(
      {
        getService: vi.fn(() => ({
          executeDesktopAction,
        })),
      } as never,
      { content: { text: "show me the screen" } } as never,
      undefined,
      undefined,
      callback,
    );

    expect(executeDesktopAction).toHaveBeenCalledWith({ action: "screenshot" });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Here is the current screen.",
        attachments: [
          expect.objectContaining({
            contentType: "image",
            source: "computeruse",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({ success: true });
  });
});
