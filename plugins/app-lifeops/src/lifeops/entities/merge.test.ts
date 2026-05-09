/**
 * Pure-function unit tests for the identity-merge engine.
 *
 * No PGLite, no runtime — just the decision logic and identity-folding
 * arithmetic. The store-level integration is exercised by the
 * `entities.e2e.test.ts` suite.
 */

import { describe, expect, it } from "vitest";
import {
  AUTO_MERGE_CONFIDENCE_THRESHOLD,
  decideIdentityOutcome,
  findIdentityMatches,
  foldIdentity,
  mergeEntities,
} from "./merge.js";
import type { Entity, EntityIdentity } from "./types.js";

const isoNow = "2026-05-09T00:00:00Z";

function makeEntity(args: {
  id: string;
  name: string;
  identities?: EntityIdentity[];
  tags?: string[];
}): Entity {
  return {
    entityId: args.id,
    type: "person",
    preferredName: args.name,
    identities: args.identities ?? [],
    state: {},
    tags: args.tags ?? [],
    visibility: "owner_agent_admin",
    createdAt: isoNow,
    updatedAt: isoNow,
  };
}

function makeIdentity(args: {
  platform: string;
  handle: string;
  confidence: number;
  verified?: boolean;
  evidence?: string[];
}): EntityIdentity {
  return {
    platform: args.platform,
    handle: args.handle,
    verified: args.verified ?? false,
    confidence: args.confidence,
    addedAt: isoNow,
    addedVia: "platform_observation",
    evidence: args.evidence ?? [],
  };
}

describe("findIdentityMatches", () => {
  it("matches by case-insensitive (platform, handle)", () => {
    const a = makeEntity({
      id: "a",
      name: "A",
      identities: [
        makeIdentity({ platform: "Telegram", handle: "@Foo", confidence: 0.9 }),
      ],
    });
    const b = makeEntity({ id: "b", name: "B" });
    const matches = findIdentityMatches([a, b], {
      platform: "telegram",
      handle: "@foo",
      confidence: 0.5,
    });
    expect(matches.map((entity) => entity.entityId)).toEqual(["a"]);
  });

  it("returns empty when no identity collides", () => {
    const a = makeEntity({ id: "a", name: "A" });
    const matches = findIdentityMatches([a], {
      platform: "telegram",
      handle: "@nope",
      confidence: 0.5,
    });
    expect(matches).toEqual([]);
  });
});

describe("decideIdentityOutcome", () => {
  it("returns create when no candidates", () => {
    const outcome = decideIdentityOutcome({
      candidates: [],
      newConfidence: 0.9,
    });
    expect(outcome).toEqual({ kind: "create" });
  });

  it("merges when one candidate at or above threshold", () => {
    const a = makeEntity({ id: "a", name: "A" });
    const outcome = decideIdentityOutcome({
      candidates: [a],
      newConfidence: AUTO_MERGE_CONFIDENCE_THRESHOLD,
    });
    expect(outcome).toEqual({ kind: "merge", targetEntityId: "a" });
  });

  it("conflicts on a single candidate when confidence is below threshold", () => {
    const a = makeEntity({ id: "a", name: "A" });
    const outcome = decideIdentityOutcome({
      candidates: [a],
      newConfidence: 0.5,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") {
      expect(outcome.candidateEntityIds).toEqual(["a"]);
      expect(outcome.reason).toBe("low_confidence_observation");
    }
  });

  it("conflicts when multiple candidates", () => {
    const a = makeEntity({ id: "a", name: "A" });
    const b = makeEntity({ id: "b", name: "B" });
    const outcome = decideIdentityOutcome({
      candidates: [a, b],
      newConfidence: 0.99,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") {
      expect(outcome.candidateEntityIds).toEqual(["a", "b"]);
      expect(outcome.reason).toBe("multiple_candidate_entities");
    }
  });
});

describe("foldIdentity", () => {
  it("appends a new (platform, handle)", () => {
    const out = foldIdentity(
      [makeIdentity({ platform: "x", handle: "@a", confidence: 0.8 })],
      makeIdentity({ platform: "y", handle: "@b", confidence: 0.7 }),
    );
    expect(out).toHaveLength(2);
  });

  it("merges evidence and picks higher confidence on collision", () => {
    const out = foldIdentity(
      [
        makeIdentity({
          platform: "x",
          handle: "@a",
          confidence: 0.6,
          evidence: ["e1"],
        }),
      ],
      makeIdentity({
        platform: "x",
        handle: "@a",
        confidence: 0.9,
        evidence: ["e2"],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeCloseTo(0.9);
    expect(out[0]?.evidence.sort()).toEqual(["e1", "e2"]);
  });

  it("verified true wins over verified false at the same confidence", () => {
    const out = foldIdentity(
      [
        makeIdentity({
          platform: "x",
          handle: "@a",
          confidence: 0.8,
          verified: false,
        }),
      ],
      makeIdentity({
        platform: "x",
        handle: "@a",
        confidence: 0.8,
        verified: true,
      }),
    );
    expect(out[0]?.verified).toBe(true);
  });
});

describe("mergeEntities", () => {
  it("folds identities, tags, and attributes from sources", () => {
    const target = makeEntity({
      id: "t",
      name: "Target",
      identities: [
        makeIdentity({ platform: "email", handle: "t@example.com", confidence: 1, verified: true }),
      ],
      tags: ["original"],
    });
    const source = makeEntity({
      id: "s",
      name: "Source",
      identities: [
        makeIdentity({ platform: "telegram", handle: "@s", confidence: 0.9, verified: false }),
      ],
      tags: ["folded"],
    });
    const merged = mergeEntities({
      target,
      sources: [source],
      now: "2026-06-01T00:00:00Z",
    });
    expect(merged.identities).toHaveLength(2);
    expect(merged.tags).toEqual(["folded", "original"]);
    expect(merged.updatedAt).toBe("2026-06-01T00:00:00Z");
  });
});
