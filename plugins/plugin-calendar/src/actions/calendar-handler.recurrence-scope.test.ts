/**
 * Pins the planner-boundary contract for `recurrenceScope`: recognized values
 * normalize, junk degrades to "not specified" (falling back to the user's own
 * phrasing), and ambiguity stays null. Deterministic — drives the exported
 * resolver directly, no runtime or model.
 *
 * The case that matters: small models filling the aliased schema have been
 * observed emitting fragments of neighboring key names into detail values.
 * `normalizeRecurrenceScope` fail-closes such input with a 400 — correct for
 * API callers, but at the action boundary it killed the whole update/delete
 * turn for a value that carries no user intent, while every sibling detail
 * (calendarId, windows, mode, side, grantId) already degrades junk to unset.
 */

import { describe, expect, it } from "vitest";

import { resolveRecurrenceScopeIntent } from "./calendar-handler.js";

describe("resolveRecurrenceScopeIntent planner boundary", () => {
  it("honors a recognized explicit scope", () => {
    expect(
      resolveRecurrenceScopeIntent({
        details: { recurrenceScope: "series" },
        text: "delete my standup",
      }),
    ).toBe("series");
  });

  it("treats planner debris as unspecified instead of throwing", () => {
    expect(
      resolveRecurrenceScopeIntent({
        details: { recurrenceScope: ',time_max:"' },
        text: "delete my standup",
      }),
    ).toBeNull();
  });

  it("falls back to the user's own phrasing past a junk detail", () => {
    expect(
      resolveRecurrenceScopeIntent({
        details: { recurrenceScope: ",series:" },
        text: "cancel just this one occurrence of the standup",
      }),
    ).toBe("instance");
  });

  it("treats debris from the update extraction as unspecified", () => {
    expect(
      resolveRecurrenceScopeIntent({
        details: undefined,
        fallbackDetails: { recurrenceScope: ',series:"' },
        text: "change the standup",
      }),
    ).toBeNull();
  });

  it("uses explicit update extraction before falling back to phrasing", () => {
    expect(
      resolveRecurrenceScopeIntent({
        details: undefined,
        fallbackDetails: { recurrenceScope: "series" },
        text: "change just this standup occurrence",
      }),
    ).toBe("series");
  });

  it("stays null when both detail and phrasing are ambiguous", () => {
    expect(
      resolveRecurrenceScopeIntent({
        details: undefined,
        text: "change the standup",
      }),
    ).toBeNull();
  });
});
