/**
 * Tile selection tests for the host screen capture service.
 *
 * A stub capture tool on PATH copies a fixed PNG into the requested output
 * path, so the real tiler runs without a display.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenCaptureService } from "./screen-capture";

const savedPath = process.env.PATH;
let binDir = "";

async function stubCaptureTool(width: number, height: number): Promise<void> {
  const fixture = join(binDir, `screen-${width}x${height}.png`);
  writeFileSync(
    fixture,
    await sharp({
      create: { width, height, channels: 3, background: "#1e1e1e" },
    })
      .png()
      .toBuffer(),
  );
  // `scrot "<out>"` on Linux, `screencapture -x "<out>"` on macOS: the
  // output path is the last argument for both.
  const script = `#!/bin/sh\nfor arg; do out="$arg"; done\ncp "${fixture}" "$out"\n`;
  for (const tool of ["scrot", "screencapture"]) {
    writeFileSync(join(binDir, tool), script);
    chmodSync(join(binDir, tool), 0o755);
  }
}

describe.runIf(process.platform !== "win32")(
  "ScreenCaptureService priority tile order",
  () => {
    beforeAll(() => {
      binDir = mkdtempSync(join(tmpdir(), "screen-capture-test-"));
      process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    });

    afterAll(() => {
      process.env.PATH = savedPath;
      rmSync(binDir, { recursive: true, force: true });
    });

    it.each([
      [1920, 1080], // 5 rows
      [2560, 1440], // 6 rows
      [1440, 900], // 4 rows
      [3024, 1964], // 8 rows
    ])(
      "makes the tile under the screen center active at %ix%i",
      async (width, height) => {
        await stubCaptureTool(width, height);
        // VisionService's default tile settings.
        const service = new ScreenCaptureService({
          tileSize: 256,
          tileProcessingOrder: "priority",
        });

        const capture = await service.captureScreen();
        const active = service.getActiveTile();

        expect(capture.tiles.length).toBeGreaterThan(1);
        expect(active).not.toBeNull();
        if (!active) return;
        expect(active.data).toBeInstanceOf(Buffer);
        expect(active.x).toBeLessThanOrEqual(width / 2);
        expect(active.x + active.width).toBeGreaterThan(width / 2);
        expect(active.y).toBeLessThanOrEqual(height / 2);
        expect(active.y + active.height).toBeGreaterThan(height / 2);
      },
    );
  },
);
