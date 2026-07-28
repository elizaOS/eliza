/**
 * Deterministic locale-resolution coverage over reviewed resource fixtures.
 * No network or hotline provider is substituted: these tests verify freshness,
 * exact jurisdiction matching, and no-contact failure states.
 */

import { describe, expect, it } from "vitest";
import {
  PARENTING_HANDOFF_RESOURCES,
  type ParentingLocaleEvidence,
  ReviewedParentingHandoffResourceResolver,
} from "./resources.js";

const REQUESTED_AT = "2026-07-27T12:00:00.000Z";

function localeEvidence(locale: string): ParentingLocaleEvidence {
  return {
    status: "resolved",
    locale,
    source: "runtime_locale_provider",
    observedAt: REQUESTED_AT,
    provenance: null,
    unavailableReason: null,
  };
}

describe("ReviewedParentingHandoffResourceResolver", () => {
  it("resolves every requested US handoff kind from fresh reviewed records", async () => {
    const resolver = new ReviewedParentingHandoffResourceResolver();
    const result = await resolver.resolve({
      localeEvidence: localeEvidence("en-US"),
      requestedAt: REQUESTED_AT,
      kinds: [
        "emergency_services",
        "crisis_support",
        "child_safeguarding",
        "licensed_mental_health_professional",
        "pediatrician_or_prescriber",
        "qualified_legal_professional",
      ],
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("resources unresolved");
    expect(result.jurisdiction).toBe("US");
    expect(result.resources).toHaveLength(6);
    expect(result.resources.flatMap((resource) => resource.contacts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "phone", value: "911" }),
        expect.objectContaining({ kind: "call_or_text", value: "988" }),
      ]),
    );
    expect(
      result.resources.every(
        (resource) =>
          resource.sourceUrl.startsWith("https://") &&
          Date.parse(resource.reviewExpiresAt) >= Date.parse(REQUESTED_AT),
      ),
    ).toBe(true);
  });

  it.each([
    {
      localeEvidence: {
        status: "unavailable",
        locale: null,
        source: "unavailable",
        observedAt: null,
        provenance: null,
        unavailableReason: "locale_missing",
      } satisfies ParentingLocaleEvidence,
      reason: "locale_missing",
    },
    {
      localeEvidence: localeEvidence("not_a_locale"),
      reason: "locale_invalid",
    },
    {
      localeEvidence: localeEvidence("en"),
      reason: "locale_missing_region",
    },
    {
      localeEvidence: localeEvidence("en-GB"),
      reason: "locale_unsupported",
    },
  ] as const)(
    "returns no contacts for $reason",
    async ({ localeEvidence: evidence, reason }) => {
      const resolver = new ReviewedParentingHandoffResourceResolver();
      const result = await resolver.resolve({
        localeEvidence: evidence,
        requestedAt: REQUESTED_AT,
        kinds: ["emergency_services"],
      });

      expect(result).toMatchObject({
        status: "unavailable",
        unavailableReason: reason,
        resources: [],
      });
      expect(JSON.stringify(result)).not.toContain("911.gov");
    },
  );

  it("fails closed without returning stale contacts", async () => {
    const stale = PARENTING_HANDOFF_RESOURCES.map((resource) => ({
      ...resource,
      reviewExpiresAt: "2026-07-26T12:00:00.000Z",
    }));
    const result = await new ReviewedParentingHandoffResourceResolver(
      stale,
    ).resolve({
      localeEvidence: localeEvidence("en-US"),
      requestedAt: REQUESTED_AT,
      kinds: ["emergency_services", "crisis_support"],
    });

    expect(result).toEqual({
      status: "unavailable",
      locale: "en-US",
      jurisdiction: "US",
      requestedKinds: ["emergency_services", "crisis_support"],
      resources: [],
      unavailableReason: "resource_review_expired",
    });
  });

  it("returns no partial resource set when one requested kind is absent", async () => {
    const emergencyOnly = PARENTING_HANDOFF_RESOURCES.filter((resource) =>
      resource.handoffKinds.includes("emergency_services"),
    );
    const result = await new ReviewedParentingHandoffResourceResolver(
      emergencyOnly,
    ).resolve({
      localeEvidence: localeEvidence("en-US"),
      requestedAt: REQUESTED_AT,
      kinds: ["emergency_services", "crisis_support"],
    });

    expect(result).toMatchObject({
      status: "unavailable",
      unavailableReason: "resource_set_incomplete",
      resources: [],
    });
  });

  it("does not require locale evidence when policy has no handoff", async () => {
    await expect(
      new ReviewedParentingHandoffResourceResolver().resolve({
        localeEvidence: {
          status: "unavailable",
          locale: null,
          source: "unavailable",
          observedAt: null,
          provenance: null,
          unavailableReason: "locale_missing",
        },
        requestedAt: REQUESTED_AT,
        kinds: [],
      }),
    ).resolves.toEqual({
      status: "not_required",
      locale: null,
      jurisdiction: null,
      requestedKinds: [],
      resources: [],
      unavailableReason: null,
    });
  });
});
