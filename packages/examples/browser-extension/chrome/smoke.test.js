import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Chrome extension package", () => {
  test("declares the expected Manifest V3 surfaces", () => {
    const manifest = JSON.parse(read("manifest.json"));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.background.service_worker).toBe(
      "dist/background.global.js",
    );
    expect(manifest.content_scripts[0].matches).toEqual(["<all_urls>"]);
    expect(manifest.permissions).toContain("offscreen");
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });

  test("wires background content extraction and chat streaming", () => {
    const background = read("src/background.ts");
    const content = read("src/content.ts");

    expect(background).toContain("ensureOffscreenDocument");
    expect(background).toContain("GET_PAGE_CONTENT");
    expect(background).toContain("CHAT_STREAM_CHUNK");
    expect(background).toContain("CHAT_MESSAGE_DONE");
    expect(content).toContain("shouldExcludeElement");
    expect(content).toContain("getTextFromElement");
  });
});
