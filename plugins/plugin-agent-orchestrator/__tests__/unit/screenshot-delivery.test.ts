import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectScreenshotPaths,
  deliverScreenshots,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  screenshotsToAttachments,
  selectScreenshotPathsForDelivery,
} from "../../src/services/screenshot-delivery.js";

const ROOM = "11111111-1111-1111-1111-111111111111";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempImage(name: string, bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-screenshot-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

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

describe("selectScreenshotPathsForDelivery (#8904)", () => {
  it("caps the total bytes across delivered screenshots", () => {
    const a = tempImage("a.png", 6);
    const b = tempImage("b.png", 5);
    const c = tempImage("c.png", 4);

    expect(
      selectScreenshotPathsForDelivery([a, b, c], {
        maxCount: 5,
        maxTotalBytes: 10,
      }),
    ).toEqual([a, c]);
  });

  it("skips unknown-size paths instead of dispatching files that will fail later", () => {
    const a = tempImage("a.png", 1);

    expect(
      selectScreenshotPathsForDelivery(["/missing/shot.png", a], {
        maxTotalBytes: 10,
      }),
    ).toEqual([a]);
  });

  it("exports a nonzero total-size cap for production delivery", () => {
    expect(MAX_SCREENSHOT_TOTAL_BYTES).toBeGreaterThan(0);
  });
});

describe("deliverScreenshots (#8904)", () => {
  it("posts a media message with capped attachments and returns the count", async () => {
    const send = vi.fn(async () => undefined);
    const a = tempImage("a.png", 1);
    const b = tempImage("b.png", 1);
    const n = await deliverScreenshots(
      send,
      { source: "telegram", roomId: ROOM },
      [a, b],
      "fix-ui",
    );
    expect(n).toBe(2);
    const [target, content] = send.mock.calls[0];
    expect(target).toEqual({ source: "telegram", roomId: ROOM });
    expect(content.attachments).toHaveLength(2);
    expect(content.text).toContain("2 screenshots from fix-ui");
    expect(content.attachments?.[0]).toMatchObject({
      contentType: "image",
      source: "sub-agent",
      url: a,
    });
  });

  it("dispatches Telegram-photo-shaped media and trims by byte budget before send", async () => {
    const send = vi.fn(async () => undefined);
    const accepted = tempImage("accepted.png", 1);
    const oversized = tempImage(
      "oversized.png",
      MAX_SCREENSHOT_TOTAL_BYTES + 1,
    );

    const n = await deliverScreenshots(
      send,
      { source: "telegram", roomId: ROOM },
      [accepted, oversized],
      "visual-proof",
    );

    expect(n).toBe(1);
    const [target, content] = send.mock.calls[0];
    expect(target.source).toBe("telegram");
    expect(content.attachments).toEqual([
      expect.objectContaining({
        contentType: "image",
        title: "accepted.png",
        url: accepted,
      }),
    ]);
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
    const a = tempImage("a.png", 1);
    expect(
      await deliverScreenshots(send, { source: "t", roomId: ROOM }, [a]),
    ).toBe(0);
  });
});
