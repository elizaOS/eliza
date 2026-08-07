/**
 * Locks the cross-platform native owner/session and atomic presentation
 * boundary whose runtime caller is exercised by the UI reconciler tests.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const kotlin = readFileSync(
  join(
    import.meta.dirname,
    "../android/src/main/java/ai/eliza/plugins/browsersurface/BrowserSurfacePlugin.kt",
  ),
  "utf8",
);
const swift = readFileSync(
  join(
    import.meta.dirname,
    "../ios/Sources/BrowserSurfacePlugin/BrowserSurfacePlugin.swift",
  ),
  "utf8",
);

describe("native Browser owner lifecycle", () => {
  it("exposes the same acknowledged lifecycle protocol on Android and iOS", () => {
    for (const source of [kotlin, swift]) {
      for (const method of [
        "reloadSurface",
        "presentSurface",
        "getSurfaceState",
        "listSurfaceStates",
        "reconcileOwner",
      ]) {
        expect(source).toContain(method);
      }
      expect(source).toContain("owner");
      expect(source).toContain("session");
    }
  });

  it("validates duplicate identity and policy instead of adopting stale same-id content", () => {
    expect(kotlin).toMatch(
      /existing\.owner != owner \|\|\s+existing\.session != session \|\|\s+existing\.process != process \|\| existing\.storage != storage/,
    );
    expect(swift).toContain("existing.owner == identity.owner");
    expect(swift).toContain("existing.session == identity.session");
    expect(swift).toContain("existing.process == process");
    expect(swift).toContain("existing.storage == storage");
  });

  it("hides siblings before presenting the selected native child", () => {
    expect(kotlin).toContain("surface.container.visibility = View.GONE");
    expect(kotlin).toContain("selected?.let { surface ->");
    expect(swift).toContain("surface.container.isHidden = true");
    expect(swift).toContain("if let selected {");
  });

  it("reconciles renderer orphans and releases native page resources", () => {
    expect(kotlin).toContain("surface.webView.destroy()");
    expect(kotlin).toContain("ProfileStore.getInstance().deleteProfile(name)");
    expect(kotlin).toContain("surface.session != session");
    expect(swift).toContain("surface.webView.stopLoading()");
    expect(swift).toContain("surface.session != identity.session");
  });
});
