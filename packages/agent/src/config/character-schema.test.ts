/**
 * CharacterSchema is the parse-time contract for PUT /api/character: every
 * field is optional so a caller can send a partial overlay; empty username,
 * bio, and style objects are the documented clear forms; unknown keys fail
 * closed because the object is strict. Deterministic, no live services.
 */
import { describe, expect, it } from "vitest";
import { CharacterSchema } from "./character-schema.ts";

function parsed(value: unknown) {
  return CharacterSchema.safeParse(value);
}

function expectOk(value: unknown, data: unknown = value) {
  const result = parsed(value);
  expect(result.success).toBe(true);
  if (result.success) expect(result.data).toEqual(data);
}

function expectFail(value: unknown) {
  expect(parsed(value).success).toBe(false);
}

describe("CharacterSchema", () => {
  it("accepts an empty object because every field is optional", () => {
    expectOk({});
  });

  it("round-trips a fully populated valid character", () => {
    const character = {
      name: "Ada",
      username: "ada",
      bio: ["mathematician"],
      system: "Be precise.",
      adjectives: ["curious"],
      topics: ["math"],
      style: { all: ["terse"], chat: ["warm"], post: ["witty"] },
      messageExamples: [
        {
          examples: [
            {
              name: "Ada",
              content: { text: "hello", actions: ["REPLY"] },
            },
          ],
        },
      ],
      postExamples: ["A note on analysis."],
    };
    expectOk(character);
  });

  it("rejects a non-object root", () => {
    expectFail(null);
    expectFail(undefined);
    expectFail("Ada");
    expectFail(1);
    expectFail([]);
  });

  it("rejects unknown top-level keys (strict)", () => {
    expectFail({ extra: true });
    expectFail({ name: "Ada", plugins: [] });
  });
});

describe("CharacterSchema name", () => {
  it("accepts a single in-range name and the max length", () => {
    expectOk({ name: "Ada" });
    expectOk({ name: "a".repeat(100) });
  });

  it("rejects an empty name and overflow past 100", () => {
    expectFail({ name: "" });
    expectFail({ name: "a".repeat(101) });
    expectFail({ name: 1 });
  });
});

describe("CharacterSchema username", () => {
  it("accepts the empty string as the documented clear form", () => {
    expectOk({ username: "" });
  });

  it("accepts a username at the 50-character cap", () => {
    expectOk({ username: "a".repeat(50) });
  });

  it("rejects overflow past 50 and a non-string", () => {
    expectFail({ username: "a".repeat(51) });
    expectFail({ username: 1 });
  });
});

describe("CharacterSchema bio", () => {
  it("accepts a string, including the empty clear form", () => {
    expectOk({ bio: "mathematician" });
    expectOk({ bio: "" });
  });

  it("accepts an array of strings, including the empty queue", () => {
    expectOk({ bio: [] });
    expectOk({ bio: ["one"] });
    expectOk({ bio: ["one", "two"] });
  });

  it("rejects a non-string bio and a non-string array element", () => {
    expectFail({ bio: 1 });
    expectFail({ bio: [1] });
    expectFail({ bio: ["ok", null] });
  });
});

describe("CharacterSchema system", () => {
  it("accepts empty text and the 10000-character cap", () => {
    expectOk({ system: "" });
    expectOk({ system: "a".repeat(10000) });
  });

  it("rejects overflow past 10000 and a non-string", () => {
    expectFail({ system: "a".repeat(10001) });
    expectFail({ system: ["prompt"] });
  });
});

describe("CharacterSchema adjectives and topics", () => {
  it("accepts an empty queue and a single in-range element", () => {
    expectOk({ adjectives: [] });
    expectOk({ topics: [] });
    expectOk({ adjectives: ["curious"] });
    expectOk({ topics: ["math"] });
    expectOk({ adjectives: ["a".repeat(100)] });
    expectOk({ topics: ["a".repeat(100)] });
  });

  it("rejects an empty item, overflow past 100, and a non-string item", () => {
    expectFail({ adjectives: [""] });
    expectFail({ topics: [""] });
    expectFail({ adjectives: ["a".repeat(101)] });
    expectFail({ topics: ["a".repeat(101)] });
    expectFail({ adjectives: [1] });
    expectFail({ topics: [null] });
  });
});

describe("CharacterSchema style", () => {
  it("accepts an empty object as the documented clear form", () => {
    expectOk({ style: {} });
  });

  it("accepts optional all/chat/post arrays, including empty queues", () => {
    expectOk({ style: { all: [], chat: [], post: [] } });
    expectOk({ style: { all: ["terse"] } });
    expectOk({ style: { chat: ["warm"], post: ["witty"] } });
  });

  it("rejects unknown style keys, a non-array list, and null", () => {
    expectFail({ style: { extra: [] } });
    expectFail({ style: { all: "terse" } });
    expectFail({ style: null });
  });
});

describe("CharacterSchema messageExamples", () => {
  it("accepts an empty outer queue and a single valid group", () => {
    expectOk({ messageExamples: [] });
    expectOk({
      messageExamples: [
        { examples: [{ name: "Ada", content: { text: "hello" } }] },
      ],
    });
  });

  it("rejects a group whose examples queue is empty", () => {
    expectFail({ messageExamples: [{ examples: [] }] });
  });

  it("rejects a missing examples key and extra group keys", () => {
    expectFail({ messageExamples: [{}] });
    expectFail({
      messageExamples: [
        {
          examples: [{ name: "Ada", content: { text: "hello" } }],
          extra: true,
        },
      ],
    });
  });

  it("rejects an empty example name or empty content text", () => {
    expectFail({
      messageExamples: [
        { examples: [{ name: "", content: { text: "hello" } }] },
      ],
    });
    expectFail({
      messageExamples: [{ examples: [{ name: "Ada", content: { text: "" } }] }],
    });
  });

  it("rejects extra keys on an example or its content", () => {
    expectFail({
      messageExamples: [
        {
          examples: [{ name: "Ada", content: { text: "hello" }, extra: true }],
        },
      ],
    });
    expectFail({
      messageExamples: [
        {
          examples: [{ name: "Ada", content: { text: "hello", extra: true } }],
        },
      ],
    });
  });

  it("accepts optional actions and rejects a missing content object", () => {
    expectOk({
      messageExamples: [
        {
          examples: [{ name: "Ada", content: { text: "hello", actions: [] } }],
        },
      ],
    });
    expectFail({
      messageExamples: [{ examples: [{ name: "Ada" }] }],
    });
  });
});

describe("CharacterSchema postExamples", () => {
  it("accepts an empty queue, a single string, and an empty string item", () => {
    expectOk({ postExamples: [] });
    expectOk({ postExamples: ["A note."] });
    expectOk({ postExamples: [""] });
  });

  it("rejects a non-array and a non-string item", () => {
    expectFail({ postExamples: "A note." });
    expectFail({ postExamples: [1] });
  });
});
