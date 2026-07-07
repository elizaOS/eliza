/**
 * Proves the mobile surface placement decision (#15245) is driven by the
 * resolved manifest alone: `native-webview` is the only isolation that gets an
 * independent native surface, and its process/storage policy is derived from the
 * manifest (storage shared only with the explicit `storage` grant), never a
 * default. Pure function over `resolveSurfaceManifest` — flipping the manifest
 * is the only way to change the outcome (the red→green the acceptance requires).
 */

import type { SurfaceManifest } from "@elizaos/core";
import { resolveSurfaceManifest } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { deriveSurfacePlacement } from "./native-surface-shell";

function placementFor(surface: SurfaceManifest) {
  return deriveSurfacePlacement(resolveSurfaceManifest({ surface }));
}

describe("deriveSurfacePlacement", () => {
  it("keeps in-process/immersive/sandboxed views in the host web surface", () => {
    for (const isolation of [
      "in-process",
      "immersive",
      "sandboxed-iframe",
    ] as const) {
      expect(placementFor({ isolation }).target).toBe("host-web");
    }
  });

  it("gives a native-webview view its own isolated native surface", () => {
    expect(placementFor({ isolation: "native-webview" })).toEqual({
      target: "native-surface",
      policy: { process: "isolated", storage: "isolated" },
    });
  });

  it("shares storage only when the manifest grants the `storage` capability", () => {
    expect(
      placementFor({ isolation: "native-webview", capabilities: ["storage"] }),
    ).toEqual({
      target: "native-surface",
      policy: { process: "isolated", storage: "shared" },
    });
  });

  it("always isolates the renderer process for a native surface, grant or not", () => {
    // A `storage` grant relaxes storage sharing but never process sharing — the
    // whole reason to embed a native child is to keep content out of the host
    // renderer process.
    for (const capabilities of [[], ["storage"]] as const) {
      const placement = placementFor({
        isolation: "native-webview",
        capabilities,
      });
      expect(placement).toMatchObject({
        target: "native-surface",
        policy: { process: "isolated" },
      });
    }
  });

  it("flips placement when only the manifest isolation changes (manifest-driven)", () => {
    // The red→green: same call site, opposite placement purely from the declared
    // isolation. Hard-coding placement instead of reading the manifest fails this.
    expect(placementFor({ isolation: "in-process" }).target).toBe("host-web");
    expect(placementFor({ isolation: "native-webview" }).target).toBe(
      "native-surface",
    );
  });
});
