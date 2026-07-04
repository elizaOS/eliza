/**
 * Unit tests for the status-badge label helpers (pure functions, no DOM):
 * `statusLabelForState` title-cases raw enums for the dev/admin console, and
 * `agentLifecycleLabel` maps lifecycle states to friendly onboarding copy while
 * leaving non-lifecycle (e.g. Steward transaction) states title-cased.
 */
import { describe, expect, it } from "vitest";
import {
  agentLifecycleLabel,
  statusLabelForState,
} from "./status-badge.helpers";

describe("statusLabelForState", () => {
  it("title-cases the raw enum (dev/admin console copy)", () => {
    expect(statusLabelForState("resuming")).toBe("Resuming");
    expect(statusLabelForState("suspended")).toBe("Suspended");
    expect(statusLabelForState("provisioning")).toBe("Provisioning");
    expect(statusLabelForState("agent_delete")).toBe("Agent Delete");
  });

  it("returns the original string when empty/whitespace", () => {
    expect(statusLabelForState("")).toBe("");
    expect(statusLabelForState("   ")).toBe("   ");
  });
});

describe("agentLifecycleLabel", () => {
  it("maps lifecycle states to friendly first-run/handoff copy", () => {
    // The raw DB enum must not leak to users during onboarding.
    expect(agentLifecycleLabel("resuming")).toBe("Starting up");
    expect(agentLifecycleLabel("starting")).toBe("Starting up");
    expect(agentLifecycleLabel("provisioning")).toBe("Setting up");
    expect(agentLifecycleLabel("suspended")).toBe("Asleep");
    expect(agentLifecycleLabel("sleeping")).toBe("Asleep");
    expect(agentLifecycleLabel("running")).toBe("Ready");
    expect(agentLifecycleLabel("failed")).toBe("Failed to start");
  });

  it("is case-insensitive", () => {
    expect(agentLifecycleLabel("RUNNING")).toBe("Ready");
    expect(agentLifecycleLabel("  Provisioning  ")).toBe("Setting up");
  });

  it("falls back to the title-cased label for non-lifecycle states", () => {
    // Steward transaction states (broadcast/confirmed/signed) must keep their
    // own labels — agentLifecycleLabel must not clobber them.
    expect(agentLifecycleLabel("broadcast")).toBe("Broadcast");
    expect(agentLifecycleLabel("confirmed")).toBe("Confirmed");
    expect(agentLifecycleLabel("totally-unknown")).toBe("Totally Unknown");
  });
});
