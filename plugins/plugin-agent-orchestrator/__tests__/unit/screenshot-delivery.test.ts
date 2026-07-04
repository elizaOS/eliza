/**
 * Verifies collectScreenshotPaths (#8904).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { logger } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  collectScreenshotPaths,
  deliverScreenshots,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  screenshotsToAttachments,
} from "../../src/services/screenshot-delivery.js";

const ROOM = "11111111-1111-1111-1111-111111111111";

function envelopeText(screenshotPaths: string[]): string {
  return `Done.\n\`\`\`json\n${JSON.stringify({
    diffSummary: "x",
    filesChanged: [],
    testResults: [],
    screenshotPaths,
    acceptanceCriteriaStatus: [],
    residualRisks: [],
  })}\n\`\`\``;
}

describe("collectScreenshotPaths (#8904)", () => {
  it("reads screenshot paths from a valid CompletionEnvelope", () => {
    const paths = collectScreenshotPaths(
      envelopeText(["/tmp/a.png", "/tmp/b.jpg"]),
      undefined,
    );
    expect(paths).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
  });

  it("also reads metadata.artifactPaths / screenshotPaths, deduped", () => {
    const paths = collectScreenshotPaths(envelopeText(["/tmp/a.png"]), {
      artifactPaths: ["/tmp/a.png", "/tmp/c.webp"],
      screenshotPaths: ["/tmp/d.gif"],
    });
    // envelope first, then metadata.screenshotPaths, then metadata.artifactPaths (a.png deduped)
    expect(paths).toEqual(["/tmp/a.png", "/tmp/d.gif", "/tmp/c.webp"]);
  });

  it("filters out non-image paths", () => {
    expect(
      collectScreenshotPaths(undefined, {
        artifactPaths: ["/tmp/log.txt", "/tmp/shot.png"],
      }),
    ).toEqual(["/tmp/shot.png"]);
  });

  it("returns [] when there is no envelope and no metadata", () => {
    expect(collectScreenshotPaths("just prose", undefined)).toEqual([]);
  });
});

describe("screenshotsToAttachments (#8904)", () => {
  it("builds image Media and caps the count", () => {
    const many = Array.from({ length: 9 }, (_, i) => `/tmp/${i}.png`);
    const atts = screenshotsToAttachments(many, { getSize: () => 100 });
    expect(atts).toHaveLength(MAX_SCREENSHOTS);
    expect(atts[0]).toMatchObject({ url: "/tmp/0.png", contentType: "image" });
    expect(atts[0].title).toBe("0.png");
  });

  it("caps total known bytes across the forwarded screenshots", () => {
    const atts = screenshotsToAttachments(
      ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
      {
        maxCount: 5,
        maxTotalBytes: 10,
        getSize: (path) => (path.endsWith("b.png") ? 7 : 4),
      },
    );
    expect(atts.map((att) => att.url)).toEqual(["/tmp/a.png", "/tmp/c.png"]);
  });

  it("skips a single screenshot larger than the total byte budget", () => {
    const atts = screenshotsToAttachments(["/tmp/huge.png", "/tmp/small.png"], {
      maxTotalBytes: MAX_SCREENSHOT_TOTAL_BYTES,
      maxFileBytes: Number.POSITIVE_INFINITY,
      getSize: (path) =>
        path.includes("huge")
          ? MAX_SCREENSHOT_TOTAL_BYTES + 1
          : MAX_SCREENSHOT_TOTAL_BYTES,
    });
    expect(atts.map((att) => att.url)).toEqual(["/tmp/small.png"]);
  });

  it("skips a single screenshot over the per-file cap (Telegram sendPhoto limit)", () => {
    const atts = screenshotsToAttachments(["/tmp/big.png", "/tmp/ok.png"], {
      maxFileBytes: 1000,
      getSize: (path) => (path.includes("big") ? 2000 : 500),
    });
    expect(atts.map((att) => att.url)).toEqual(["/tmp/ok.png"]);
  });

  it("skips paths whose size cannot be read instead of forwarding them", () => {
    const atts = screenshotsToAttachments(["/tmp/gone.png", "/tmp/ok.png"], {
      getSize: (path) => (path.includes("ok") ? 100 : undefined),
    });
    expect(atts.map((att) => att.url)).toEqual(["/tmp/ok.png"]);
  });
});

describe("deliverScreenshots (#8904)", () => {
  it("posts a media message with capped attachments and returns the count", async () => {
    const send = vi.fn(async () => undefined);
    const n = await deliverScreenshots(
      send,
      { source: "telegram", roomId: ROOM },
      ["/tmp/a.png", "/tmp/b.png"],
      "fix-ui",
      { getSize: () => 100 },
    );
    expect(n).toBe(2);
    const [target, content] = send.mock.calls[0];
    expect(target).toEqual({ source: "telegram", roomId: ROOM });
    expect(content.attachments).toHaveLength(2);
    expect(content.text).toContain("2 screenshots from fix-ui");
  });

  it("is a no-op with no paths", async () => {
    const send = vi.fn(async () => undefined);
    expect(
      await deliverScreenshots(send, { source: "t", roomId: ROOM }, []),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("warns and trims when more screenshots are supplied than fit the budget", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const many = Array.from({ length: 9 }, (_, i) => `/tmp/${i}.png`);
    const n = await deliverScreenshots(
      send,
      { source: "telegram", roomId: ROOM },
      many,
      undefined,
      { getSize: () => 100 },
    );
    expect(n).toBe(MAX_SCREENSHOTS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("omitted 4 of 9 screenshot(s)"),
    );
    warn.mockRestore();
  });

  it("never throws when the send fails (best-effort)", async () => {
    const send = vi.fn(async () => {
      throw new Error("upload failed");
    });
    expect(
      await deliverScreenshots(
        send,
        { source: "t", roomId: ROOM },
        ["/tmp/a.png"],
        undefined,
        { getSize: () => 100 },
      ),
    ).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
