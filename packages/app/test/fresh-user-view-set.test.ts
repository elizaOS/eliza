/**
 * Regression guard for the fresh-user MVP view set (#14356).
 *
 * Asserts, against the real `BUILTIN_VIEWS` registry, exactly which views a
 * brand-new non-developer user sees in the `/views` manager grid on the default
 * (non-AOSP) build with both Settings toggles OFF, and that every
 * developer/preview surface is hidden then but revealed when its toggle flips
 * on. It encodes the manager-grid visibility predicate from
 * `mergeViewCatalog` (packages/ui/src/hooks/view-catalog.ts) — `isViewVisible`
 * (viewKind gate) AND `visibleInManager !== false` AND not a native-OS surface —
 * so a plugin/view flipping its declared `viewKind` to `system`/`release`, or
 * dropping `visibleInManager: false`, and thereby leaking a non-MVP surface into
 * the fresh-user grid, fails here instead of shipping. The companion
 * `launcher-view-coverage.test.ts` guards the launcher tile roster; this guards
 * the manager grid, the two must not diverge (they did for `relationships` /
 * `feed` before #14356).
 */
import { type EnabledViewKinds, isViewVisible } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_VIEWS } from "../../agent/src/api/builtin-views";

const TOGGLES_OFF: EnabledViewKinds = { developer: false, preview: false };
const TOGGLES_ON: EnabledViewKinds = { developer: true, preview: true };

/**
 * AOSP-ElizaOS-fork-only native device surfaces. `useAvailableViews` strips
 * these from the router + manager on every other build (web, desktop, iOS,
 * stock Play-Store Android). Mirrors `NATIVE_OS_VIEW_IDS` in
 * packages/ui/src/hooks/useAvailableViews.ts.
 */
const NATIVE_OS_VIEW_IDS: ReadonlySet<string> = new Set([
  "phone",
  "messages",
  "contacts",
  "camera",
]);

/** Manager-grid visibility for a given toggle state, off the AOSP fork. */
function managerVisibleIds(enabled: EnabledViewKinds): string[] {
  return BUILTIN_VIEWS.filter(
    (view) =>
      isViewVisible(view, enabled) &&
      view.visibleInManager !== false &&
      !view.nativeOs &&
      !NATIVE_OS_VIEW_IDS.has(view.id),
  )
    .map((view) => view.id)
    .sort();
}

describe("fresh-user MVP view set", () => {
  /**
   * The curated set a fresh non-developer user sees in the manager grid. Each id
   * is an intentional MVP surface:
   *   - chat        — the primary agent conversation surface (home).
   *   - character   — agent identity/personality/knowledge editor.
   *   - documents   — the Knowledge multimedia hub.
   *   - automations — scheduled tasks & recurring workflows.
   *   - plugins-page— install/configure plugins & credentials.
   *   - memories    — the agent memory viewer.
   *   - settings    — model/provider/voice/connector configuration.
   * Everything else is either developer/preview-gated, an internal
   * (visibleInManager:false) deep-link surface, or an AOSP-only native surface.
   */
  const FRESH_USER_MANAGER_VIEWS = [
    "automations",
    "character",
    "chat",
    "documents",
    "memories",
    "plugins-page",
    "settings",
  ].sort();

  it("shows exactly the curated MVP set to a fresh non-developer user", () => {
    expect(managerVisibleIds(TOGGLES_OFF)).toEqual(FRESH_USER_MANAGER_VIEWS);
  });

  it("every fresh-user view is system/release kind (never developer/preview)", () => {
    for (const view of BUILTIN_VIEWS) {
      if (!FRESH_USER_MANAGER_VIEWS.includes(view.id)) continue;
      // `resolveViewKind`'s default is `release`; a fresh-user view must resolve
      // to an always-on kind, which is exactly what `isViewVisible` with both
      // toggles off asserts.
      expect(
        isViewVisible(view, TOGGLES_OFF),
        `fresh-user view "${view.id}" must be always-on (system/release)`,
      ).toBe(true);
    }
  });

  it("developer/preview views are hidden with toggles off, revealed with them on", () => {
    const revealedByToggle = BUILTIN_VIEWS.filter(
      (view) =>
        view.visibleInManager !== false &&
        !view.nativeOs &&
        !NATIVE_OS_VIEW_IDS.has(view.id) &&
        !isViewVisible(view, TOGGLES_OFF) &&
        isViewVisible(view, TOGGLES_ON),
    )
      .map((view) => view.id)
      .sort();

    // background is preview-kind; database/logs/trajectories are developer-kind.
    expect(revealedByToggle).toEqual(
      ["background", "database", "logs", "trajectories"].sort(),
    );
    // None of these leak into the fresh-user set.
    for (const id of revealedByToggle) {
      expect(FRESH_USER_MANAGER_VIEWS).not.toContain(id);
    }
  });

  it("internal + native-OS surfaces never appear in any manager grid", () => {
    // `transcripts` is a Knowledge-hub deep-link (visibleInManager:false,
    // #13594/#11856); `camera` is an AOSP-only nativeOs surface. Neither shows
    // in the manager grid with any toggle state, on the default build.
    for (const enabled of [TOGGLES_OFF, TOGGLES_ON]) {
      const visible = managerVisibleIds(enabled);
      expect(visible).not.toContain("transcripts");
      expect(visible).not.toContain("camera");
    }
  });

  it("the fresh-user set only grows via an explicit, reviewed declaration change", () => {
    // Belt-and-suspenders against a silent predicate change emptying the set
    // (which would make the equality assertion vacuous).
    expect(FRESH_USER_MANAGER_VIEWS.length).toBeGreaterThan(0);
    expect(managerVisibleIds(TOGGLES_OFF).length).toBe(
      FRESH_USER_MANAGER_VIEWS.length,
    );
  });
});
