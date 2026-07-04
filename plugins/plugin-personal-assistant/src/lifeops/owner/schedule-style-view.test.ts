/**
 * Spine-read coverage for the learned schedule-shape facts (#12778).
 *
 * #13233 landed the `scheduleStyle` / `chronotype` owner facts + their
 * `agent_inferred` writer, but did NOT wire them onto the scheduling spine's
 * `OwnerFactsView`. This exercises `ownerFactsToView` directly, asserting the
 * mapper now projects both facts onto the view the runner / gates read via
 * `defaultOwnerFactsProvider`, completing "queryable structural facts".
 *
 * Pure transform — no runtime graph. The view type is the real
 * `@elizaos/plugin-scheduling` `OwnerFactsView`, so this also proves the spine
 * contract actually carries the fields (a compile error here would mean the
 * view was never widened).
 */
import type { OwnerFactsView } from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import {
  type OwnerFactProvenance,
  type OwnerFacts,
  ownerFactsToView,
} from "./fact-store.ts";

const NOW = new Date("2026-07-04T12:00:00.000Z");

const inferred: OwnerFactProvenance = {
  source: "agent_inferred",
  recordedAt: "2026-07-01T00:00:00.000Z",
  note: "learned from schedule-insight regularity",
};

describe("ownerFactsToView — schedule-style spine read (#12778)", () => {
  it("projects scheduleStyle and chronotype onto the spine view", () => {
    const facts: OwnerFacts = {
      scheduleStyle: { value: "irregular", provenance: inferred },
      chronotype: { value: "late", provenance: inferred },
    };
    const view: OwnerFactsView = ownerFactsToView(facts, NOW);
    expect(view.scheduleStyle).toBe("irregular");
    expect(view.chronotype).toBe("late");
  });

  it("carries each classification value the writer can emit", () => {
    for (const style of ["regular", "irregular", "rotating"] as const) {
      const view = ownerFactsToView(
        { scheduleStyle: { value: style, provenance: inferred } },
        NOW,
      );
      expect(view.scheduleStyle).toBe(style);
    }
    for (const chrono of ["early", "intermediate", "late"] as const) {
      const view = ownerFactsToView(
        { chronotype: { value: chrono, provenance: inferred } },
        NOW,
      );
      expect(view.chronotype).toBe(chrono);
    }
  });

  it("omits the fields when the facts are absent (absence != a value)", () => {
    const view = ownerFactsToView({}, NOW);
    expect(view.scheduleStyle).toBeUndefined();
    expect(view.chronotype).toBeUndefined();
  });

  it("drops provenance but preserves the value (readers want the value)", () => {
    const view = ownerFactsToView(
      {
        scheduleStyle: { value: "rotating", provenance: inferred },
        chronotype: { value: "early", provenance: inferred },
      },
      NOW,
    );
    // The view is provenance-free by contract; only the raw classification
    // reaches the spine.
    expect(view).toMatchObject({
      scheduleStyle: "rotating",
      chronotype: "early",
    });
    expect(JSON.stringify(view)).not.toContain("agent_inferred");
  });
});
