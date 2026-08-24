/**
 * Calendar API contract constants. Pins the exact ICS sync / source status /
 * visibility / change-delivery / feed-state / window-preset id lists that
 * persisted calendar rows, health records, and feed payloads depend on, and
 * asserts the structural invariants consumers rely on: no duplicate ids and
 * wire-safe lowercase snake_case spellings. Drives the real exports, no mocks.
 */
import { describe, expect, it } from "vitest";

import {
  LIFEOPS_CALENDAR_CHANGE_DELIVERY_STATUSES,
  LIFEOPS_CALENDAR_FEED_STATES,
  LIFEOPS_CALENDAR_SOURCE_STATUSES,
  LIFEOPS_CALENDAR_SOURCE_VISIBILITIES,
  LIFEOPS_CALENDAR_WINDOW_PRESETS,
  LIFEOPS_ICS_SOURCE_SYNC_STATUSES,
} from "./calendar";

const ALL_STATUS_LISTS = [
  LIFEOPS_ICS_SOURCE_SYNC_STATUSES,
  LIFEOPS_CALENDAR_SOURCE_STATUSES,
  LIFEOPS_CALENDAR_SOURCE_VISIBILITIES,
  LIFEOPS_CALENDAR_CHANGE_DELIVERY_STATUSES,
  LIFEOPS_CALENDAR_FEED_STATES,
  LIFEOPS_CALENDAR_WINDOW_PRESETS,
] as const;

describe("LifeOps calendar contract constants", () => {
  it("keeps ICS source sync statuses stable for persisted feed-source rows", () => {
    expect(LIFEOPS_ICS_SOURCE_SYNC_STATUSES).toEqual([
      "never",
      "fresh",
      "partial",
      "error",
    ]);
  });

  it("keeps calendar source snapshot statuses stable for health records", () => {
    expect(LIFEOPS_CALENDAR_SOURCE_STATUSES).toEqual([
      "fresh",
      "stale",
      "error",
      "disconnected",
    ]);
  });

  it("keeps source visibility modes stable for guest and free-busy consumers", () => {
    expect(LIFEOPS_CALENDAR_SOURCE_VISIBILITIES).toEqual([
      "details",
      "busy_only",
    ]);
  });

  it("keeps change-delivery statuses stable in lifecycle order", () => {
    expect(LIFEOPS_CALENDAR_CHANGE_DELIVERY_STATUSES).toEqual([
      "unconfigured",
      "starting",
      "active",
      "degraded",
      "expired",
      "revoked",
    ]);
  });

  it("keeps aggregated feed states stable for availability decisions", () => {
    expect(LIFEOPS_CALENDAR_FEED_STATES).toEqual([
      "complete",
      "partial",
      "unavailable",
    ]);
  });

  it("keeps scheduling window presets stable for create-event requests", () => {
    expect(LIFEOPS_CALENDAR_WINDOW_PRESETS).toEqual([
      "tomorrow_morning",
      "tomorrow_afternoon",
      "tomorrow_evening",
    ]);
  });
});

describe("calendar contract list invariants", () => {
  it("declares every id exactly once within each list", () => {
    for (const list of ALL_STATUS_LISTS) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("spells every id as a non-empty lowercase snake_case wire value", () => {
    for (const list of ALL_STATUS_LISTS) {
      expect(list.length).toBeGreaterThan(0);
      for (const id of list) {
        expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });
});
