/** Exercises deterministic native-host manifest generation without touching browser registrations. */

import { describe, expect, it } from "vitest";
import {
  generateChromeNativeHostManifest,
  generateFirefoxNativeHostManifest,
  serializeNativeHostManifest,
} from "./browser-bridge-host-manifest";

describe("browser bridge native-host manifests", () => {
  it("generates a sorted exact-ID Chrome manifest", () => {
    const manifest = generateChromeNativeHostManifest({
      executablePath:
        "/Applications/Eliza.app/Contents/MacOS/eliza-browser-bridge-host",
      extensionIds: [
        "ponmlkjihgfedcbaponmlkjihgfedcba",
        "abcdefghijklmnopabcdefghijklmnop",
        "abcdefghijklmnopabcdefghijklmnop",
      ],
    });

    expect(manifest).toEqual({
      name: "ai.elizaos.browserbridge",
      description: "elizaOS Agent Browser Bridge enrollment host",
      path: "/Applications/Eliza.app/Contents/MacOS/eliza-browser-bridge-host",
      type: "stdio",
      allowed_origins: [
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/",
      ],
    });
  });

  it("generates a sorted exact-ID Firefox manifest", () => {
    const manifest = generateFirefoxNativeHostManifest({
      executablePath: "/opt/eliza/eliza-browser-bridge-host",
      extensionIds: ["release@elizaos.ai", "beta@elizaos.ai"],
    });

    expect(manifest).toEqual({
      name: "ai.elizaos.browserbridge",
      description: "elizaOS Agent Browser Bridge enrollment host",
      path: "/opt/eliza/eliza-browser-bridge-host",
      type: "stdio",
      allowed_extensions: ["beta@elizaos.ai", "release@elizaos.ai"],
    });
    expect(serializeNativeHostManifest(manifest)).toBe(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });

  it("preserves an absolute Windows packaged-host path", () => {
    expect(
      generateChromeNativeHostManifest({
        executablePath: String.raw`C:\Program Files\Eliza\eliza-browser-bridge-host.exe`,
        extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
      }),
    ).toMatchObject({
      path: String.raw`C:\Program Files\Eliza\eliza-browser-bridge-host.exe`,
    });
  });

  it("rejects relative paths and malformed browser IDs", () => {
    expect(() =>
      generateChromeNativeHostManifest({
        executablePath: "host",
        extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
      }),
    ).toThrow("absolute");
    expect(() =>
      generateChromeNativeHostManifest({
        executablePath: "/host",
        extensionIds: ["not-an-extension-id"],
      }),
    ).toThrow("Chrome extension ID is invalid");
    expect(() =>
      generateFirefoxNativeHostManifest({
        executablePath: "/host",
        extensionIds: ["bad extension id"],
      }),
    ).toThrow("Firefox extension ID is invalid");
  });
});
