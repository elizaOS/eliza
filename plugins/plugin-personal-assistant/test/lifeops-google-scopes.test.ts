// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  GOOGLE_GMAIL_METADATA_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  GOOGLE_GMAIL_SETTINGS_BASIC_SCOPE,
  googleCapabilitiesToScopes,
  googleScopesToCapabilities,
  normalizeGoogleCapabilities,
  unionGoogleCapabilities,
} from "../src/lifeops/google-scopes.js";

/**
 * The capability⇄scope mapping is the source of truth for what a Google grant
 * can do (the #8833 owner/agent OAuth matrix). It must stay exact: a wrong map
 * over- or under-grants real Google access.
 */

describe("normalizeGoogleCapabilities", () => {
  it("always includes basic_identity and dedupes", () => {
    const out = normalizeGoogleCapabilities([
      "google.calendar.read",
      "google.calendar.read",
    ]);
    expect(out).toContain("google.basic_identity");
    expect(out.filter((c) => c === "google.calendar.read")).toHaveLength(1);
  });

  it("drops unknown / non-string entries", () => {
    const out = normalizeGoogleCapabilities([
      "google.calendar.read",
      "not.a.capability",
      42,
      null,
    ] as unknown[]);
    expect(out).toContain("google.calendar.read");
    expect(out).not.toContain("not.a.capability");
    expect(out.every((c) => typeof c === "string")).toBe(true);
  });

  it("falls back to the default set when value is undefined", () => {
    const out = normalizeGoogleCapabilities(undefined);
    expect(out).toContain("google.basic_identity");
    expect(out.length).toBeGreaterThan(1);
  });
});

describe("unionGoogleCapabilities", () => {
  it("merges and dedupes across lists", () => {
    const out = unionGoogleCapabilities(
      ["google.calendar.read"],
      ["google.calendar.read", "google.gmail.send"],
    );
    expect(out.filter((c) => c === "google.calendar.read")).toHaveLength(1);
    expect(out).toContain("google.gmail.send");
  });

  it("returns the default set when no list contributes", () => {
    const out = unionGoogleCapabilities(undefined, undefined);
    expect(out).toContain("google.basic_identity");
    expect(out.length).toBeGreaterThan(1);
  });

  it("yields just basic_identity for a present-but-empty list", () => {
    // An empty (but provided) list normalizes to [basic_identity], so it
    // contributes that and does NOT fall through to the full default set.
    expect(unionGoogleCapabilities([])).toEqual(["google.basic_identity"]);
  });
});

describe("googleCapabilitiesToScopes", () => {
  it("maps capabilities to their OAuth scopes and dedupes", () => {
    const scopes = googleCapabilitiesToScopes(["google.calendar.write"]);
    expect(scopes).toContain(GOOGLE_CALENDAR_WRITE_SCOPE);
    // basic_identity is always normalized in → openid scopes present.
    expect(scopes).toContain("openid");
  });

  it("expands gmail.manage to both modify and settings.basic", () => {
    const scopes = googleCapabilitiesToScopes(["google.gmail.manage"]);
    expect(scopes).toContain(GOOGLE_GMAIL_MODIFY_SCOPE);
    expect(scopes).toContain(GOOGLE_GMAIL_SETTINGS_BASIC_SCOPE);
  });
});

describe("googleScopesToCapabilities", () => {
  it("derives basic_identity from any openid scope", () => {
    expect(googleScopesToCapabilities(["email"])).toContain(
      "google.basic_identity",
    );
  });

  it("treats calendar write scope as also granting read", () => {
    const caps = googleScopesToCapabilities([GOOGLE_CALENDAR_WRITE_SCOPE]);
    expect(caps).toContain("google.calendar.read");
    expect(caps).toContain("google.calendar.write");
  });

  it("grants calendar read without write for the readonly scope", () => {
    const caps = googleScopesToCapabilities([GOOGLE_CALENDAR_READ_SCOPE]);
    expect(caps).toContain("google.calendar.read");
    expect(caps).not.toContain("google.calendar.write");
  });

  it("derives gmail triage from metadata OR readonly", () => {
    expect(googleScopesToCapabilities([GOOGLE_GMAIL_METADATA_SCOPE])).toContain(
      "google.gmail.triage",
    );
    expect(googleScopesToCapabilities([GOOGLE_GMAIL_READ_SCOPE])).toContain(
      "google.gmail.triage",
    );
  });

  it("requires BOTH modify and settings.basic for gmail.manage", () => {
    expect(
      googleScopesToCapabilities([GOOGLE_GMAIL_MODIFY_SCOPE]),
    ).not.toContain("google.gmail.manage");
    expect(
      googleScopesToCapabilities([GOOGLE_GMAIL_SETTINGS_BASIC_SCOPE]),
    ).not.toContain("google.gmail.manage");
    expect(
      googleScopesToCapabilities([
        GOOGLE_GMAIL_MODIFY_SCOPE,
        GOOGLE_GMAIL_SETTINGS_BASIC_SCOPE,
      ]),
    ).toContain("google.gmail.manage");
  });

  it("returns no capabilities for an empty grant", () => {
    expect(googleScopesToCapabilities([])).toEqual([]);
    expect(googleScopesToCapabilities(["  ", ""])).toEqual([]);
  });

  it("round-trips send through scopes back to capabilities", () => {
    const scopes = googleCapabilitiesToScopes(["google.gmail.send"]);
    expect(scopes).toContain(GOOGLE_GMAIL_SEND_SCOPE);
    expect(googleScopesToCapabilities(scopes)).toContain("google.gmail.send");
  });
});
