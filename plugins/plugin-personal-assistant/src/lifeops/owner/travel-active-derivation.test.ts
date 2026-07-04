/**
 * Pure-transform coverage for the derived `travelActive` field (#12284 item 3).
 * No runtime graph: exercises `ownerFactsToView` directly against synthetic
 * `OwnerFacts`, asserting the boolean is DERIVED from the `activeTravel` window
 * against `now` — true inside the window, false outside, undefined with no
 * record — and that the destination zone overrides the home zone while active.
 */
import { describe, expect, it } from "vitest";
import {
  type OwnerFactProvenance,
  type OwnerFacts,
  ownerFactsToView,
} from "./fact-store.ts";

const provenance: OwnerFactProvenance = {
  source: "connector_inferred",
  recordedAt: "2026-07-01T00:00:00.000Z",
};

const at = (iso: string): Date => new Date(iso);

function factsWithTravel(
  travel: { startIso: string; endIso?: string; destinationTimezone?: string },
  extra: Partial<OwnerFacts> = {},
): OwnerFacts {
  return { activeTravel: { value: travel, provenance }, ...extra };
}

describe("ownerFactsToView — travelActive derivation", () => {
  it("no activeTravel record => travelActive undefined (missing != not-traveling)", () => {
    const view = ownerFactsToView({}, at("2026-07-10T12:00:00.000Z"));
    expect(view.travelActive).toBeUndefined();
  });

  it("now inside [start, end] => travelActive true", () => {
    const view = ownerFactsToView(
      factsWithTravel({
        startIso: "2026-07-10T00:00:00.000Z",
        endIso: "2026-07-20T00:00:00.000Z",
      }),
      at("2026-07-15T12:00:00.000Z"),
    );
    expect(view.travelActive).toBe(true);
  });

  it("now before start => travelActive false", () => {
    const view = ownerFactsToView(
      factsWithTravel({
        startIso: "2026-07-10T00:00:00.000Z",
        endIso: "2026-07-20T00:00:00.000Z",
      }),
      at("2026-07-05T12:00:00.000Z"),
    );
    expect(view.travelActive).toBe(false);
  });

  it("now after end => travelActive false", () => {
    const view = ownerFactsToView(
      factsWithTravel({
        startIso: "2026-07-10T00:00:00.000Z",
        endIso: "2026-07-20T00:00:00.000Z",
      }),
      at("2026-07-25T12:00:00.000Z"),
    );
    expect(view.travelActive).toBe(false);
  });

  it("boundaries are inclusive (start and end instants count as active)", () => {
    const window = {
      startIso: "2026-07-10T00:00:00.000Z",
      endIso: "2026-07-20T00:00:00.000Z",
    };
    expect(
      ownerFactsToView(factsWithTravel(window), at(window.startIso))
        .travelActive,
    ).toBe(true);
    expect(
      ownerFactsToView(factsWithTravel(window), at(window.endIso)).travelActive,
    ).toBe(true);
  });

  it("open-ended window (no endIso) => active for any now at/after start", () => {
    const view = ownerFactsToView(
      factsWithTravel({ startIso: "2026-07-10T00:00:00.000Z" }),
      at("2027-01-01T00:00:00.000Z"),
    );
    expect(view.travelActive).toBe(true);
  });

  it("destinationTimezone overrides home timezone while travel is active", () => {
    const view = ownerFactsToView(
      factsWithTravel(
        {
          startIso: "2026-07-10T00:00:00.000Z",
          endIso: "2026-07-20T00:00:00.000Z",
          destinationTimezone: "Asia/Tokyo",
        },
        { timezone: { value: "America/New_York", provenance } },
      ),
      at("2026-07-15T12:00:00.000Z"),
    );
    expect(view.travelActive).toBe(true);
    expect(view.timezone).toBe("Asia/Tokyo");
  });

  it("destinationTimezone does NOT override once travel is over", () => {
    const view = ownerFactsToView(
      factsWithTravel(
        {
          startIso: "2026-07-10T00:00:00.000Z",
          endIso: "2026-07-20T00:00:00.000Z",
          destinationTimezone: "Asia/Tokyo",
        },
        { timezone: { value: "America/New_York", provenance } },
      ),
      at("2026-07-25T12:00:00.000Z"),
    );
    expect(view.travelActive).toBe(false);
    expect(view.timezone).toBe("America/New_York");
  });

  it("home timezone is preserved when travel has no destination zone", () => {
    const view = ownerFactsToView(
      factsWithTravel(
        {
          startIso: "2026-07-10T00:00:00.000Z",
          endIso: "2026-07-20T00:00:00.000Z",
        },
        { timezone: { value: "America/New_York", provenance } },
      ),
      at("2026-07-15T12:00:00.000Z"),
    );
    expect(view.travelActive).toBe(true);
    expect(view.timezone).toBe("America/New_York");
  });
});
