/**
 * Identity-merge engine. Platform and handle matching is case-insensitive,
 * connector-account partitions are exact, and omitted accounts mean only the
 * legacy default. Folding must retain account-specific reachability and
 * provenance.
 */
import { describe, expect, it } from "vitest";
import type { Entity, EntityIdentity } from "./entity-types";
import {
  AUTO_MERGE_CONFIDENCE_THRESHOLD,
  decideIdentityOutcome,
  findIdentityMatches,
  foldIdentity,
} from "./merge";

const ident = (o: Partial<EntityIdentity>): EntityIdentity =>
  ({
    platform: "discord",
    handle: "bob",
    confidence: 0.9,
    verified: false,
    evidence: ["e1"],
    addedAt: "2026-01-01",
    addedVia: "observed",
    ...o,
  }) as EntityIdentity;

const entity = (id: string, identities: EntityIdentity[]): Entity => ({
  entityId: id,
  type: "person",
  preferredName: id,
  identities,
  tags: [],
  attributes: {},
  state: {},
  visibility: "owner_agent_admin",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});

describe("findIdentityMatches", () => {
  it("matches case-insensitively on platform + handle", () => {
    const ents = [
      entity("e1", [ident({ platform: "Discord", handle: "Bob" })]),
    ];
    expect(
      findIdentityMatches(ents, {
        platform: "discord",
        handle: "bob",
        confidence: 0.9,
      }),
    ).toHaveLength(1);
    expect(
      findIdentityMatches(ents, {
        platform: "discord",
        handle: "alice",
        confidence: 0.9,
      }),
    ).toEqual([]);
  });

  it("matches only the exact connector account and defaults omissions", () => {
    const ents = [
      entity("legacy", [ident({})]),
      entity("family", [ident({ connectorAccountId: "family" })]),
    ];

    expect(
      findIdentityMatches(ents, {
        platform: "discord",
        handle: "bob",
        confidence: 0.9,
      }).map((match) => match.entityId),
    ).toEqual(["legacy"]);
    expect(
      findIdentityMatches(ents, {
        platform: "discord",
        handle: "bob",
        connectorAccountId: "family",
        confidence: 0.9,
      }).map((match) => match.entityId),
    ).toEqual(["family"]);
    expect(
      findIdentityMatches(ents, {
        platform: "discord",
        handle: "bob",
        connectorAccountId: "Family",
        confidence: 0.9,
      }),
    ).toEqual([]);
  });
});

describe("decideIdentityOutcome", () => {
  const e1 = entity("e1", [ident({})]);
  const e2 = entity("e2", [ident({})]);

  it("creates when no candidate", () => {
    expect(
      decideIdentityOutcome({ candidates: [], newConfidence: 0.9 }),
    ).toEqual({
      kind: "create",
    });
  });

  it("merges one candidate at/above the auto threshold", () => {
    expect(
      decideIdentityOutcome({
        candidates: [e1],
        newConfidence: AUTO_MERGE_CONFIDENCE_THRESHOLD,
      }),
    ).toEqual({ kind: "merge", targetEntityId: "e1" });
  });

  it("flags a low-confidence single match as conflict", () => {
    const out = decideIdentityOutcome({ candidates: [e1], newConfidence: 0.5 });
    expect(out).toMatchObject({
      kind: "conflict",
      reason: "low_confidence_observation",
    });
  });

  it("flags multiple candidates as conflict", () => {
    const out = decideIdentityOutcome({
      candidates: [e1, e2],
      newConfidence: 0.99,
    });
    expect(out).toMatchObject({
      kind: "conflict",
      reason: "multiple_candidate_entities",
    });
    if (out.kind === "conflict")
      expect(out.candidateEntityIds).toEqual(["e1", "e2"]);
  });
});

describe("foldIdentity", () => {
  it("appends a new (platform, handle)", () => {
    const out = foldIdentity(
      [ident({ handle: "bob" })],
      ident({ handle: "alice" }),
    );
    expect(out).toHaveLength(2);
  });

  it("keeps the same platform and handle distinct across connector accounts", () => {
    const out = foldIdentity(
      [ident({ connectorAccountId: "family", evidence: ["family"] })],
      ident({ connectorAccountId: "work", evidence: ["work"] }),
    );
    expect(out).toHaveLength(2);
    expect(out.map((identity) => identity.connectorAccountId)).toEqual([
      "family",
      "work",
    ]);
  });

  it("merges a colliding identity: max confidence, deduped evidence union", () => {
    const out = foldIdentity(
      [ident({ handle: "bob", confidence: 0.5, evidence: ["a"] })],
      ident({ handle: "Bob", confidence: 0.9, evidence: ["a", "b"] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.9);
    expect([...out[0].evidence].sort()).toEqual(["a", "b"]);
    expect(out[0].connectorAccountId).toBe("default");
  });

  it("prefers a verified claim on a confidence tie", () => {
    const out = foldIdentity(
      [ident({ confidence: 0.8, verified: false })],
      ident({ confidence: 0.8, verified: true }),
    );
    expect(out[0].verified).toBe(true);
  });
});
