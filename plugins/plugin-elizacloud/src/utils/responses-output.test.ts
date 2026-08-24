/**
 * Unit test for elizacloud Responses-style output extraction.
 *
 * Materiality: cloud responses can carry the same body in BOTH `output_text`
 * and `output[]`/`choices[]`; joining segments duplicates the model output
 * and trips JSON.parse downstream ("Unrecognized token '`'"). The helper must
 * prefer the first non-empty source and must not merge duplicates.
 */
import { describe, expect, it } from "vitest";
import { extractResponsesOutputText } from "./responses-output.js";

describe("extractResponsesOutputText", () => {
  it("returns empty string for non-record input", () => {
    expect(extractResponsesOutputText(null)).toBe("");
    expect(extractResponsesOutputText(undefined)).toBe("");
    expect(extractResponsesOutputText("raw text")).toBe("");
    expect(extractResponsesOutputText([1, 2, 3])).toBe("");
    expect(extractResponsesOutputText(42)).toBe("");
  });

  it("prefers non-empty output_text over output[] and choices[]", () => {
    const data = {
      output_text: "the answer",
      output: [{ type: "message", content: [{ type: "output_text", text: "dup-a" }] }],
      choices: [{ text: "dup-b" }],
    };
    expect(extractResponsesOutputText(data)).toBe("the answer");
  });

  it("falls through to output[] when output_text is blank", () => {
    const data = {
      output_text: "   ",
      output: [{ type: "message", content: [{ type: "output_text", text: "from output" }] }],
    };
    expect(extractResponsesOutputText(data)).toBe("from output");
  });

  it("extracts from output[] message.content items", () => {
    const data = {
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "hello" },
            { type: "output_text", text: " world" },
          ],
        },
      ],
    };
    expect(extractResponsesOutputText(data)).toBe("hello world");
  });

  it("handles string message.content", () => {
    const data = {
      output: [{ type: "message", content: "plain string body" }],
    };
    expect(extractResponsesOutputText(data)).toBe("plain string body");
  });

  it("handles mixed content arrays of strings and objects", () => {
    const data = {
      output: [{ type: "message", content: ["lead ", { type: "text", text: "tail" }] }],
    };
    expect(extractResponsesOutputText(data)).toBe("lead tail");
  });

  it("skips non-text content items", () => {
    const data = {
      output: [
        {
          type: "message",
          content: [
            { type: "image_url", url: "https://example.com/x.png" },
            { type: "output_text", text: "only text" },
          ],
        },
      ],
    };
    expect(extractResponsesOutputText(data)).toBe("only text");
  });

  it("falls back to choices[].text", () => {
    const data = { choices: [{ text: "choice text" }] };
    expect(extractResponsesOutputText(data)).toBe("choice text");
  });

  it("extracts choices[].message.content", () => {
    const data = {
      choices: [{ message: { content: [{ type: "text", text: "nested choice" }] } }],
    };
    expect(extractResponsesOutputText(data)).toBe("nested choice");
  });

  it("returns empty when nothing extractable exists", () => {
    expect(extractResponsesOutputText({})).toBe("");
    expect(extractResponsesOutputText({ output: [] })).toBe("");
    expect(
      extractResponsesOutputText({ output: [{ type: "image_url", url: "x" }] }),
    ).toBe("");
  });

  it("does not duplicate when output_text mirrors output[]", () => {
    const body = "{\"ok\":true}";
    const data = {
      output_text: body,
      output: [{ type: "message", content: [{ type: "output_text", text: body }] }],
    };
    expect(extractResponsesOutputText(data)).toBe(body);
  });
});
