/**
 * Guards the mobile bundle against reintroducing write-only globalThis plugin
 * pins: asserts bin.ts and android-app-plugins.ts keep their plugin modules alive
 * through consumed side effects (the STATIC_ELIZA_PLUGINS Object.assign and
 * bin.ts's literal-specifier anchor imports) rather than dead pinning globals.
 * Deterministic source-text scan — reads the two files as strings, no bundling.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = path.resolve(here, "..");

function read(rel: string): string {
  return readFileSync(path.join(agentSrc, rel), "utf8");
}

/**
 * Write-only globalThis keys that pin plugin functions purely to defeat Bun
 * tree-shaking are forbidden — nothing reads them (#12091 item 29). Modules stay
 * in the bundle via consumed side effects (the STATIC_ELIZA_PLUGINS Object.assign
 * and the literal-specifier anchor imports), so no such pin is needed. This list
 * guards against reintroducing the dead pins.
 */
const DEAD_GLOBALS = [
  "__eliza" + "AospLlamaLoader",
  "__eliza" + "AospLocalInferenceBootstrap",
  "__eliza" + "MobileDeviceBridgeBootstrap",
  "__eliza" + "AndroidAppPlugins",
] as const;

describe("mobile bundle anchors (no write-only globalThis pinning)", () => {
  const binSource = read("bin.ts");
  const androidSource = read("runtime/android-app-plugins.ts");

  it("removes every write-only plugin-pinning global", () => {
    const haystack = `${binSource}\n${androidSource}`;
    for (const name of DEAD_GLOBALS) {
      expect(haystack, name).not.toContain(name);
    }
  });

  it("keeps the STATIC_ELIZA_PLUGINS registry side effect that anchors the app plugins", () => {
    expect(androidSource).toContain("Object.assign(STATIC_ELIZA_PLUGINS");
  });

  it("keeps bin.ts literal-specifier anchor imports for the pinned packages", () => {
    expect(binSource).toContain(
      'import(/* @vite-ignore */ "@elizaos/plugin-aosp-local-inference")',
    );
    expect(binSource).toContain(
      '"@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"',
    );
  });
});
