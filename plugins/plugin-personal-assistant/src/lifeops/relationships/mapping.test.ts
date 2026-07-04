/** Verifies mapping of knowledge-graph entities into LifeOps relationship DTOs (identities, tags, last-contacted). Deterministic vitest. */
import type { Entity, Relationship } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  contactIdentities,
  lastContactedAtFromEntity,
  lifeOpsRelationshipFromEntity,
  userTags,
} from "./mapping.js";

const baseEntity = (o: Partial<Entity> = {}): Entity =>
  ({
    entityId: "e1",
    type: "person",
    preferredName: "Pat",
    identities: [],
    attributes: {},
    state: {},
    tags: [],
    visibility: "owner_agent_admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...o,
  }) as Entity;

describe("userTags", () => {
  it("drops lifeops: tags", () => {
    expect(userTags(["lifeops:contact", "friend", "vip"])).toEqual([
      "friend",
      "vip",
    ]);
  });
});

describe("lastContactedAtFromEntity", () => {
  it("prefers lastObservedAt", () => {
    expect(
      lastContactedAtFromEntity(
        baseEntity({ state: { lastObservedAt: "A", lastInboundAt: "B" } }),
        null,
      ),
    ).toBe("A");
  });
  it("falls through to edge lastInteractionAt", () => {
    expect(
      lastContactedAtFromEntity(baseEntity({ state: {} }), {
        state: { lastInteractionAt: "EDGE" },
      } as Relationship),
    ).toBe("EDGE");
  });
  it("returns null when nothing set", () => {
    expect(lastContactedAtFromEntity(baseEntity(), null)).toBeNull();
  });
});

describe("contactIdentities", () => {
  it("dedupes + skips blanks", () => {
    const ids = contactIdentities(
      {
        primaryChannel: "discord",
        primaryHandle: "pat#1",
        email: "p@x.com",
        phone: "",
        notes: "",
      },
      "t",
    );
    expect(ids.map((i) => `${i.platform}:${i.handle}`)).toEqual([
      "discord:pat#1",
      "email:p@x.com",
    ]);
  });
  it("does not duplicate when primary==email", () => {
    expect(
      contactIdentities(
        {
          primaryChannel: "email",
          primaryHandle: "p@x.com",
          email: "p@x.com",
          phone: null,
          notes: "",
        },
        "t",
      ),
    ).toHaveLength(1);
  });
});

describe("lifeOpsRelationshipFromEntity", () => {
  it("falls back to first identity for channel/handle", () => {
    const dto = lifeOpsRelationshipFromEntity(
      "a1",
      baseEntity({
        identities: [
          {
            platform: "discord",
            handle: "pat#1",
            verified: true,
            confidence: 1,
            addedAt: "t",
            addedVia: "import",
            evidence: [],
          },
        ],
      } as Partial<Entity>),
      null,
    );
    expect(dto.primaryChannel).toBe("discord");
    expect(dto.primaryHandle).toBe("pat#1");
    expect(dto.relationshipType).toBe("contact");
  });
  it("uses edge type + metadata when edge present", () => {
    const dto = lifeOpsRelationshipFromEntity("a1", baseEntity(), {
      type: "colleague_of",
      metadata: { role: "eng" },
      state: {},
    } as Relationship);
    expect(dto.relationshipType).toBe("colleague_of");
    expect(dto.metadata).toEqual({ role: "eng" });
  });
});
