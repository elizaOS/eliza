import { describe, expect, it } from "vitest";
import {
  requireTurnObservation,
  turnObservation,
  UNREADABLE_TURN_OBSERVATION,
} from "./turn-observation.ts";

const valid = {
  view: "calendar",
  revision: 4,
  sensitive: false,
  timeZone: "Europe/Berlin",
  selectedObject: {
    kind: "calendar-event",
    id: "event-1",
    revision: "r2",
    accountId: "calendar-a",
    sourceRevision: "s1",
  },
};

describe("device-action turn observation", () => {
  it("reads a contract observation", () => {
    const observation = turnObservation({ clientDevice: { context: valid } });
    expect(observation).toEqual(valid);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(
      requireTurnObservation({ clientDevice: { context: valid } }),
    ).toEqual(valid);
  });

  it("reports absence without inventing an observation", () => {
    expect(turnObservation(undefined)).toBeUndefined();
    expect(turnObservation({})).toBeUndefined();
    expect(turnObservation({ clientDevice: {} })).toBeUndefined();
    expect(() => requireTurnObservation({})).toThrow("Expected an object");
    expect(() => requireTurnObservation({ clientDevice: {} })).toThrow(
      "Expected an object",
    );
  });

  it("fences a present observation the contract rejects as private", () => {
    for (const context of [
      // An unadmitted field (for example legacy record contents) is not trusted.
      { ...valid, title: "Dentist" },
      // A selection without a view is not an observation.
      { revision: 1, sensitive: false, selectedObject: valid.selectedObject },
      // Clock alarm snapshots share the slot but are not view observations.
      { sensitive: false, revision: 0, alarmsStatus: "available", alarms: [] },
      "calendar",
    ]) {
      const metadata = { clientDevice: { context } };
      expect(turnObservation(metadata)).toBe(UNREADABLE_TURN_OBSERVATION);
      if (typeof context === "object")
        expect(requireTurnObservation(metadata)).toBe(
          UNREADABLE_TURN_OBSERVATION,
        );
    }
    expect(UNREADABLE_TURN_OBSERVATION.sensitive).toBe(true);
    expect(UNREADABLE_TURN_OBSERVATION.selectedObject).toBeUndefined();
    expect(UNREADABLE_TURN_OBSERVATION.timeZone).toBeUndefined();
  });
});
