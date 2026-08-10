/**
 * Proves that Browser tabs use native child surfaces or first-party remote
 * rendering and that no host can fall back to arbitrary-site iframe embedding.
 */

import { SURFACE_ISOLATION_LEVELS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveBuiltinSurfaceManifest } from "./builtin-tab-registry";
import {
  type BrowserTabRenderPath,
  resolveBrowserTabRenderPath,
} from "./surface-embedding";

const NATIVE_PATHS: readonly BrowserTabRenderPath[] = [
  "native-child-webview",
  "native-mobile-webview",
];

describe("resolveBrowserTabRenderPath", () => {
  it("uses the desktop native child surface for the Browser manifest", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "desktop",
        nativeMobileShell: false,
        presentation: "native-surface",
      }),
    ).toBe("native-child-webview");
  });

  it("uses the platform WebView in a native mobile shell", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "web",
        nativeMobileShell: true,
        presentation: "native-surface",
      }),
    ).toBe("native-mobile-webview");
  });

  it("renders a local or hosted browser stream on plain web hosts", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "web",
        nativeMobileShell: false,
        presentation: "remote-stream",
      }),
    ).toBe("remote-browser-stream");
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "cloud",
        nativeMobileShell: false,
        presentation: "remote-stream",
      }),
    ).toBe("remote-browser-stream");
  });

  it("uses an explicit snapshot for non-interactive hosted sessions", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "cloud",
        nativeMobileShell: false,
        presentation: "snapshot",
      }),
    ).toBe("server-snapshot");
  });

  it("fails visibly when no real browser presentation is available", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "web",
        nativeMobileShell: false,
        presentation: "unavailable",
      }),
    ).toBe("unavailable");
  });

  it("never grants a native child surface to another isolation level", () => {
    for (const isolation of SURFACE_ISOLATION_LEVELS) {
      if (isolation === "native-webview") continue;
      for (const mode of ["desktop", "web", "cloud"] as const) {
        for (const nativeMobileShell of [true, false]) {
          expect(NATIVE_PATHS).not.toContain(
            resolveBrowserTabRenderPath({
              isolation,
              mode,
              nativeMobileShell,
              presentation: "remote-stream",
            }),
          );
        }
      }
    }
  });

  it("pins the Browser builtin to native-webview isolation", () => {
    expect(resolveBuiltinSurfaceManifest("browser").isolation).toBe(
      "native-webview",
    );
  });
});
