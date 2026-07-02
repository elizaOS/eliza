/**
 * End-to-end "Jill scenario" test for the VoiceObserver — the
 * cross-utterance state machine that turns voice imprints + utterance
 * text into entity + relationship rows.
 *
 * R2-speaker.md §7 sets the contract:
 *
 *   1. Shaw (OWNER) says "this is Jill, Jill is my wife"
 *      → no entity row created for Jill (she hasn't spoken).
 *      → a pending `partner_of` claim with toName="Jill", label="wife".
 *
 *   2. Jill (no profile yet) says "hey there, I'm Jill"
 *      → a new entity row with `platform:"voice"`, `displayName:"Jill"`.
 *      → the pending claim resolves into one `partner_of` row from self
 *        to Jill, `metadata.label="wife"`.
 *
 * The test uses in-memory fakes for `EntityStore` and `RelationshipStore`
 * (the real ones require Postgres + raw SQL). The observer talks to them
 * via the same `observeIdentity` / `observe` / `get` / `resolve`
 * surface the real stores expose, so the contract is exercised.
 */

import { describe, expect, it } from "vitest";
import type {
  Relationship,
  RelationshipSource,
} from "../relationships/types.js";
import type {
  Entity,
  EntityIdentity,
  EntityResolveCandidate,
} from "./types.js";
import { SELF_ENTITY_ID } from "./types.js";
import {
  extractKinClaim,
  extractSelfAffiliationClaim,
  extractSelfNameClaim,
  PendingRelationshipQueue,
} from "./voice-attribution.js";
import { VoiceObserver } from "./voice-observer.js";

let entityCounter = 0;
let relCounter = 0;
const nowIso = () => "2026-05-14T10:00:00.000Z";

/** In-memory `EntityStore` stand-in matching the surface the observer uses. */
class FakeEntityStore {
  private entities = new Map<string, Entity>();

  addSelf(): Entity {
    const self: Entity = {
      entityId: SELF_ENTITY_ID,
      type: "person",
      preferredName: "self",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.entities.set(self.entityId, self);
    return self;
  }

  async get(entityId: string): Promise<Entity | null> {
    return this.entities.get(entityId) ?? null;
  }

  async list(): Promise<Entity[]> {
    return Array.from(this.entities.values());
  }

  async observeIdentity(obs: {
    platform: string;
    handle: string;
    displayName?: string;
    evidence: string[];
    confidence: number;
    suggestedType?: string;
  }): Promise<{ entity: Entity; mergedFrom?: string[]; conflict?: boolean }> {
    // Look for an existing entity with the same (platform, handle).
    for (const entity of this.entities.values()) {
      const match = entity.identities.find(
        (id) =>
          id.platform === obs.platform &&
          id.handle.toLowerCase() === obs.handle.toLowerCase(),
      );
      if (match) {
        // Fold the new evidence in — the real store does the same.
        const updated: Entity = {
          ...entity,
          identities: entity.identities.map((id) =>
            id.platform === obs.platform && id.handle === obs.handle
              ? {
                  ...id,
                  evidence: Array.from(
                    new Set([...id.evidence, ...obs.evidence]),
                  ),
                  confidence: Math.max(id.confidence, obs.confidence),
                }
              : id,
          ),
          state: { ...entity.state, lastObservedAt: nowIso() },
          updatedAt: nowIso(),
        };
        this.entities.set(updated.entityId, updated);
        return { entity: updated, mergedFrom: [entity.entityId] };
      }
    }
    // Create a new entity.
    entityCounter += 1;
    const entityId = `ent_${entityCounter}`;
    const identity: EntityIdentity = {
      platform: obs.platform,
      handle: obs.handle,
      ...(obs.displayName ? { displayName: obs.displayName } : {}),
      verified: false,
      confidence: obs.confidence,
      addedAt: nowIso(),
      addedVia: "platform_observation",
      evidence: obs.evidence,
    };
    const entity: Entity = {
      entityId,
      type: obs.suggestedType ?? "person",
      preferredName: obs.displayName ?? obs.handle,
      identities: [identity],
      tags: [],
      visibility: "owner_agent_admin",
      state: { lastObservedAt: nowIso() },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.entities.set(entityId, entity);
    return { entity };
  }

  async resolve(query: {
    name?: string;
    identity?: { platform: string; handle: string };
    type?: string;
  }): Promise<EntityResolveCandidate[]> {
    const out: EntityResolveCandidate[] = [];
    for (const entity of this.entities.values()) {
      if (query.type && entity.type !== query.type) continue;
      if (
        query.name &&
        !entity.preferredName.toLowerCase().includes(query.name.toLowerCase())
      )
        continue;
      out.push({
        entity,
        entityId: entity.entityId,
        identities: entity.identities,
        confidence: entity.identities[0]?.confidence ?? 0,
        safeToSend: false,
        evidence: entity.identities.flatMap((i) => i.evidence),
      });
    }
    return out;
  }
}

class FakeRelationshipStore {
  relationships: Relationship[] = [];

  async observe(obs: {
    fromEntityId: string;
    toEntityId: string;
    type: string;
    metadataPatch?: Record<string, unknown>;
    evidence: string[];
    confidence: number;
    occurredAt?: string;
    source?: RelationshipSource;
  }): Promise<Relationship> {
    relCounter += 1;
    const rel: Relationship = {
      relationshipId: `rel_${relCounter}`,
      fromEntityId: obs.fromEntityId,
      toEntityId: obs.toEntityId,
      type: obs.type,
      metadata: obs.metadataPatch ?? {},
      confidence: obs.confidence,
      source: obs.source ?? "extraction",
      status: "active",
      evidence: obs.evidence,
      state: {
        lastObservedAt: obs.occurredAt ?? nowIso(),
        interactionCount: 1,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.relationships.push(rel);
    return rel;
  }
}

// ---------------------------------------------------------------------------
// Pure extractor regression tests.
// ---------------------------------------------------------------------------

describe("extractSelfNameClaim", () => {
  it.each([
    ["I'm Jill", "Jill"],
    ["I am Jill Smith", "Jill Smith"],
    ["My name is Jill", "Jill"],
    ["This is Jill", "Jill"],
    ["Hey there, I'm Jill", "Jill"],
    ["Hi, it's Jill", "Jill"],
    ["Sure — I'm Jill, nice to meet you", "Jill"],
  ])("extracts %s → %s", (input, expected) => {
    expect(extractSelfNameClaim(input)).toBe(expected);
  });

  it.each([
    "hello",
    "what time is it",
    "",
    null,
    undefined,
  ])("returns null for non-claim %s", (input) => {
    expect(extractSelfNameClaim(input as string | null | undefined)).toBeNull();
  });

  it("rejects lowercase names (heuristic anchor)", () => {
    expect(extractSelfNameClaim("i am jill")).toBeNull();
  });
});

describe("extractKinClaim", () => {
  it.each([
    ["Jill is my wife", "Jill", "wife", "partner_of"],
    ["Bob is my husband", "Bob", "husband", "partner_of"],
    ["Sam is my partner", "Sam", "partner", "partner_of"],
    ["this is Jill, my wife", "Jill", "wife", "partner_of"],
    // Label-before-name phrasing must bind the name, not mint a "this" entity.
    ["this is my wife Jill", "Jill", "wife", "partner_of"],
    ["this is my husband Bob", "Bob", "husband", "partner_of"],
    // A single trailing name token — must not over-capture the verb.
    ["my husband Bob just called", "Bob", "husband", "partner_of"],
    // Sibling claims (#10726 — "my sister Joan" was not extractable).
    ["Joan is my sister", "Joan", "sister", "sibling_of"],
    ["this is Joan, my sister", "Joan", "sister", "sibling_of"],
    ["this is my sister Joan", "Joan", "sister", "sibling_of"],
    ["my brother Bob just called", "Bob", "brother", "sibling_of"],
    ["Alex is my sibling", "Alex", "sibling", "sibling_of"],
  ])("extracts %s → %s + %s (%s)", (input, name, label, type) => {
    const claim = extractKinClaim(input);
    expect(claim?.name).toBe(name);
    expect(claim?.label).toBe(label);
    expect(claim?.type).toBe(type);
  });

  it("never returns a stopword ('this') as the kin name", () => {
    const claim = extractKinClaim("this is my wife Jill");
    expect(claim?.name).toBe("Jill");
    expect(claim?.name).not.toBe("this");
  });

  it("returns null on no claim", () => {
    expect(extractKinClaim("how is the weather")).toBeNull();
    expect(extractKinClaim("")).toBeNull();
  });
});

describe("extractSelfAffiliationClaim", () => {
  it.each([
    ["Eliza I am John from the accounting team", "John", "accounting team"],
    ["I'm John from accounting", "John", "accounting"],
    ["This is Ada from Payroll", "Ada", "Payroll"],
    ["Hi, I'm Maya with Acme Corp, nice to meet you", "Maya", "Acme Corp"],
    // Clause break — the org phrase must not swallow the rest of the sentence.
    [
      "I am John from the accounting team and I need help with a spreadsheet",
      "John",
      "accounting team",
    ],
  ])("extracts %s → %s @ %s", (input, name, organization) => {
    const claim = extractSelfAffiliationClaim(input);
    expect(claim?.name).toBe(name);
    expect(claim?.organization).toBe(organization);
  });

  it.each([
    ["I work at Acme Corp", "Acme Corp"],
    ["I work for the city council", "city council"],
  ])("extracts org-only claim %s → %s", (input, organization) => {
    const claim = extractSelfAffiliationClaim(input);
    expect(claim?.name).toBeNull();
    expect(claim?.organization).toBe(organization);
  });

  it("rejects non-affiliation phrasing", () => {
    // Lowercase "calling" fails the uppercase name anchor.
    expect(extractSelfAffiliationClaim("I'm calling from the airport")).toBe(
      null,
    );
    expect(extractSelfAffiliationClaim("how is the weather")).toBeNull();
    expect(extractSelfAffiliationClaim("")).toBeNull();
    expect(extractSelfAffiliationClaim(null)).toBeNull();
  });
});

describe("PendingRelationshipQueue", () => {
  it("enqueue + resolveByName is case-insensitive", () => {
    const q = new PendingRelationshipQueue();
    q.enqueue({
      type: "partner_of",
      fromEntityId: SELF_ENTITY_ID,
      toName: "Jill",
      label: "wife",
      evidenceId: "turn-1",
      createdAt: nowIso(),
    });
    expect(q.size()).toBe(1);
    const resolved = q.resolveByName("jill");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].label).toBe("wife");
    expect(q.size()).toBe(0);
  });

  it("re-enqueue de-dupes by (toName, type) and keeps most-recent", () => {
    const q = new PendingRelationshipQueue();
    q.enqueue({
      type: "partner_of",
      fromEntityId: SELF_ENTITY_ID,
      toName: "Jill",
      label: "girlfriend",
      evidenceId: "turn-1",
      createdAt: nowIso(),
    });
    q.enqueue({
      type: "partner_of",
      fromEntityId: SELF_ENTITY_ID,
      toName: "Jill",
      label: "wife",
      evidenceId: "turn-2",
      createdAt: nowIso(),
    });
    expect(q.size()).toBe(1);
    const all = q.all();
    expect(all[0].label).toBe("wife");
    expect(all[0].evidenceId).toBe("turn-2");
  });

  it("resolveByName returns [] when nothing matches", () => {
    const q = new PendingRelationshipQueue();
    expect(q.resolveByName("Bob")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Jill scenario — end-to-end through VoiceObserver.
// ---------------------------------------------------------------------------

describe("VoiceObserver — Jill scenario", () => {
  function setup() {
    entityCounter = 0;
    relCounter = 0;
    const entityStore = new FakeEntityStore();
    const relationshipStore = new FakeRelationshipStore();
    entityStore.addSelf();
    // Pretend Shaw (OWNER) already has an entity + voice profile.
    const observer = new VoiceObserver({
      entityStore: entityStore as unknown as ConstructorParameters<
        typeof VoiceObserver
      >[0]["entityStore"],
      relationshipStore: relationshipStore as unknown as ConstructorParameters<
        typeof VoiceObserver
      >[0]["relationshipStore"],
    });
    return { observer, entityStore, relationshipStore };
  }

  it("Shaw says 'this is Jill, Jill is my wife' creates no entity for Jill but queues a pending partner_of", async () => {
    const { observer, entityStore, relationshipStore } = setup();
    const turn = await observer.ingestTurn({
      turnId: "turn-shaw-1",
      text: "this is Jill, Jill is my wife",
      imprintClusterId: "cluster_shaw",
      matchConfidence: 0.95,
      matchedEntityId: SELF_ENTITY_ID,
      isOwner: true,
    });
    // No new Jill entity because she hasn't spoken yet.
    const list = await entityStore.list();
    const named = list.find(
      (e) =>
        e.entityId !== SELF_ENTITY_ID &&
        e.preferredName.toLowerCase() === "jill",
    );
    expect(named).toBeUndefined();
    // No partner_of row landed yet.
    expect(relationshipStore.relationships).toHaveLength(0);
    // One pending claim queued for "Jill".
    expect(observer.pendingRelationshipsCount).toBe(1);
    expect(turn.queuedPartnerClaims).toBe(1);
    expect(observer.peekPending()[0].toName).toBe("Jill");
    expect(observer.peekPending()[0].label).toBe("wife");
  });

  it("Jill says 'hey there, I'm Jill' → creates entity + resolves the pending partner_of", async () => {
    const { observer, entityStore, relationshipStore } = setup();
    // Step 1: Shaw introduces Jill.
    await observer.ingestTurn({
      turnId: "turn-shaw-1",
      text: "this is Jill, Jill is my wife",
      imprintClusterId: "cluster_shaw",
      matchConfidence: 0.95,
      matchedEntityId: SELF_ENTITY_ID,
      isOwner: true,
    });
    expect(observer.pendingRelationshipsCount).toBe(1);

    // Step 2: Jill speaks — new voice cluster + no prior entity binding.
    const result = await observer.ingestTurn({
      turnId: "turn-jill-1",
      text: "hey there, I'm Jill",
      imprintClusterId: "cluster_jill_seed",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });

    // A new entity was created with platform:"voice" identity.
    const list = await entityStore.list();
    const jill = list.find((e) => e.preferredName === "Jill");
    expect(jill).toBeDefined();
    expect(jill?.identities[0]).toMatchObject({
      platform: "voice",
      handle: "cluster_jill_seed",
      displayName: "Jill",
      confidence: 0.7,
    });

    // The pending partner_of claim resolved into one row.
    expect(relationshipStore.relationships).toHaveLength(1);
    const rel = relationshipStore.relationships[0];
    expect(rel.type).toBe("partner_of");
    expect(rel.fromEntityId).toBe(SELF_ENTITY_ID);
    expect(rel.toEntityId).toBe(jill?.entityId);
    expect(rel.metadata?.label).toBe("wife");

    // The pending queue is now empty.
    expect(observer.pendingRelationshipsCount).toBe(0);
    expect(result.relationshipIds).toContain(rel.relationshipId);
    expect(result.binding.entityId).toBe(jill?.entityId);
    expect(result.binding.wasCreated).toBe(true);
    expect(result.binding.resolvedClaimedName).toBe("Jill");
  });

  it("Jill speaks again, gets matched to her existing entity (no duplicate)", async () => {
    const { observer, entityStore, relationshipStore } = setup();
    // First turn — creates Jill.
    await observer.ingestTurn({
      turnId: "turn-jill-1",
      text: "hi I'm Jill",
      imprintClusterId: "cluster_jill_seed",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });
    const list1 = await entityStore.list();
    const jill = list1.find((e) => e.preferredName === "Jill");
    if (!jill) throw new Error("Jill entity was not created");

    // Second turn — same imprint cluster, the observer should match.
    const result = await observer.ingestTurn({
      turnId: "turn-jill-2",
      text: "today was a long day",
      imprintClusterId: "cluster_jill_seed",
      matchConfidence: 0.92,
      matchedEntityId: jill.entityId,
      isOwner: false,
    });
    const list2 = await entityStore.list();
    // Still exactly one Jill.
    expect(
      list2.filter(
        (e) => e.entityId !== SELF_ENTITY_ID && e.preferredName === "Jill",
      ),
    ).toHaveLength(1);
    expect(result.binding.entityId).toBe(jill.entityId);
    expect(result.binding.wasCreated).toBe(false);
    // No new relationships landed (no claim, no resolved pending).
    expect(relationshipStore.relationships).toHaveLength(0);
  });

  it("Owner names a partner whose entity already exists — landed immediately", async () => {
    const { observer, entityStore, relationshipStore } = setup();
    // Pretend Jill is already a known entity (e.g. from a prior voice
    // cluster that the OWNER named manually in the UI).
    await entityStore.observeIdentity({
      platform: "voice",
      handle: "cluster_jill_seed",
      displayName: "Jill",
      evidence: ["bootstrap"],
      confidence: 0.7,
      suggestedType: "person",
    });

    await observer.ingestTurn({
      turnId: "turn-shaw-1",
      text: "Jill is my wife",
      imprintClusterId: "cluster_shaw",
      matchConfidence: 0.95,
      matchedEntityId: SELF_ENTITY_ID,
      isOwner: true,
    });
    // No queue — the relationship landed immediately because Jill
    // resolved by name.
    expect(observer.pendingRelationshipsCount).toBe(0);
    expect(relationshipStore.relationships).toHaveLength(1);
    expect(relationshipStore.relationships[0].metadata?.label).toBe("wife");
  });

  it("non-owner partner claims are NOT queued", async () => {
    const { observer, relationshipStore } = setup();
    await observer.ingestTurn({
      turnId: "turn-guest-1",
      text: "Bob is my husband",
      imprintClusterId: "cluster_guest",
      matchConfidence: 0.6,
      matchedEntityId: null,
      isOwner: false,
    });
    expect(observer.pendingRelationshipsCount).toBe(0);
    expect(relationshipStore.relationships).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // #10726 attribute-inference additions: siblings + works_at affiliation.
  // -------------------------------------------------------------------------

  it("'my sister Joan' queues a sibling_of claim that resolves when Joan speaks", async () => {
    const { observer, entityStore, relationshipStore } = setup();
    const ownerTurn = await observer.ingestTurn({
      turnId: "turn-shaw-1",
      text: "my sister Joan just called",
      imprintClusterId: "cluster_shaw",
      matchConfidence: 0.95,
      matchedEntityId: SELF_ENTITY_ID,
      isOwner: true,
    });
    expect(ownerTurn.queuedPartnerClaims).toBe(1);
    expect(observer.peekPending()[0]).toMatchObject({
      type: "sibling_of",
      toName: "Joan",
      label: "sister",
    });

    const joanTurn = await observer.ingestTurn({
      turnId: "turn-joan-1",
      text: "hey there, I'm Joan",
      imprintClusterId: "cluster_joan_seed",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });

    const list = await entityStore.list();
    const joan = list.find((e) => e.preferredName === "Joan");
    expect(joan).toBeDefined();
    expect(relationshipStore.relationships).toHaveLength(1);
    const rel = relationshipStore.relationships[0];
    expect(rel.type).toBe("sibling_of");
    expect(rel.fromEntityId).toBe(SELF_ENTITY_ID);
    expect(rel.toEntityId).toBe(joan?.entityId);
    expect(rel.metadata?.label).toBe("sister");
    expect(observer.pendingRelationshipsCount).toBe(0);
    expect(joanTurn.relationshipIds).toContain(rel.relationshipId);
  });

  it("'I am John from the accounting team' binds the speaker to an org via works_at", async () => {
    const { observer, entityStore, relationshipStore } = setup();
    const result = await observer.ingestTurn({
      turnId: "turn-john-1",
      text: "Eliza I am John from the accounting team",
      imprintClusterId: "cluster_john_seed",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });

    const list = await entityStore.list();
    const john = list.find((e) => e.preferredName === "John");
    const org = list.find((e) => e.preferredName === "accounting team");
    expect(john).toBeDefined();
    expect(org).toBeDefined();
    expect(org?.type).toBe("organization");
    expect(result.affiliationOrgEntityId).toBe(org?.entityId);

    const rel = relationshipStore.relationships.find(
      (r) => r.type === "works_at",
    );
    expect(rel).toBeDefined();
    expect(rel?.fromEntityId).toBe(john?.entityId);
    expect(rel?.toEntityId).toBe(org?.entityId);
    expect(rel?.metadata?.organization).toBe("accounting team");
    expect(result.relationshipIds).toContain(rel?.relationshipId);
  });

  it("repeated mentions of the same org fold into one organization entity", async () => {
    const { observer, entityStore } = setup();
    await observer.ingestTurn({
      turnId: "turn-john-1",
      text: "I am John from the accounting team",
      imprintClusterId: "cluster_john_seed",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });
    await observer.ingestTurn({
      turnId: "turn-ada-1",
      text: "I'm Ada from the Accounting Team",
      imprintClusterId: "cluster_ada_seed",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });
    const list = await entityStore.list();
    const orgs = list.filter((e) => e.type === "organization");
    expect(orgs).toHaveLength(1);
  });

  it("does not mint an organization from non-affiliation 'with' phrasing", async () => {
    const { observer, entityStore, relationshipStore } = setup();
    await observer.ingestTurn({
      turnId: "turn-jill-1",
      text: "I'm Jill with the long hair",
      imprintClusterId: "cluster_jill_seed",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });
    const list = await entityStore.list();
    expect(list.filter((e) => e.type === "organization")).toHaveLength(0);
    expect(
      relationshipStore.relationships.filter((r) => r.type === "works_at"),
    ).toHaveLength(0);
  });
});
