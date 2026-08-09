/** Verifies the real app-shell transform emits the intended viewport per target. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appShellMetadataPlugin,
  VIEWPORT_META_NATIVE,
  VIEWPORT_META_WEB,
} from "../vite.config";

const appRoot = path.resolve(import.meta.dirname, "..");
const sourceHtml = readFileSync(path.join(appRoot, "index.html"), "utf8");

function transformHtml(capacitorBuildTarget: string): string {
  const plugin = appShellMetadataPlugin({ capacitorBuildTarget });
  const hook = plugin.transformIndexHtml;
  if (typeof hook !== "function") {
    throw new Error("app-shell metadata transform must be a synchronous hook");
  }
  return (hook as (html: string) => string)(sourceHtml);
}

describe("viewport zoom a11y", () => {
  it("keeps the viewport policy at the build boundary", () => {
    expect(sourceHtml).toContain(
      '<meta name="viewport" content="__APP_VIEWPORT_CONTENT__" />',
    );
    expect(sourceHtml.match(/<meta name="viewport"/g)).toHaveLength(1);
  });

  it.each([
    ["web", "", VIEWPORT_META_WEB],
    ["iOS", "ios", VIEWPORT_META_NATIVE],
    ["Android", "android", VIEWPORT_META_NATIVE],
  ])(
    "emits the %s viewport through the real transform",
    (_, target, expected) => {
      const emittedHtml = transformHtml(target);
      expect(emittedHtml).toContain(
        `<meta name="viewport" content="${expected}" />`,
      );
      expect(emittedHtml).not.toContain("__APP_");
    },
  );

  it("leaves browser zoom uncapped only on hosted web surfaces", () => {
    expect(VIEWPORT_META_WEB).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(VIEWPORT_META_WEB).not.toMatch(/maximum-scale/i);
    expect(VIEWPORT_META_NATIVE).toMatch(/user-scalable\s*=\s*no/i);
    expect(VIEWPORT_META_NATIVE).toMatch(/maximum-scale\s*=\s*1(?:\.0)?/i);
  });
});
