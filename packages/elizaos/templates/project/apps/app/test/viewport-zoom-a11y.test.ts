/** Verifies generated apps resolve their viewport policy through the real Vite hook. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appShellViewportPlugin,
  VIEWPORT_META_NATIVE,
  VIEWPORT_META_WEB,
} from "../vite.config";

const sourceHtml = readFileSync(
  path.resolve(import.meta.dirname, "../index.html"),
  "utf8",
);

function transform(target: string) {
  const hook = appShellViewportPlugin(target).transformIndexHtml;
  if (typeof hook !== "function") {
    throw new Error("app-shell viewport transform must be synchronous");
  }
  return (hook as (html: string) => string)(sourceHtml);
}

describe("generated app viewport", () => {
  it.each([
    ["hosted", "", VIEWPORT_META_WEB],
    ["iOS", "ios", VIEWPORT_META_NATIVE],
    ["Android", "android", VIEWPORT_META_NATIVE],
  ])("emits the %s policy", (_, target, expected) => {
    const emitted = transform(target);
    expect(emitted).toContain(`<meta name="viewport" content="${expected}" />`);
    expect(emitted).not.toContain("__APP_VIEWPORT_CONTENT__");
  });
});
