import { describe, expect, it, vi } from "vitest";
import {
  capScreenshotPathsByBudget,
  collectScreenshotPaths,
  deliverScreenshots,
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
    const atts = screenshotsToAttachments(many);
    expect(atts).toHaveLength(MAX_SCREENSHOTS);
    expect(atts[0]).toMatchObject({ url: "/tmp/0.png", contentType: "image" });
    expect(atts[0].title).toBe("0.png");
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

  it("never throws when the send fails (best-effort)", async () => {
    const send = vi.fn(async () => {
      throw new Error("upload failed");
    });
    expect(
      await deliverScreenshots(send, { source: "t", roomId: ROOM }, [
        "/tmp/a.png",
      ]),
    ).toBe(0);
  });

  it("forwards only the screenshots that fit the byte budget (#8904)", async () => {
    const send = vi.fn(async () => undefined);
    // a,b,c are 4 bytes each; budget 10 → a(4)+b(8) fit, c(12) is dropped.
    const n = await deliverScreenshots(
      send,
      { source: "telegram", roomId: ROOM },
      ["/x/a.png", "/x/b.png", "/x/c.png"],
      undefined,
      { sizeOf: () => 4, maxTotalBytes: 10 },
    );
    expect(n).toBe(2);
    expect((send.mock.calls[0][1] as { attachments: unknown[] }).attachments).toHaveLength(2);
  });
});

describe("capScreenshotPathsByBudget (#8904)", () => {
  const paths = ["/a.png", "/b.png", "/c.png", "/d.png"];

  it("caps by count", () => {
    const many = Array.from({ length: 7 }, (_, i) => `/${i}.png`);
    expect(capScreenshotPathsByBudget(many, { sizeOf: () => 1 })).toHaveLength(
      MAX_SCREENSHOTS,
    );
  });

  it("stops once the cumulative byte budget would be exceeded", () => {
    // 4 bytes each, budget 10 → keep a(4) + b(8); c would be 12 > 10 → stop.
    expect(
      capScreenshotPathsByBudget(paths, { sizeOf: () => 4, maxTotalBytes: 10 }),
    ).toEqual(["/a.png", "/b.png"]);
  });

  it("always keeps the first path even if it alone exceeds the budget", () => {
    expect(
      capScreenshotPathsByBudget(paths, { sizeOf: () => 100, maxTotalBytes: 10 }),
    ).toEqual(["/a.png"]);
  });

  it("treats unreadable files (size 0) as free, keeping up to the count cap", () => {
    expect(
      capScreenshotPathsByBudget(paths, { sizeOf: () => 0, maxTotalBytes: 10 }),
    ).toEqual(paths);
  });
});
