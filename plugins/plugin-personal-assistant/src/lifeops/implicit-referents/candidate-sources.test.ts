import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ownerStore: { read: async () => ({}) },
}));

vi.mock("../owner/fact-store", () => ({
  resolveOwnerFactStore: () => mocks.ownerStore,
}));

import { gatherImplicitReferentCandidates } from "./candidate-sources";

type MemoryLike = {
  id?: string;
  content?: { text?: unknown };
  metadata?: unknown;
  similarity?: unknown;
  createdAt?: unknown;
};

function memory(partial: MemoryLike) {
  return {
    id: "mem-1",
    content: { text: "travels to Tokyo" },
    metadata: { confidence: 0.8, keywords: ["travel"], validAt: undefined },
    similarity: undefined,
    createdAt: 1_720_000_000_000,
    ...partial,
  };
}

function runtime(memories: MemoryLike[]) {
  return {
    agentId: "agent-1",
    getMemories: vi.fn().mockResolvedValue(memories),
  } as never;
}

describe("gatherImplicitReferentCandidates input boundaries", () => {
  beforeEach(() => {
    mocks.ownerStore = { read: async () => ({}) };
  });

  it("returns no candidates when both sources are empty", async () => {
    await expect(
      gatherImplicitReferentCandidates(runtime([])),
    ).resolves.toEqual([]);
  });

  it("drops fact memories with blank text (null candidate)", async () => {
    const r = runtime([
      memory({ id: "m1", content: { text: "" } }),
      memory({ id: "m2", content: { text: "   " } }),
      memory({ id: "m3", content: { text: "real fact" } }),
    ]);
    const candidates = await gatherImplicitReferentCandidates(r);
    expect(candidates.map((c) => c.summary)).toEqual(["real fact"]);
  });

  it("maps a well-formed fact memory to a candidate with fallback id and trimmed summary", async () => {
    const r = runtime([
      memory({
        id: undefined,
        content: { text: "  prefers window seats  " },
        metadata: { confidence: 0.9, keywords: ["travel", 42, ""] },
        similarity: 0.95,
        createdAt: 1_720_000_000_000,
      }),
    ]);
    const [c] = await gatherImplicitReferentCandidates(r);
    expect(c).toMatchObject({
      id: "fact:0",
      source: "owner_fact",
      summary: "prefers window seats",
      label: "prefers window seats",
      prior: 0.95,
      tags: ["travel"],
      occurredAt: new Date(1_720_000_000_000).toISOString(),
    });
  });

  it("rejects non-finite similarity, then falls back to finite confidence", async () => {
    const r = runtime([
      memory({ similarity: NaN, metadata: { confidence: 0.6 } }),
    ]);
    const [c] = await gatherImplicitReferentCandidates(r);
    expect(c.prior).toBe(0.6);
  });

  it("omits prior when both similarity and confidence are non-finite", async () => {
    const r = runtime([
      memory({
        similarity: Infinity,
        metadata: { confidence: Number.NaN },
      }),
    ]);
    const [c] = await gatherImplicitReferentCandidates(r);
    expect("prior" in c).toBe(false);
  });

  it("treats malformed metadata as empty (no tags, no prior; createdAt still applies)", async () => {
    const r = runtime([memory({ metadata: "junk" })]);
    const [c] = await gatherImplicitReferentCandidates(r);
    expect("tags" in c).toBe(false);
    expect("prior" in c).toBe(false);
    expect(c.occurredAt).toBe(new Date(1_720_000_000_000).toISOString());
  });

  it("accepts validAt only when it parses as a real date", async () => {
    const r = runtime([
      memory({ metadata: { validAt: "not-a-date", confidence: 0.5 } }),
    ]);
    const [c] = await gatherImplicitReferentCandidates(r);
    expect(c.occurredAt).toBe(new Date(1_720_000_000_000).toISOString());
  });

  it("keeps a valid string validAt verbatim", async () => {
    const r = runtime([
      memory({ metadata: { validAt: "2026-01-15T00:00:00.000Z" } }),
    ]);
    const [c] = await gatherImplicitReferentCandidates(r);
    expect(c.occurredAt).toBe("2026-01-15T00:00:00.000Z");
  });

  it("omits occurredAt when neither validAt nor createdAt is usable", async () => {
    const r = runtime([
      memory({
        metadata: { validAt: "garbage" },
        createdAt: "not-a-number",
      }),
    ]);
    const [c] = await gatherImplicitReferentCandidates(r);
    expect("occurredAt" in c).toBe(false);
  });

  it("prepends owner preference candidates before fact candidates", async () => {
    mocks.ownerStore = {
      read: async () => ({
        travelBookingPreferences: {
          value: "aisle seat",
          provenance: { recordedAt: "2026-01-01T00:00:00.000Z" },
        },
        preferredNotificationChannel: {
          value: "telegram",
          provenance: { recordedAt: "2026-01-02T00:00:00.000Z" },
        },
      }),
    };
    const r = runtime([memory({ id: "f1", content: { text: "fact text" } })]);
    const candidates = await gatherImplicitReferentCandidates(r);
    expect(candidates.map((c) => c.id)).toEqual([
      "owner-fact:travelBookingPreferences",
      "owner-fact:preferredNotificationChannel",
      "f1",
    ]);
    expect(candidates[0]?.tags).toEqual(["usual", "travel"]);
  });

  it("exposes owner preference provenance without recordedAt as undefined occurredAt (degenerate)", async () => {
    // factToCandidate guards undefined occurredAt via spread; the owner
    // preference path assigns it directly, so a missing recordedAt leaks an
    // explicit undefined field. Pinned as current behavior.
    mocks.ownerStore = {
      read: async () => ({
        travelBookingPreferences: {
          value: "aisle",
          provenance: {},
        },
      }),
    };
    const [c] = await gatherImplicitReferentCandidates(runtime([]));
    expect("occurredAt" in c).toBe(true);
    expect(c.occurredAt).toBeUndefined();
  });
});
