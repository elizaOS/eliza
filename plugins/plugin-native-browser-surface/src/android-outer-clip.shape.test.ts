/**
 * Static contract coverage keeps the Android-only composition boundary wired
 * even on hosts without an Android SDK; device rendering remains instrumented.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const currentDir = new URL(".", import.meta.url).pathname;
const kotlinSource = readFileSync(
  resolve(
    currentDir,
    "../android/src/main/java/ai/eliza/plugins/browsersurface/BrowserSurfacePlugin.kt",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("Android Browser outer-clip composition contract", () => {
  it("parses computed outer geometry through the atomic bounds update", () => {
    expect(kotlinSource).toContain('call.getObject("outerClip")');
    expect(kotlinSource).toContain(
      'rawOuterClip?.optJSONObject("cornerRadii")',
    );
    expect(kotlinSource).toContain("surface.outerClip = outerClip");
    expect(kotlinSource).toContain("applyGeometry(surface, d)");
  });

  it("clips outer corners before subtracting every overlay hole", () => {
    expect(kotlinSource).toContain(
      "outerClip?.let { clip -> clipPath.reset() clipPath.addRoundRect(",
    );
    expect(kotlinSource).toContain(
      "canvas.clipPath(clipPath) } for (rect in occlusions)",
    );
    expect(kotlinSource).toContain("canvas.clipOutPath(clipPath)");
  });

  it("yields touches outside the rounded host and inside React holes", () => {
    expect(kotlinSource).toContain(
      "outerClip?.contains(event.x, event.y) == false || occlusions.any { it.contains(event.x, event.y) }",
    );
  });

  it("updates clipping without creating or navigating a WebView", () => {
    const setBoundsBody = kotlinSource.match(
      /fun setBounds\(call: PluginCall\) \{(.+?)@PluginMethod fun setOcclusionRects/,
    )?.[1];
    expect(setBoundsBody).toBeDefined();
    expect(setBoundsBody).not.toContain("WebView(");
    expect(setBoundsBody).not.toContain("loadUrl(");
    expect(kotlinSource).toContain("if (outerClip == clip) return");
  });
});
