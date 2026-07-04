// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeBrowserPermissionStateInput,
  normalizeGoogleCapabilityRequest,
  normalizeOptionalConnectorMode,
  normalizeOrigin,
  normalizeWorkflowSchedule,
} from "../src/lifeops/service-normalize-connector.js";

/**
 * LifeOps connector input normalization runs on owner-/LLM-supplied connector
 * config. normalizeOrigin is a small SSRF-adjacent guard: it accepts only
 * http(s) and collapses any URL to its bare origin (so a path/query can't ride
 * along into a stored grant). The enum/record normalizers must reject malformed
 * shapes with a 400 rather than pass them through.
 */

describe("normalizeOrigin", () => {
  it("returns the bare origin for http(s) URLs", () => {
    expect(normalizeOrigin("https://example.com/some/path?q=1", "origin")).toBe(
      "https://example.com",
    );
    expect(normalizeOrigin("http://localhost:3000", "origin")).toBe(
      "http://localhost:3000",
    );
  });

  it("rejects non-http schemes and invalid URLs", () => {
    expect(() => normalizeOrigin("ftp://example.com", "origin")).toThrow();
    expect(() => normalizeOrigin("javascript:alert(1)", "origin")).toThrow();
    expect(() => normalizeOrigin("not a url", "origin")).toThrow();
    expect(() => normalizeOrigin("", "origin")).toThrow();
  });
});

describe("normalizeWorkflowSchedule", () => {
  it("manual trigger yields a manual schedule regardless of value", () => {
    expect(normalizeWorkflowSchedule(undefined, "manual")).toEqual({
      kind: "manual",
    });
  });
});

describe("normalizeGoogleCapabilityRequest", () => {
  it("returns undefined when absent, throws for a non-array", () => {
    expect(normalizeGoogleCapabilityRequest(undefined)).toBeUndefined();
    expect(() => normalizeGoogleCapabilityRequest("gmail")).toThrow(
      /must be an array/,
    );
  });
});

describe("normalizeOptionalConnectorMode", () => {
  it("treats empty as undefined, rejects an unknown mode", () => {
    expect(normalizeOptionalConnectorMode(undefined, "mode")).toBeUndefined();
    expect(normalizeOptionalConnectorMode("", "mode")).toBeUndefined();
    expect(() =>
      normalizeOptionalConnectorMode("bogus-mode", "mode"),
    ).toThrow();
  });
});

describe("normalizeBrowserPermissionStateInput", () => {
  it("clones the current state (fresh grantedOrigins array) when input is undefined", () => {
    const current = {
      tabs: true,
      scripting: false,
      activeTab: true,
      allOrigins: false,
      grantedOrigins: ["https://a.com"],
      incognitoEnabled: false,
    };
    const out = normalizeBrowserPermissionStateInput(undefined, current);
    expect(out).toEqual(current);
    expect(out.grantedOrigins).not.toBe(current.grantedOrigins); // defensive copy
  });
});
