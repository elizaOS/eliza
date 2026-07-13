// @vitest-environment node

/**
 * Drift guard between the native shortcut surfaces and the assistant-launch
 * trust set. Every OS-native entry point (iOS App Intents / controls / widgets,
 * Android tiles / shortcuts / widget / IME / assistant services, macOS
 * shortcuts) mints `elizaos://…?source=<tag>` URLs that the renderer only
 * honors when `<tag>` is in ASSISTANT_LAUNCH_SOURCES — an untrusted tag opens
 * the app but silently drops the launch (no prefill, no capture start), which
 * is exactly how the Android voice tile and share sheet shipped broken. This
 * test greps the native trees for minted `source=` tags and fails when one is
 * missing from the trust set, so adding a native surface forces the trust-set
 * decision at review time instead of in production.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANT_LAUNCH_SOURCES } from "./assistant-launch-payload";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const NATIVE_TREES = [
  "packages/app-core/platforms/ios/App/App",
  "packages/app-core/platforms/android/app/src/main",
  "packages/app-core/platforms/electrobun/src",
] as const;

const SCANNED_EXTENSIONS = new Set([".swift", ".java", ".kt", ".xml", ".ts"]);

// Only platform-branded tags are asserted: generic values (assistant-entry,
// siri) are renderer-side defaults, and unbranded `source=` fragments in
// native code can be OAuth/webview params unrelated to assistant launches.
const NATIVE_TAG_PREFIXES = ["ios-", "android-", "macos-", "desktop-"];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === "node_modules" || entry === "build" || entry === "Pods") {
        continue;
      }
      walk(full, out);
    } else if (SCANNED_EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) {
      out.push(full);
    }
  }
}

function mintedNativeSourceTags(): Map<string, string[]> {
  const tagToFiles = new Map<string, string[]>();
  for (const tree of NATIVE_TREES) {
    const files: string[] = [];
    walk(join(repoRoot, tree), files);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/source=([a-z][a-z0-9-]*)/g)) {
        const tag = match[1];
        if (!NATIVE_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))) {
          continue;
        }
        const existing = tagToFiles.get(tag) ?? [];
        existing.push(file.slice(repoRoot.length + 1));
        tagToFiles.set(tag, existing);
      }
    }
  }
  return tagToFiles;
}

describe("assistant-launch source trust-set drift guard", () => {
  it("trusts every source tag the native surfaces mint", () => {
    const minted = mintedNativeSourceTags();
    // Sanity: the scan itself works — the known surfaces must be found.
    expect(minted.has("ios-control")).toBe(true);
    expect(minted.has("android-qs-tile")).toBe(true);

    const untrusted = [...minted.entries()].filter(
      ([tag]) => !ASSISTANT_LAUNCH_SOURCES.has(tag),
    );
    expect(
      untrusted,
      `Native surfaces mint source tags missing from ASSISTANT_LAUNCH_SOURCES — launches from these surfaces are silently dropped:\n${untrusted
        .map(([tag, files]) => `  ${tag} ← ${files.join(", ")}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
