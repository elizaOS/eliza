/**
 * Proves the native-webview enforcement invariant of the surface-embedding
 * resolver (#14181/#13452): the native child web-content surface — the only
 * render path that puts a browser tab in a separate renderer process — is
 * selected IFF the resolved manifest declares `isolation: "native-webview"` on
 * the desktop shell, and can never be reached by any other isolation level on
 * any mode. Also pins the actual Browser builtin manifest to that level so its
 * tab renderer keeps selecting the native surface, and pins each platform's
 * native embedding target. Pure functions over static data — no runtime harness
 * needed; the isolation property under test is the selection itself.
 */

import { SURFACE_ISOLATION_LEVELS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { BrowserWorkspaceMode } from "./api/browser-contracts";
import { resolveBuiltinSurfaceManifest } from "./builtin-tab-registry";
import {
  NATIVE_WEBVIEW_EMBEDDINGS,
  NATIVE_WEBVIEW_PLATFORMS,
  nativeWebviewEmbedding,
  resolveBrowserTabRenderPath,
} from "./surface-embedding";

const ALL_MODES: readonly BrowserWorkspaceMode[] = ["desktop", "web", "cloud"];

describe("resolveBrowserTabRenderPath", () => {
  it("hands out the native child surface only for native-webview on desktop", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "desktop",
      }),
    ).toBe("native-child-webview");
  });

  it("native-webview degrades to a sandboxed iframe on the web platform", () => {
    expect(
      resolveBrowserTabRenderPath({ isolation: "native-webview", mode: "web" }),
    ).toBe("sandboxed-iframe");
  });

  it("cloud renders a server snapshot regardless of isolation level", () => {
    for (const isolation of SURFACE_ISOLATION_LEVELS) {
      expect(resolveBrowserTabRenderPath({ isolation, mode: "cloud" })).toBe(
        "server-snapshot",
      );
    }
  });

  it("ENFORCEMENT: no non-native-webview level ever reaches the native surface", () => {
    // The isolation guarantee: a view that did not declare `native-webview`
    // must never be handed a separate-renderer native child surface — that is
    // what keeps a leak-capable embedding out of any surface that didn't opt in.
    for (const isolation of SURFACE_ISOLATION_LEVELS) {
      if (isolation === "native-webview") continue;
      for (const mode of ALL_MODES) {
        expect(resolveBrowserTabRenderPath({ isolation, mode })).not.toBe(
          "native-child-webview",
        );
      }
    }
  });

  it("is total over every isolation level × mode", () => {
    const valid = new Set([
      "native-child-webview",
      "sandboxed-iframe",
      "server-snapshot",
    ]);
    for (const isolation of SURFACE_ISOLATION_LEVELS) {
      for (const mode of ALL_MODES) {
        expect(
          valid.has(resolveBrowserTabRenderPath({ isolation, mode })),
        ).toBe(true);
      }
    }
  });
});

describe("Browser builtin manifest drives the native path", () => {
  it("declares native-webview, so its desktop tab renderer selects the native surface", () => {
    const isolation = resolveBuiltinSurfaceManifest("browser").isolation;
    expect(isolation).toBe("native-webview");
    expect(resolveBrowserTabRenderPath({ isolation, mode: "desktop" })).toBe(
      "native-child-webview",
    );
  });
});

describe("native-webview per-platform embedding targets", () => {
  it("every platform names its native primitive and runs a separate renderer process", () => {
    for (const platform of NATIVE_WEBVIEW_PLATFORMS) {
      const embedding = nativeWebviewEmbedding(platform);
      expect(embedding.platform).toBe(platform);
      expect(embedding.separateRendererProcess).toBe(true);
      expect(embedding.primitive.length).toBeGreaterThan(0);
      expect(embedding.storagePolicy.length).toBeGreaterThan(0);
    }
  });

  it("desktop targets the WebContentsView/CEF OOPIF; iOS WKWebView; Android WebView", () => {
    expect(NATIVE_WEBVIEW_EMBEDDINGS.desktop.primitive).toMatch(
      /WebContentsView|OOPIF|out-of-process/i,
    );
    expect(NATIVE_WEBVIEW_EMBEDDINGS.ios.primitive).toMatch(/WKWebView/);
    expect(NATIVE_WEBVIEW_EMBEDDINGS.ios.primitive).toMatch(/WKProcessPool/);
    expect(NATIVE_WEBVIEW_EMBEDDINGS.android.primitive).toMatch(/WebView/);
  });
});
