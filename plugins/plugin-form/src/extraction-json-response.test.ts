/**
 * Pins how a single-field reply is read when the reply holds more than one
 * brace region. The answer is the newest complete region that is not the
 * response shape restated from the prompt, so prose and a shape echo on either
 * side of the answer never replace the value the model extracted.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { detectCorrection, extractSingleField } from "./extraction";
import type { FormControl } from "./types";

const control: FormControl = { key: "city", label: "City", type: "text" };

const SHAPE =
  '{"found": true, "value": "extracted value or null if not found", "confidence": 0.95, "reasoning": "schema"}';
const ANSWER =
  '{"found": true, "value": "Berlin", "confidence": 0.95, "reasoning": "named"}';

function runtimeReturning(response: string): IAgentRuntime {
  return {
    useModel: async () => response,
    getService: () => null,
    logger: { debug: () => {} },
  } as unknown as IAgentRuntime;
}

async function extract(response: string) {
  return await extractSingleField(
    runtimeReturning(response),
    "Berlin",
    control,
  );
}

describe("single-field reply parsing", () => {
  it("reads the answer after prose that holds its own braces", async () => {
    const result = await extract(
      `I treat {city} as a plain text field.\n${ANSWER}\n`,
    );

    expect(result?.value).toBe("Berlin");
  });

  it("reads the answer that follows a restated response shape", async () => {
    const result = await extract(
      `Here is the shape I used:\n${SHAPE}\nThe answer:\n${ANSWER}\n`,
    );

    expect(result?.value).toBe("Berlin");
  });

  it("reads the answer when the restated shape comes after it", async () => {
    const result = await extract(`${ANSWER}\nI used this shape:\n${SHAPE}\n`);

    expect(result?.value).toBe("Berlin");
  });

  it("keeps a cut-off reply empty instead of storing the restated shape", async () => {
    const result = await extract(
      `Here is the shape I used:\n${SHAPE}\nThe answer:\n{"found": true, "value": "Ber`,
    );

    expect(result).toBeNull();
  });

  it("keeps the answer when the reply is cut off after it", async () => {
    const result = await extract(`${ANSWER}\nNote: the shape I was given is {`);

    expect(result?.value).toBe("Berlin");
  });

  it("still reads one plain object, a fenced object, and a brace inside a value", async () => {
    expect(
      (await extract('{"found": true, "value": "Berlin", "confidence": 0.9}'))
        ?.value,
    ).toBe("Berlin");
    expect(
      (
        await extract(
          '```json\n{"found": true, "value": "Berlin", "confidence": 0.9}\n```',
        )
      )?.value,
    ).toBe("Berlin");
    expect(
      (await extract('{"found": true, "value": "a{b}c", "confidence": 0.9}'))
        ?.value,
    ).toBe("a{b}c");
  });

  it("keeps a real value that equals example text from another prompt", async () => {
    // The correction prompt shows `old@example.com`; the single-field prompt
    // does not. A user value with that shape is an answer, not a shape echo.
    for (const value of [
      "old@example.com",
      "new@example.com",
      "brief explanation",
      "<city>",
    ]) {
      const result = await extract(
        JSON.stringify({ found: true, value, confidence: 0.9 }),
      );
      expect(result?.value).toBe(value);
    }
  });

  it("keeps the placeholder text as the value when the user wrote it", async () => {
    // The user typed the placeholder string themselves, so it is their data.
    // Only a reply that restates the shape without that input is an echo.
    const spoken = "extracted value or null if not found";
    const result = await extractSingleField(
      runtimeReturning(
        JSON.stringify({ found: true, value: spoken, confidence: 0.9 }),
      ),
      spoken,
      control,
    );

    expect(result?.value).toBe(spoken);
  });
});

describe("correction reply parsing", () => {
  const email: FormControl = { key: "email", label: "Email", type: "email" };
  const examplePair = JSON.stringify({
    has_correction: true,
    corrections: [
      {
        field: "email",
        old_value: "old@example.com",
        new_value: "new@example.com",
        confidence: 0.9,
      },
    ],
  });

  async function correct(text: string) {
    return await detectCorrection(
      runtimeReturning(examplePair),
      text,
      { email: "old@example.com" },
      [email],
    );
  }

  it("keeps a correction whose real values equal the prompt example", async () => {
    // The user typed those addresses, so they are values, not placeholders.
    const corrections = await correct(
      "change old@example.com to new@example.com",
    );

    expect(corrections).toHaveLength(1);
    expect(corrections[0].value).toBe("new@example.com");
  });

  it("drops a reply that only repeats the prompt example pair", async () => {
    // The user never said either address: the reply restated the shape.
    expect(await correct("my email address is wrong")).toEqual([]);
  });

  it("drops the example pair when the user names only one side", async () => {
    // The user mentions the old address. That does not make the new address
    // their value, so the reply is still the shape restated.
    expect(await correct("old@example.com is not my address")).toEqual([]);
  });

  it("keeps the pair when the user states the new value and the form holds the old", async () => {
    // The stored value grounds the old side and the message grounds the new
    // side, so the complete correction is supported.
    const corrections = await correct("use new@example.com instead");

    expect(corrections).toHaveLength(1);
    expect(corrections[0].value).toBe("new@example.com");
  });
});
