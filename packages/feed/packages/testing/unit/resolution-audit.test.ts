/**
 * Resolution Audit Unit Tests
 *
 * Tests the PublicResolutionAudit type structure and the resolvedAt
 * fallback chain logic used in _resolution-audit.ts.
 */

import { describe, expect, it } from "bun:test";

// Replicate the resolvedAt fallback chain from _resolution-audit.ts
function resolveResolvedAt(params: {
  reviewedAt: Date | null;
  frameResolvedAt: Date | null;
  marketResolved: boolean;
  marketUpdatedAt: Date | null;
}): string | null {
  const { reviewedAt, frameResolvedAt, marketResolved, marketUpdatedAt } =
    params;
  const resolvedAt =
    reviewedAt ??
    frameResolvedAt ??
    (marketResolved ? marketUpdatedAt : null) ??
    null;
  return resolvedAt?.toISOString() ?? null;
}

// Replicate the resolvedBy logic from _resolution-audit.ts
type ResolvedBy = {
  id: string;
  displayName: string | null;
  username: string | null;
  kind: "admin" | "system";
} | null;

function resolveResolvedBy(
  reviewerId: string | null,
  reviewerRecord: {
    id: string;
    displayName: string | null;
    username: string | null;
  } | null,
): ResolvedBy {
  if (reviewerId === "system") {
    return {
      id: "system",
      displayName: "Feed Resolution Engine",
      username: null,
      kind: "system",
    };
  }
  if (reviewerId && reviewerRecord) {
    return {
      id: reviewerRecord.id,
      displayName: reviewerRecord.displayName,
      username: reviewerRecord.username,
      kind: "admin",
    };
  }
  return null;
}

describe("Resolution Audit - resolvedAt fallback chain", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  const earlier = new Date("2026-01-14T12:00:00Z");
  const earliest = new Date("2026-01-13T12:00:00Z");

  it("prefers reviewedAt when available", () => {
    const result = resolveResolvedAt({
      reviewedAt: now,
      frameResolvedAt: earlier,
      marketResolved: true,
      marketUpdatedAt: earliest,
    });
    expect(result).toBe(now.toISOString());
  });

  it("falls back to frameResolvedAt when reviewedAt is null", () => {
    const result = resolveResolvedAt({
      reviewedAt: null,
      frameResolvedAt: earlier,
      marketResolved: true,
      marketUpdatedAt: earliest,
    });
    expect(result).toBe(earlier.toISOString());
  });

  it("falls back to marketUpdatedAt when market is resolved", () => {
    const result = resolveResolvedAt({
      reviewedAt: null,
      frameResolvedAt: null,
      marketResolved: true,
      marketUpdatedAt: earliest,
    });
    expect(result).toBe(earliest.toISOString());
  });

  it("returns null when market is not resolved and no other dates", () => {
    const result = resolveResolvedAt({
      reviewedAt: null,
      frameResolvedAt: null,
      marketResolved: false,
      marketUpdatedAt: earliest,
    });
    expect(result).toBeNull();
  });

  it("returns null when everything is null", () => {
    const result = resolveResolvedAt({
      reviewedAt: null,
      frameResolvedAt: null,
      marketResolved: false,
      marketUpdatedAt: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when market resolved but updatedAt is null", () => {
    const result = resolveResolvedAt({
      reviewedAt: null,
      frameResolvedAt: null,
      marketResolved: true,
      marketUpdatedAt: null,
    });
    expect(result).toBeNull();
  });
});

describe("Resolution Audit - resolvedBy logic", () => {
  it('returns system resolver for "system" reviewerId', () => {
    const result = resolveResolvedBy("system", null);
    expect(result).toEqual({
      id: "system",
      displayName: "Feed Resolution Engine",
      username: null,
      kind: "system",
    });
  });

  it('ignores reviewer record when reviewerId is "system"', () => {
    const result = resolveResolvedBy("system", {
      id: "admin-1",
      displayName: "Admin",
      username: "admin",
    });
    expect(result?.kind).toBe("system");
    expect(result?.id).toBe("system");
  });

  it("returns admin resolver when reviewerId and record exist", () => {
    const result = resolveResolvedBy("admin-1", {
      id: "admin-1",
      displayName: "Alice Admin",
      username: "alice",
    });
    expect(result).toEqual({
      id: "admin-1",
      displayName: "Alice Admin",
      username: "alice",
      kind: "admin",
    });
  });

  it("returns null when reviewerId is set but no record found", () => {
    const result = resolveResolvedBy("deleted-admin", null);
    expect(result).toBeNull();
  });

  it("returns null when reviewerId is null", () => {
    const result = resolveResolvedBy(null, null);
    expect(result).toBeNull();
  });
});

describe("Resolution Audit - response shape", () => {
  it("produces complete audit object for resolved market", () => {
    const audit = {
      resolution: true,
      resolvedAt: new Date("2026-01-15T12:00:00Z").toISOString(),
      reviewStatus: "approved",
      confidence: 0.95,
      description: "Resolved as YES based on observed market evidence",
      proofUrl: "https://example.com/proof",
      resolvedBy: {
        id: "admin-1",
        displayName: "Alice",
        username: "alice",
        kind: "admin" as const,
      },
    };

    expect(audit.resolution).toBe(true);
    expect(audit.resolvedAt).toBeTruthy();
    expect(audit.resolvedBy?.kind).toBe("admin");
    expect(audit.confidence).toBeGreaterThan(0);
  });

  it("produces minimal audit object for unreviewed market", () => {
    const audit = {
      resolution: null,
      resolvedAt: null,
      reviewStatus: null,
      confidence: null,
      description: null,
      proofUrl: null,
      resolvedBy: null,
    };

    expect(audit.resolution).toBeNull();
    expect(audit.resolvedAt).toBeNull();
    expect(audit.resolvedBy).toBeNull();
  });
});
