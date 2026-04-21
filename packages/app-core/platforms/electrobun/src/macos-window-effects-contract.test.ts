import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativeSourcePath = path.resolve(
  __dirname,
  "../native/macos/window-effects.mm",
);

let nativeSource = "";

beforeAll(async () => {
  nativeSource = await readFile(nativeSourcePath, "utf8");
});

describe("macOS window effects titlebar hit regions", () => {
  it("does not use a full titlebar drag overlay with hit-test passthrough holes", () => {
    expect(nativeSource).not.toContain("passthroughRects");
    expect(nativeSource).not.toContain("setPassthroughRects");
    expect(nativeSource).not.toContain("elizaTitlebarDragPassthroughRects");
    expect(nativeSource).not.toContain(
      "setFrame:NSMakeRect(dragX, dragY, dragWidth, dragHeight)",
    );
  });

  it("splits native drag regions into safe title and empty-gap zones", () => {
    expect(nativeSource).toContain("elizaTitlebarNativeDragRects");
    expect(nativeSource).toContain("kElectrobunNativeDragTitleViewIdentifier");
    expect(nativeSource).toContain(
      "kElectrobunNativeDragRightGapViewIdentifier",
    );
    expect(nativeSource).toContain("leftControlEnd");
    expect(nativeSource).toContain("rightControlsWidth");
    expect(nativeSource).toContain("removeNativeDragView");
  });

  it("keeps the inactive traffic-light overlay visual-only", () => {
    expect(nativeSource).toContain(
      "@interface ElizaInactiveTrafficLightsOverlayView",
    );
    expect(nativeSource).toContain("- (nullable NSView *)hitTest");
    expect(nativeSource).toContain(
      "ensureInactiveTrafficLightsOverlay(contentView)",
    );
    expect(nativeSource).toContain("[overlay setHidden:!inactive]");
  });
});
