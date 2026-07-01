// @vitest-environment jsdom
//
// Behavioral test for the SOLE chat -> background bridge.
//
// `useBackgroundApplyChannel` is the one subscriber to the agent's
// `background:apply` view event. It takes an UNTRUSTED agent payload and drives
// the SAME `BackgroundConfig` store the Background view + AppBackground share.
//
// This test drives the REAL transport (emitViewEvent over the real view-event
// bus) into the REAL store (useDisplayPreferences, persisted to localStorage)
// and asserts the visible outcome on the REAL AppBackground DOM. Nothing about
// the unit under test is mocked; the only "double" is a thin harness that wires
// useDisplayPreferences into the app-store singleton exactly the way AppContext
// does in production (seedAppValue during render + publishAppValue in a
// commit-time effect).
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setAppValueForTests,
  publishAppValue,
  seedAppValue,
} from "../state/app-store";
import { loadBackgroundHistory } from "../state/persistence";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";
import { useDisplayPreferences } from "../state/useDisplayPreferences";
import { emitViewEvent } from "../views/view-event-bus";
import { AppBackground } from "./AppBackground";
import { BACKGROUND_APPLY_EVENT } from "./useBackgroundApplyChannel";

// Wire the REAL background store (useDisplayPreferences) into the app-store
// singleton that useBackgroundConfig reads from, mirroring AppContext's wiring:
// seed the fresh snapshot during render, publish (notify) from a commit effect.
function Harness() {
  const prefs = useDisplayPreferences();
  const value = useMemo(
    () => ({
      backgroundConfig: prefs.state.backgroundConfig,
      setBackgroundConfig: prefs.setBackgroundConfig,
      undoBackgroundConfig: prefs.undoBackgroundConfig,
      canUndoBackground: prefs.state.canUndoBackground,
    }),
    [
      prefs.state.backgroundConfig,
      prefs.setBackgroundConfig,
      prefs.undoBackgroundConfig,
      prefs.state.canUndoBackground,
    ],
  );
  seedAppValue(value as never);
  useEffect(() => {
    publishAppValue(value as never);
  }, [value]);
  return <AppBackground />;
}

function apply(payload: Record<string, unknown>): void {
  act(() => {
    emitViewEvent(BACKGROUND_APPLY_EVENT, payload, "agent");
  });
}

function shader(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="app-background-shader"]',
  );
}
function image(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="app-background-image"]',
  );
}

const DEFAULT_RGB = "rgb(239, 90, 31)"; // #ef5a1f
const GREEN = "#059669";
const GREEN_RGB = "rgb(5, 150, 105)";
const ROSE = "#e11d48";
const ROSE_RGB = "rgb(225, 29, 72)";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  localStorage.clear();
});

describe("useBackgroundApplyChannel — chat -> background bridge", () => {
  it("op=set with a valid color mutates the real store, DOM, and persistence", () => {
    const { container } = render(<Harness />);
    expect(shader(container)?.style.backgroundColor).toBe(DEFAULT_RGB);

    apply({ op: "set", color: GREEN });

    // Real DOM reflects the new color.
    expect(shader(container)?.style.backgroundColor).toBe(GREEN_RGB);
    // Real persisted store slice was written by the store's save effect.
    expect(loadBackgroundHistory().length).toBe(1); // previous default pushed
  });

  it("op=set with mode=image + url swaps the shader for a cover image", () => {
    const { container } = render(<Harness />);
    apply({ op: "set", mode: "image", imageUrl: "/api/media/pic.png" });

    const img = image(container);
    expect(img).not.toBeNull();
    expect(img?.style.backgroundImage).toContain("/api/media/pic.png");
    // The shader layer is gone once image mode is active.
    expect(shader(container)).toBeNull();
  });

  it("op=undo restores the previous config", () => {
    const { container } = render(<Harness />);
    apply({ op: "set", color: GREEN });
    apply({ op: "set", color: ROSE });
    expect(shader(container)?.style.backgroundColor).toBe(ROSE_RGB);

    apply({ op: "undo" });
    expect(shader(container)?.style.backgroundColor).toBe(GREEN_RGB);
  });

  it("op=reset returns to the default background", () => {
    const { container } = render(<Harness />);
    apply({ op: "set", color: ROSE });
    expect(shader(container)?.style.backgroundColor).toBe(ROSE_RGB);

    apply({ op: "reset" });
    expect(shader(container)?.style.backgroundColor).toBe(DEFAULT_RGB);
  });

  it("sanitizes an adversarial color string to the default (never raw)", () => {
    const { container } = render(<Harness />);
    // A CSS-injection attempt: not a 6-digit hex -> normalized to default.
    apply({ op: "set", color: "red; background: url(https://evil.example/x)" });

    const bg = shader(container)?.style.backgroundColor;
    expect(bg).toBe(DEFAULT_RGB); // normalized, not the injected string
    expect(bg).not.toContain("evil");
    // Normalizing to the already-current default is a no-op: no store churn.
    expect(loadBackgroundHistory().length).toBe(0);
  });

  it("rejects a set with no color and no url (no apply, no store churn)", () => {
    const { container } = render(<Harness />);
    apply({ op: "set" });

    expect(shader(container)?.style.backgroundColor).toBe(DEFAULT_RGB);
    expect(image(container)).toBeNull();
    expect(loadBackgroundHistory().length).toBe(0);
  });

  it("rejects image mode without a url (never mounts an empty image layer)", () => {
    const { container } = render(<Harness />);
    apply({ op: "set", mode: "image" }); // missing imageUrl
    apply({ op: "set", mode: "image", imageUrl: "" }); // empty imageUrl

    expect(image(container)).toBeNull();
    expect(shader(container)?.style.backgroundColor).toBe(DEFAULT_RGB);
    expect(loadBackgroundHistory().length).toBe(0);
  });

  it("treats an unknown op string as set (only undo/reset are special-cased)", () => {
    const { container } = render(<Harness />);
    apply({ op: "totally-made-up", color: GREEN });
    // Fell through to the set path — the color applied, no crash.
    expect(shader(container)?.style.backgroundColor).toBe(GREEN_RGB);
  });

  it("is idempotent under rapid-fire identical sets (no history churn)", () => {
    const { container } = render(<Harness />);
    apply({ op: "set", color: GREEN });
    apply({ op: "set", color: GREEN });
    apply({ op: "set", color: GREEN });

    expect(shader(container)?.style.backgroundColor).toBe(GREEN_RGB);
    // Only the first set pushed the outgoing default; the repeats were no-ops.
    expect(loadBackgroundHistory().length).toBe(1);
    // A single undo therefore steps all the way back to the default.
    apply({ op: "undo" });
    expect(shader(container)?.style.backgroundColor).toBe(DEFAULT_RGB);
  });

  it("undo with empty history is a safe no-op that does not wedge the channel", () => {
    const { container } = render(<Harness />);
    apply({ op: "undo" }); // nothing to undo
    // The no-op must create no spurious history entry (a bare default-fallback
    // DOM check would pass even if the guard were removed; the length + the
    // still-functional-after assertions below are what actually pin the guard).
    expect(loadBackgroundHistory().length).toBe(0);
    expect(shader(container)?.style.backgroundColor).toBe(DEFAULT_RGB);
    // Critically, the empty-history undo must not wedge the subscriber — a
    // subsequent valid set still applies. If the undo path threw/latched, this
    // fails instead of silently falling back to the default.
    apply({ op: "set", color: GREEN });
    expect(shader(container)?.style.backgroundColor).toBe(GREEN_RGB);
    expect(loadBackgroundHistory().length).toBe(1);
  });
});
