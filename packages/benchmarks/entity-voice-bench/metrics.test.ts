import { describe, expect, it } from "vitest";
import { sessionById } from "./corpus.ts";
import {
  aggregateCells,
  countFalseMerges,
  isGrounded,
  nameHitRate,
  nameMatches,
  type SessionObservation,
  scoreBindings,
  scoreCreation,
  wordErrorRate,
} from "./metrics.ts";

function emptyObservation(sessionId: string): SessionObservation {
  return {
    sessionId,
    turns: [],
    entities: [],
    relationships: [],
    facts: [],
    speakerEntities: {},
  };
}

describe("nameMatches", () => {
  it("matches exact and subset names, rejects confusables", () => {
    expect(nameMatches("Maria", "Maria")).toBe(true);
    expect(nameMatches("Maria", "Maria Chen")).toBe(true);
    expect(nameMatches("Maria Chen", "maria chen")).toBe(true);
    expect(nameMatches("Maria", "Marie")).toBe(false);
    expect(nameMatches("Maria", "Mario")).toBe(false);
    expect(nameMatches("Erin", "Aaron")).toBe(false);
  });
});

describe("scoreCreation", () => {
  it("scores perfect creation as P=1 R=1", () => {
    const session = sessionById("homophones");
    const observation = emptyObservation("homophones");
    observation.entities = [
      { entityId: "e1", name: "Erin", attributes: [] },
      { entityId: "e2", name: "Aaron", attributes: [] },
    ];
    const cell = scoreCreation(session, observation, []);
    expect(cell.tp).toBe(2);
    expect(cell.fp).toBe(0);
    expect(cell.fn).toBe(0);
    expect(cell.precision).toBe(1);
    expect(cell.recall).toBe(1);
  });

  it("counts a bogus 'This' entity as a false positive", () => {
    const session = sessionById("homophones");
    const observation = emptyObservation("homophones");
    observation.entities = [
      { entityId: "e1", name: "Erin", attributes: [] },
      { entityId: "e3", name: "This", attributes: [] },
    ];
    const details: string[] = [];
    const cell = scoreCreation(session, observation, details);
    expect(cell.tp).toBe(1);
    expect(cell.fp).toBe(1);
    expect(cell.fn).toBe(1);
    expect(details.join("\n")).toContain("SPURIOUS");
  });
});

describe("scoreBindings", () => {
  it("credits correct re-bindings and flags duplicates", () => {
    const session = sessionById("household");
    const observation = emptyObservation("household");
    observation.speakerEntities = { jill: "e-jill", bob: "e-bob" };
    observation.turns = [
      {
        utteranceId: "household-04",
        transcript: "",
        boundEntityId: "e-jill",
        wasCreated: false,
      },
      {
        utteranceId: "household-05",
        transcript: "",
        boundEntityId: "e-bob",
        wasCreated: false,
      },
      // profile-reset turn creates a duplicate instead of re-binding
      {
        utteranceId: "household-08",
        transcript: "",
        boundEntityId: "e-dupe",
        wasCreated: true,
      },
      {
        utteranceId: "household-11",
        transcript: "",
        boundEntityId: "e-jill",
        wasCreated: false,
      },
      {
        utteranceId: "household-12",
        transcript: "",
        boundEntityId: "e-bob",
        wasCreated: false,
      },
    ];
    const details: string[] = [];
    const cell = scoreBindings(session, observation, "recognition", details);
    expect(cell.tp).toBe(4);
    expect(cell.fn).toBe(1);
    expect(cell.fp).toBe(1);
    expect(details.join("\n")).toContain("duplicate");
  });
});

describe("countFalseMerges", () => {
  it("detects two speakers folded into one entity", () => {
    const observation = emptyObservation("confusables");
    observation.speakerEntities = {
      maria: "e-1",
      mario: "e-1",
      marie: "e-2",
    };
    const details: string[] = [];
    expect(
      countFalseMerges(sessionById("confusables"), observation, details),
    ).toBe(1);
    expect(details.join("\n")).toContain("FALSE MERGE");
  });
});

describe("isGrounded", () => {
  it("accepts facts traceable to an utterance and rejects fabrications", () => {
    const session = sessionById("household");
    expect(isGrounded("Jill's birthday is on June twelfth", session)).toBe(
      true,
    );
    expect(isGrounded("Jill owns a red sailboat in Miami", session)).toBe(
      false,
    );
  });
});

describe("wordErrorRate", () => {
  it("is 0 for identical text and counts substitutions", () => {
    expect(wordErrorRate("hello world", "hello world")).toBe(0);
    expect(wordErrorRate("hello world", "hello word")).toBe(0.5);
    expect(wordErrorRate("a b c d", "a b c")).toBe(0.25);
  });
});

describe("nameHitRate", () => {
  it("measures proper-name survival", () => {
    expect(nameHitRate(["Maria Chen"], "hi i'm maria chen")).toBe(1);
    expect(nameHitRate(["Erin"], "hi i'm aaron")).toBe(0);
    expect(nameHitRate([], "anything")).toBeNull();
  });
});

describe("aggregateCells", () => {
  it("sums counts and recomputes rates", () => {
    const cell = aggregateCells([
      { tp: 2, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 },
      { tp: 0, fp: 2, fn: 2, precision: 0, recall: 0, f1: null },
    ]);
    expect(cell.tp).toBe(2);
    expect(cell.precision).toBe(0.5);
    expect(cell.recall).toBe(0.5);
  });
});
