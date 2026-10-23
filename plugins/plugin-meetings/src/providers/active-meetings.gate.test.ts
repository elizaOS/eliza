/**
 * Meeting URLs can carry join passwords. The provider is owner-only, and it
 * must also be owner-exclusive for the delivery audience: an owner turn in a
 * public group room must not compose it.
 */
import { OWNER_EXCLUSIVE_DISCLOSURE_GATE } from "@elizaos/core";
import { expect, it } from "vitest";
import { activeMeetingsProvider } from "./active-meetings.js";

it("is owner-exclusive for the delivery audience", () => {
  expect(activeMeetingsProvider.roleGate).toEqual({ minRole: "OWNER" });
  expect(activeMeetingsProvider.disclosureGate).toBe(
    OWNER_EXCLUSIVE_DISCLOSURE_GATE,
  );
});
