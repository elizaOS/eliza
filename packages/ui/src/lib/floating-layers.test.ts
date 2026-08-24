/**
 * Locks the stacking contract of the canonical floating-layer z-index scale in
 * ./floating-layers. Shell, view, and plugin components consume these values
 * directly as CSS z-index, so what matters is the relative order the module
 * documents: backdrops render below their content layers, view-owned modals
 * never rise above persistent shell chrome, and the ground-truth build badge
 * is occluded by nothing — banners, emotes, and config popovers included.
 * Real exported constants, no mocks.
 */
import { describe, expect, it } from "vitest";

import {
  CONFIG_SELECT_FLOATING_LAYER_NAME,
  CONFIG_SELECT_FLOATING_LAYER_Z_INDEX,
  Z_BASE,
  Z_BUILD_BADGE,
  Z_DIALOG,
  Z_DIALOG_OVERLAY,
  Z_DROPDOWN,
  Z_FIRST_RUN_CHOOSER,
  Z_GLOBAL_EMOTE,
  Z_MODAL,
  Z_MODAL_BACKDROP,
  Z_OVERLAY,
  Z_SHELL_OVERLAY,
  Z_STICKY,
  Z_SYSTEM_BANNER,
  Z_SYSTEM_CRITICAL,
  Z_TOOLTIP,
  Z_VIEW_MODAL,
  Z_VIEW_MODAL_BACKDROP,
} from "./floating-layers";

/** Every exported layer, ordered bottom-of-screen to top-of-screen. */
const STACK_BOTTOM_TO_TOP = [
  Z_BASE,
  Z_DROPDOWN,
  Z_STICKY,
  Z_MODAL_BACKDROP,
  Z_MODAL,
  Z_DIALOG_OVERLAY,
  Z_DIALOG,
  Z_OVERLAY,
  Z_TOOLTIP,
  Z_VIEW_MODAL_BACKDROP,
  Z_VIEW_MODAL,
  Z_SHELL_OVERLAY,
  Z_FIRST_RUN_CHOOSER,
  Z_SYSTEM_BANNER,
  Z_SYSTEM_CRITICAL,
  Z_GLOBAL_EMOTE,
  CONFIG_SELECT_FLOATING_LAYER_Z_INDEX,
  Z_BUILD_BADGE,
] as const;

describe("floating-layers z-index scale", () => {
  it("stacks every layer in the documented bottom-to-top order", () => {
    for (let i = 1; i < STACK_BOTTOM_TO_TOP.length; i += 1) {
      const lower = STACK_BOTTOM_TO_TOP[i - 1];
      const higher = STACK_BOTTOM_TO_TOP[i];
      expect(
        higher,
        `layer ${i} must stack strictly above layer ${i - 1}`,
      ).toBeGreaterThan(lower);
    }
  });

  it("gives every layer a distinct, non-negative integer z-index", () => {
    const seen = new Set<number>();
    for (const z of STACK_BOTTOM_TO_TOP) {
      expect(Number.isInteger(z), `z=${z} must be an integer`).toBe(true);
      expect(z, `z=${z} must not be negative`).toBeGreaterThanOrEqual(0);
      expect(seen.has(z), `z=${z} is claimed by two layers`).toBe(false);
      seen.add(z);
    }
  });

  it.each([
    [Z_MODAL_BACKDROP, Z_MODAL],
    [Z_DIALOG_OVERLAY, Z_DIALOG],
    [Z_VIEW_MODAL_BACKDROP, Z_VIEW_MODAL],
  ] as const)(
    "backdrop %s renders below its paired content layer %s",
    (backdrop, content) => {
      expect(backdrop).toBeLessThan(content);
    },
  );

  it("never lets view-owned modals cover persistent shell chrome", () => {
    expect(Z_VIEW_MODAL_BACKDROP).toBeLessThan(Z_SHELL_OVERLAY);
    expect(Z_VIEW_MODAL).toBeLessThan(Z_SHELL_OVERLAY);
  });

  it("keeps the build badge strictly above every other registered layer", () => {
    for (const z of STACK_BOTTOM_TO_TOP.slice(0, -1)) {
      expect(z, `layer at z=${z} would occlude the build badge`).toBeLessThan(
        Z_BUILD_BADGE,
      );
    }
  });

  it("exposes a usable config-select floating layer identifier", () => {
    expect(CONFIG_SELECT_FLOATING_LAYER_NAME.length).toBeGreaterThan(0);
    expect(CONFIG_SELECT_FLOATING_LAYER_NAME).toMatch(/^[A-Za-z][\w-]*$/);
  });
});
