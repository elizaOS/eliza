/** Exercises owner read-only and agent capability selection through the real filter. */
import { describe, expect, it } from "vitest";

import {
  capabilitiesForSide,
  LIFEOPS_DISCORD_CAPABILITIES,
  LIFEOPS_GOOGLE_CAPABILITIES,
  LIFEOPS_TELEGRAM_CAPABILITIES,
  LIFEOPS_X_CAPABILITIES,
} from "./personal-assistant";

describe("LifeOps shared contracts", () => {
  it("keeps owner-side capabilities read-only", () => {
    expect(capabilitiesForSide(LIFEOPS_GOOGLE_CAPABILITIES, "owner")).toEqual([
      "google.calendar.read",
    ]);
    expect(capabilitiesForSide(LIFEOPS_X_CAPABILITIES, "owner")).toEqual([
      "x.read",
      "x.dm.read",
    ]);
    expect(capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, "owner")).toEqual([
      "discord.read",
    ]);
    expect(capabilitiesForSide(LIFEOPS_TELEGRAM_CAPABILITIES, "owner")).toEqual(
      ["telegram.read"],
    );
  });

  it("allows agent-side connectors to use the full declared capability set", () => {
    expect(capabilitiesForSide(LIFEOPS_GOOGLE_CAPABILITIES, "agent")).toEqual([
      ...LIFEOPS_GOOGLE_CAPABILITIES,
    ]);
    expect(capabilitiesForSide(LIFEOPS_X_CAPABILITIES, "agent")).toEqual([
      ...LIFEOPS_X_CAPABILITIES,
    ]);
  });
});
