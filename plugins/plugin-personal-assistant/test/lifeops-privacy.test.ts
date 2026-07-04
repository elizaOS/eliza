// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { DEFAULT_PRIVACY_LEVEL, type PrivacyLevel } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  canSurfaceForAudience,
  LIFEOPS_REDACTED_PLACEHOLDER,
  type LifeOpsAudience,
  redactedPlaceholder,
} from "../src/lifeops/privacy.js";

/**
 * The privacy lattice decides whether connector-account content may be surfaced
 * to a given audience — a security boundary. A wrong cell leaks owner-only data
 * to a message recipient or the public, so the whole matrix is pinned.
 */

const AUDIENCES: LifeOpsAudience[] = [
  "owner",
  "team",
  "agent_message_recipient",
  "public",
];

// Expected allow-set per privacy level (the spec lattice in the module doc).
const ALLOWED: Record<PrivacyLevel, Set<LifeOpsAudience>> = {
  owner_only: new Set(["owner"]),
  team_visible: new Set(["owner", "team"]),
  semi_public: new Set(["owner", "team", "agent_message_recipient"]),
  public: new Set(["owner", "team", "agent_message_recipient", "public"]),
} as Record<PrivacyLevel, Set<LifeOpsAudience>>;

describe("canSurfaceForAudience — privacy lattice", () => {
  for (const privacy of Object.keys(ALLOWED) as PrivacyLevel[]) {
    for (const audience of AUDIENCES) {
      const expected = ALLOWED[privacy].has(audience);
      it(`${privacy} → ${audience} = ${expected}`, () => {
        expect(canSurfaceForAudience(privacy, audience)).toBe(expected);
      });
    }
  }

  it("always allows the owner regardless of privacy level", () => {
    for (const privacy of Object.keys(ALLOWED) as PrivacyLevel[]) {
      expect(canSurfaceForAudience(privacy, "owner")).toBe(true);
    }
  });

  it("never surfaces owner_only data to a non-owner audience", () => {
    expect(canSurfaceForAudience("owner_only", "team")).toBe(false);
    expect(canSurfaceForAudience("owner_only", "agent_message_recipient")).toBe(
      false,
    );
    expect(canSurfaceForAudience("owner_only", "public")).toBe(false);
  });

  it("defaults to deny for an unknown privacy level", () => {
    expect(canSurfaceForAudience("nonsense" as PrivacyLevel, "team")).toBe(
      false,
    );
  });
});

describe("redactedPlaceholder", () => {
  it("uses the canonical placeholder for the default (owner_only) level", () => {
    expect(redactedPlaceholder(DEFAULT_PRIVACY_LEVEL)).toBe(
      LIFEOPS_REDACTED_PLACEHOLDER,
    );
  });

  it("names the level for non-default redactions", () => {
    expect(redactedPlaceholder("team_visible" as PrivacyLevel)).toBe(
      "[redacted: team_visible]",
    );
    expect(redactedPlaceholder("semi_public" as PrivacyLevel)).toBe(
      "[redacted: semi_public]",
    );
  });
});
