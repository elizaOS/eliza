/**
 * Calendar sources name the owner's account emails and calendar ids. The
 * provider is owner-only, and it must also be owner-exclusive for the
 * delivery audience, like the calendar review action.
 */
import { OWNER_EXCLUSIVE_DISCLOSURE_GATE } from "@elizaos/core";
import { expect, it } from "vitest";
import { calendarSourcesProvider } from "./calendar-sources.js";

it("is owner-exclusive for the delivery audience", () => {
  expect(calendarSourcesProvider.roleGate).toEqual({ minRole: "OWNER" });
  expect(calendarSourcesProvider.disclosureGate).toBe(
    OWNER_EXCLUSIVE_DISCLOSURE_GATE,
  );
});
