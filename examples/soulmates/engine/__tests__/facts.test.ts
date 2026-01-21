import { beforeEach, describe, expect, it } from "vitest";
import { deduplicateFacts, type FactInput, upsertFact } from "../facts";
import { generatePersonas } from "../generator";
import type { Fact, Persona } from "../types";

const createFact = (
  id: number,
  overrides: Partial<Fact> &
    Pick<FactInput, "type" | "key" | "value" | "confidence" | "evidence">,
): Fact => ({
  factId: `fact-test-${id}`,
  status: "active",
  createdAt: "2026-01-18T12:00:00.000Z",
  ...overrides,
});

describe("upsertFact", () => {
  let persona: Persona;
  const now = "2026-01-18T12:00:00.000Z";

  beforeEach(() => {
    const personas = generatePersonas({ seed: 42, count: 1, now });
    persona = personas[0];
  });

  it("should add new fact to persona", () => {
    const initialLength = persona.facts.length;
    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence: [],
      },
      now,
    );
    expect(persona.facts.length).toBe(initialLength + 1);
    expect(persona.facts[persona.facts.length - 1].key).toBe(
      "preference:coffee",
    );
  });

  it("should update existing fact with same key", () => {
    const input: FactInput = {
      type: "preference",
      key: "preference:coffee",
      value: "likes_coffee",
      confidence: 0.7,
      evidence: [],
    };
    upsertFact(persona, input, now);
    const initialLength = persona.facts.length;

    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence: [],
      },
      now,
    );

    expect(persona.facts.length).toBe(initialLength);
    const updated = persona.facts.find((f) => f.key === "preference:coffee");
    expect(updated?.value).toBe("loves_espresso");
    expect(updated?.confidence).toBe(0.9);
  });

  it("should merge evidence when updating fact", () => {
    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence: [{ conversationId: "conv-1", turnIds: ["turn-1"] }],
      },
      now,
    );

    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.95,
        evidence: [{ conversationId: "conv-2", turnIds: ["turn-2"] }],
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "preference:coffee");
    expect(fact?.evidence.length).toBe(2);
    expect(fact?.evidence.some((e) => e.conversationId === "conv-1")).toBe(
      true,
    );
    expect(fact?.evidence.some((e) => e.conversationId === "conv-2")).toBe(
      true,
    );
  });

  it("should keep higher confidence when values differ", () => {
    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "dislikes_coffee",
        confidence: 0.6,
        evidence: [],
      },
      now,
    );

    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence: [],
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "preference:coffee");
    expect(fact?.value).toBe("loves_espresso");
    expect(fact?.confidence).toBe(0.9);
  });

  it("should not replace higher confidence fact with lower confidence", () => {
    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence: [],
      },
      now,
    );

    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "dislikes_coffee",
        confidence: 0.5,
        evidence: [],
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "preference:coffee");
    expect(fact?.value).toBe("loves_espresso");
    expect(fact?.confidence).toBe(0.9);
  });

  it("should handle array values correctly", () => {
    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:hobbies",
        value: ["reading", "hiking"],
        confidence: 0.8,
        evidence: [],
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "preference:hobbies");
    expect(Array.isArray(fact?.value)).toBe(true);
    expect(fact?.value).toEqual(["reading", "hiking"]);
  });

  it("should update array values correctly", () => {
    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:hobbies",
        value: ["reading"],
        confidence: 0.7,
        evidence: [],
      },
      now,
    );

    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:hobbies",
        value: ["reading", "hiking", "cooking"],
        confidence: 0.9,
        evidence: [],
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "preference:hobbies");
    expect(fact?.value).toEqual(["reading", "hiking", "cooking"]);
  });

  it("should not duplicate evidence", () => {
    const evidence = [{ conversationId: "conv-1", turnIds: ["turn-1"] }];
    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence,
      },
      now,
    );

    upsertFact(
      persona,
      {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.95,
        evidence,
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "preference:coffee");
    expect(fact?.evidence.length).toBe(1);
  });
});

describe("deduplicateFacts", () => {
  let persona: Persona;
  const now = "2026-01-18T12:00:00.000Z";

  beforeEach(() => {
    const personas = generatePersonas({ seed: 42, count: 1, now });
    persona = personas[0];
    persona.facts = [];
  });

  it("should remove duplicate facts with same key and value", () => {
    persona.facts = [
      createFact(1, {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.8,
        evidence: [{ conversationId: "conv-1", turnIds: ["turn-1"] }],
      }),
      createFact(2, {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence: [{ conversationId: "conv-2", turnIds: ["turn-2"] }],
      }),
    ];

    deduplicateFacts(persona);
    expect(persona.facts.length).toBe(1);
    expect(persona.facts[0].confidence).toBe(0.9);
    expect(persona.facts[0].evidence.length).toBe(2);
  });

  it("should keep facts with different keys", () => {
    persona.facts = [
      createFact(1, {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.8,
        evidence: [],
      }),
      createFact(2, {
        type: "preference",
        key: "preference:tea",
        value: "loves_green_tea",
        confidence: 0.9,
        evidence: [],
      }),
    ];

    deduplicateFacts(persona);
    expect(persona.facts.length).toBe(2);
  });

  it("should keep facts with same key but different values", () => {
    persona.facts = [
      createFact(1, {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.8,
        evidence: [],
      }),
      createFact(2, {
        type: "preference",
        key: "preference:coffee",
        value: "dislikes_coffee",
        confidence: 0.7,
        evidence: [],
      }),
    ];

    deduplicateFacts(persona);
    expect(persona.facts.length).toBe(1);
    expect(persona.facts[0].value).toBe("loves_espresso");
  });

  it("should handle empty facts array", () => {
    persona.facts = [];
    deduplicateFacts(persona);
    expect(persona.facts.length).toBe(0);
  });

  it("should consolidate evidence across duplicates", () => {
    persona.facts = [
      createFact(1, {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.8,
        evidence: [{ conversationId: "conv-1", turnIds: ["turn-1"] }],
      }),
      createFact(2, {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.85,
        evidence: [{ conversationId: "conv-2", turnIds: ["turn-2"] }],
      }),
      createFact(3, {
        type: "preference",
        key: "preference:coffee",
        value: "loves_espresso",
        confidence: 0.9,
        evidence: [{ conversationId: "conv-3", turnIds: ["turn-3"] }],
      }),
    ];

    deduplicateFacts(persona);
    expect(persona.facts.length).toBe(1);
    expect(persona.facts[0].evidence.length).toBe(3);
    expect(persona.facts[0].confidence).toBe(0.9);
  });

  it("should handle facts with array values", () => {
    persona.facts = [
      createFact(1, {
        type: "preference",
        key: "preference:hobbies",
        value: ["reading", "hiking"],
        confidence: 0.8,
        evidence: [],
      }),
      createFact(2, {
        type: "preference",
        key: "preference:hobbies",
        value: ["reading", "hiking"],
        confidence: 0.9,
        evidence: [],
      }),
    ];

    deduplicateFacts(persona);
    expect(persona.facts.length).toBe(1);
    expect(persona.facts[0].confidence).toBe(0.9);
  });

  it("should not remove facts with different array values", () => {
    persona.facts = [
      createFact(1, {
        type: "preference",
        key: "preference:hobbies",
        value: ["reading"],
        confidence: 0.8,
        evidence: [],
      }),
      createFact(2, {
        type: "preference",
        key: "preference:hobbies",
        value: ["reading", "hiking"],
        confidence: 0.9,
        evidence: [],
      }),
    ];

    deduplicateFacts(persona);
    expect(persona.facts.length).toBe(1);
    expect(persona.facts[0].value).toEqual(["reading", "hiking"]);
  });
});

describe("Fact Evidence Integrity", () => {
  let persona: Persona;
  const now = "2026-01-18T12:00:00.000Z";

  beforeEach(() => {
    const personas = generatePersonas({ seed: 42, count: 1, now });
    persona = personas[0];
  });

  it("should preserve evidence conversationIds", () => {
    const evidence = [
      { conversationId: "conv-1", turnIds: ["turn-1", "turn-2"] },
      { conversationId: "conv-2", turnIds: ["turn-3"] },
    ];

    upsertFact(
      persona,
      {
        type: "conversation",
        key: "conversation:recent",
        value: "test",
        confidence: 0.8,
        evidence,
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "conversation:recent");
    expect(fact?.evidence.length).toBe(2);
    expect(fact?.evidence[0].conversationId).toBe("conv-1");
    expect(fact?.evidence[1].conversationId).toBe("conv-2");
  });

  it("should preserve turnIds in evidence", () => {
    const evidence = [
      { conversationId: "conv-1", turnIds: ["turn-1", "turn-2", "turn-3"] },
    ];

    upsertFact(
      persona,
      {
        type: "conversation",
        key: "conversation:recent",
        value: "test",
        confidence: 0.8,
        evidence,
      },
      now,
    );

    const fact = persona.facts.find((f) => f.key === "conversation:recent");
    expect(fact?.evidence[0].turnIds.length).toBe(3);
    expect(fact?.evidence[0].turnIds).toEqual(["turn-1", "turn-2", "turn-3"]);
  });
});
