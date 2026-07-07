/**
 * Proves the native-webview enforcement invariant of the surface-embedding
 * resolver (#14181/#15245/#13452): a separate-renderer native child web surface
 * — the only render paths that put a browser tab in its own renderer process
 * (`native-child-webview` on desktop, `native-mobile-webview` on a native mobile
 * shell) — is selected IFF the resolved manifest declares
 * `isolation: "native-webview"` on a host that can host one, and can never be
 * reached by any other isolation level on any host. Also pins the actual Browser
 * builtin manifest to that level. Pure functions over the isolation catalogue —
 * no runtime harness needed; the isolation property under test is the selection.
 */

import { SURFACE_ISOLATION_LEVELS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { BrowserWorkspaceMode } from "./api/browser-contracts";
import { resolveBuiltinSurfaceManifest } from "./builtin-tab-registry";
import {
  type BrowserTabRenderPath,
  resolveBrowserTabRenderPath,
} from "./surface-embedding";

const ALL_MODES: readonly BrowserWorkspaceMode[] = ["desktop", "web", "cloud"];

/** The two paths that hand a tab its own renderer process. */
const NATIVE_PATHS: readonly BrowserTabRenderPath[] = [
  "native-child-webview",
  "native-mobile-webview",
];

describe("resolveBrowserTabRenderPath", () => {
  it("hands out the desktop native child surface only for native-webview on desktop", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "desktop",
        nativeMobileShell: false,
      }),
    ).toBe("native-child-webview");
  });

  it("hands out the mobile native surface for native-webview on a native mobile shell", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "web",
        nativeMobileShell: true,
      }),
    ).toBe("native-mobile-webview");
  });

  it("native-webview degrades to a sandboxed iframe on a plain web host", () => {
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "web",
        nativeMobileShell: false,
      }),
    ).toBe("sandboxed-iframe");
  });

  it("cloud renders a server snapshot regardless of isolation or shell", () => {
    for (const isolation of SURFACE_ISOLATION_LEVELS) {
      for (const nativeMobileShell of [true, false]) {
        expect(
          resolveBrowserTabRenderPath({
            isolation,
            mode: "cloud",
            nativeMobileShell,
          }),
        ).toBe("server-snapshot");
      }
    }
  });

  it("the desktop path takes precedence when a shell reports both desktop and native-mobile", () => {
    // A real native mobile shell never reports `mode: "desktop"`, but the
    // resolver must be deterministic on the overlap: desktop is the more
    // specific host and wins.
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "desktop",
        nativeMobileShell: true,
      }),
    ).toBe("native-child-webview");
  });

  it("ENFORCEMENT: no non-native-webview level ever reaches either native path", () => {
    // The isolation guarantee: a view that did not declare `native-webview` must
    // never be handed a separate-renderer native surface on ANY host — that is
    // what keeps a leak-capable embedding out of any surface that didn't opt in.
    for (const isolation of SURFACE_ISOLATION_LEVELS) {
      if (isolation === "native-webview") continue;
      for (const mode of ALL_MODES) {
        for (const nativeMobileShell of [true, false]) {
          expect(NATIVE_PATHS).not.toContain(
            resolveBrowserTabRenderPath({ isolation, mode, nativeMobileShell }),
          );
        }
      }
    }
  });

  it("ENFORCEMENT: a native path requires a host that can host it", () => {
    // native-webview alone is not sufficient — without desktop or a native
    // mobile shell it degrades. This is the second half of the conjunction.
    expect(
      resolveBrowserTabRenderPath({
        isolation: "native-webview",
        mode: "web",
        nativeMobileShell: false,
      }),
    ).toBe("sandboxed-iframe");
  });

  it("is total over every isolation level × mode × shell", () => {
    const valid = new Set<BrowserTabRenderPath>([
      "native-child-webview",
      "native-mobile-webview",
      "sandboxed-iframe",
      "server-snapshot",
    ]);
    for (const isolation of SURFACE_ISOLATION_LEVELS) {
      for (const mode of ALL_MODES) {
        for (const nativeMobileShell of [true, false]) {
          expect(
            valid.has(
              resolveBrowserTabRenderPath({
                isolation,
                mode,
                nativeMobileShell,
              }),
            ),
          ).toBe(true);
        }
      }
    }
  });
});

describe("Browser builtin manifest drives the native path", () => {
  it("declares native-webview, so its tab renderer selects a native surface on every native host", () => {
    const isolation = resolveBuiltinSurfaceManifest("browser").isolation;
    expect(isolation).toBe("native-webview");
    expect(
      resolveBrowserTabRenderPath({
        isolation,
        mode: "desktop",
        nativeMobileShell: false,
      }),
    ).toBe("native-child-webview");
    expect(
      resolveBrowserTabRenderPath({
        isolation,
        mode: "web",
        nativeMobileShell: true,
      }),
    ).toBe("native-mobile-webview");
  });
});
