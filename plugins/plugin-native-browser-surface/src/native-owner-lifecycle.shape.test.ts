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

function methodBody(
  source: string,
  signature: string,
  nextMarker: string,
): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing native method ${signature}`);
  const end = source.indexOf(nextMarker, start + signature.length);
  return source.slice(start, end < 0 ? source.length : end);
}

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
      expect(source).toContain("epoch");
      expect(source).toContain("retired or unclaimed renderer session");
    }
  });

  it("validates duplicate identity and policy instead of adopting stale same-id content", () => {
    expect(kotlin).toMatch(
      /existing\.owner != owner \|\| existing\.session != session \|\|\s+existing\.epoch != identity\.epoch \|\|\s+existing\.process != process \|\| existing\.storage != storage/,
    );
    expect(swift).toContain("existing.owner == identity.owner");
    expect(swift).toContain("existing.session == identity.session");
    expect(swift).toContain("existing.epoch == identity.epoch");
    expect(swift).toContain("existing.process == process");
    expect(swift).toContain("existing.storage == storage");
  });

  it("hides siblings before presenting the selected native child", () => {
    expect(kotlin).toContain("if (surface.owner == owner)");
    expect(kotlin).toContain("surface.container.visibility = View.GONE");
    expect(kotlin).toContain("selected?.let { surface ->");
    expect(swift).toContain("surface.container.isHidden = true");
    expect(swift).toContain("where surface.owner == identity.owner");
    expect(swift).toContain("if let selected {");
  });

  it("returns paint and input to the host before validating a selected id", () => {
    const kotlinPresent = methodBody(
      kotlin,
      "fun presentSurface(",
      "@PluginMethod",
    );
    expect(
      kotlinPresent.indexOf("surface.container.visibility = View.GONE"),
    ).toBeLessThan(kotlinPresent.indexOf("ownedSurface(call"));

    const swiftPresent = methodBody(
      swift,
      "func presentSurface(",
      "@objc func",
    );
    expect(
      swiftPresent.indexOf("surface.container.isHidden = true"),
    ).toBeLessThan(swiftPresent.indexOf("self.ownedSurface("));
  });

  it("reconciles renderer orphans and releases native page resources", () => {
    expect(kotlin).toContain("surface.webView.destroy()");
    expect(kotlin).toContain("surface.profileName?.let(::retireProfile)");
    expect(kotlin).toContain("store.deleteProfile(name)");
    expect(kotlin).toContain("PROFILE_NAMESPACE_PREFIX");
    expect(kotlin).toContain("profileProcessNonce");
    expect(kotlin).toContain("profileSerial += 1");
    expect(kotlin).toContain("surface.session != session");
    expect(swift).toContain("surface.webView.stopLoading()");
    expect(swift).toContain("surface.session != identity.session");
  });

  it("retires old realms and hides their pages before fallible cleanup", () => {
    expect(kotlin).toContain("activeOwners.claim(identity)");
    expect(swift).toContain("self.claimOwner(identity)");
    const kotlinClaim = kotlin.indexOf("activeOwners.claim(identity)");
    const kotlinHide = kotlin.indexOf(
      "surface.container.visibility = View.GONE",
      kotlinClaim,
    );
    const kotlinCleanup = kotlin.indexOf("try {", kotlinClaim);
    expect(kotlinHide).toBeGreaterThan(kotlinClaim);
    expect(kotlinHide).toBeLessThan(kotlinCleanup);

    const swiftClaim = swift.indexOf("self.claimOwner(identity)");
    const swiftHide = swift.indexOf(
      "surface.container.isHidden = true",
      swiftClaim,
    );
    const swiftCleanup = swift.indexOf("let staleIds", swiftClaim);
    expect(swiftHide).toBeGreaterThan(swiftClaim);
    expect(swiftHide).toBeLessThan(swiftCleanup);
  });

  it("checks the active epoch on every read, mutation, and presentation call", () => {
    for (const method of [
      "createSurface",
      "setBounds",
      "setOcclusionRects",
      "navigate",
      "reloadSurface",
      "presentSurface",
      "destroySurface",
      "getSurfaceState",
      "listSurfaceStates",
    ]) {
      expect(
        methodBody(kotlin, `fun ${method}(`, "@PluginMethod"),
        `Android ${method}`,
      ).toContain("requireActiveIdentity");
      expect(
        methodBody(swift, `func ${method}(`, "@objc func"),
        `iOS ${method}`,
      ).toContain("requireActiveIdentity");
    }
  });
});
