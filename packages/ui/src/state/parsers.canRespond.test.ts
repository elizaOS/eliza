/**
 * Unit coverage for the `canRespond` readiness signal surviving parse of the WS
 * status event and feeding deriveAgentReady. Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import { parseAgentStatusEvent } from "./parsers";
import { deriveAgentReady } from "./types";

describe("parseAgentStatusEvent — canRespond readiness signal", () => {
  it("carries canRespond:true through from the WS status event", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: undefined,
      startedAt: 1000,
      canRespond: true,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.canRespond).toBe(true);
    // A dedicated cloud agent reports no locally-detected model; readiness must
    // come from the server-authoritative canRespond, not running+model.
    expect(deriveAgentReady(parsed)).toBe(true);
  });

  it("carries canRespond:false through (running but no provider) so the composer stays gated", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "gpt-oss-120b",
      canRespond: false,
    });
    expect(parsed?.canRespond).toBe(false);
    expect(deriveAgentReady(parsed)).toBe(false);
  });

  it("omits canRespond when the server doesn't report it (back-compat fallback to running+model)", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "gpt-oss-120b",
    });
    expect(parsed?.canRespond).toBeUndefined();
    // Falls back to running+model.
    expect(deriveAgentReady(parsed)).toBe(true);
  });

  it("ignores a non-boolean canRespond payload", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "m",
      canRespond: "yes" as unknown as boolean,
    });
    expect(parsed?.canRespond).toBeUndefined();
  });
});
