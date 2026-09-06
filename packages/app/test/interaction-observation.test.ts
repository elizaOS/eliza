/**
 * Exercises the renderer observation oracle with deterministic control states.
 * Background polling and rejected transport-only mutations must not make an
 * inert control pass; actual renderer transitions remain activity observations.
 */
import { describe, expect, it } from "vitest";
import {
  type ControlSnapshot,
  interactionDelta,
} from "./ui-smoke/interaction-observation";

function snapshot(): ControlSnapshot {
  return {
    url: "http://localhost/notes",
    visibleDismissibleSurfaces: 0,
    pageFingerprint: "unchanged",
    details: {
      tagName: "button",
      role: null,
      type: "button",
      href: null,
      visible: true,
      label: "Save",
      text: "Save",
      value: null,
      checked: null,
      attributes: {},
    },
  };
}

describe("bounded interaction activity oracle", () => {
  it("does not credit unrelated polling or a rejected mutation as an outcome", () => {
    const before = { ...snapshot(), apiRequestCount: 0 };
    // These are the snapshots produced around a no-op click while a poll and
    // rejected mutation generate traffic. Neither changes the renderer.
    const afterPolling = { ...snapshot(), apiRequestCount: 1 };
    const afterRejectedMutation = { ...snapshot(), apiRequestCount: 2 };
    expect(interactionDelta(before, afterPolling)).toBeNull();
    expect(interactionDelta(before, afterRejectedMutation)).toBeNull();
  });

  it("observes a changed control or opened dialog without requiring traffic", () => {
    const before = snapshot();
    const after = snapshot();
    if (!after.details) throw new Error("Fixture requires a control");
    after.details.attributes["aria-expanded"] = "true";
    expect(interactionDelta(before, after)).not.toBeNull();
    expect(
      interactionDelta(before, {
        ...snapshot(),
        visibleDismissibleSurfaces: 1,
      }),
    ).not.toBeNull();
  });

  it("observes navigation but leaves identical renderer states unresolved", () => {
    expect(interactionDelta(snapshot(), snapshot())).toBeNull();
    expect(
      interactionDelta(snapshot(), {
        ...snapshot(),
        url: "http://localhost/todos",
      }),
    ).not.toBeNull();
  });
});
