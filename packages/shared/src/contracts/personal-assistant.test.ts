/**
 * Contract tests for the LifeOps shared connector definitions: `capabilitiesForSide`
 * scoping (owner side stays read-only, agent side gets the full declared set) and the
 * frozen provider / capability / degradation-axis id lists that persisted connector
 * status records depend on. Asserts against the real exported constants.
 */
import { describe, expect, it } from "vitest";

import {
  capabilitiesForSide,
  LIFEOPS_CONNECTOR_DEGRADATION_AXES,
  LIFEOPS_DISCORD_CAPABILITIES,
  LIFEOPS_GOOGLE_CAPABILITIES,
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
  LIFEOPS_SIGNAL_CAPABILITIES,
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
    expect(capabilitiesForSide(LIFEOPS_SIGNAL_CAPABILITIES, "owner")).toEqual([
      "signal.read",
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

  it("keeps health connector provider and capability ids stable", () => {
    expect(LIFEOPS_HEALTH_CONNECTOR_PROVIDERS).toEqual([
      "strava",
      "fitbit",
      "withings",
      "oura",
    ]);
    expect(LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES).toEqual([
      "health.activity.read",
      "health.workouts.read",
      "health.sleep.read",
      "health.readiness.read",
      "health.body.read",
      "health.vitals.read",
    ]);
  });

  it("keeps connector degradation axes stable for persisted status records", () => {
    expect(LIFEOPS_CONNECTOR_DEGRADATION_AXES).toEqual([
      "missing-scope",
      "rate-limited",
      "disconnected",
      "auth-expired",
      "session-revoked",
      "delivery-degraded",
      "helper-disconnected",
      "retry-idempotent",
      "hold-expired",
      "transport-offline",
      "blocked-resume",
    ]);
  });
});
