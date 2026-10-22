/**
 * Pins how a single-field reply is read when the reply holds more than one
 * brace region. The answer is the newest complete region that is not the
 * response shape restated from the prompt, so prose and a shape echo on either
 * side of the answer never replace the value the model extracted.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { extractSingleField } from "./extraction";
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
});
