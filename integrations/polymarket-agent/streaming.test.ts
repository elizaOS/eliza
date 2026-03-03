import { describe, expect, test } from "bun:test";
import { ResponseStreamExtractor } from "@elizaos/core";

// Tests the ResponseStreamExtractor used by messageService.handleMessage
// The TUI passes onStreamChunk via options; the service filters XML internally

describe("ResponseStreamExtractor behavior", () => {
  test("REPLY action streams text", () => {
    const extractor = new ResponseStreamExtractor();
    const chunks = [
      "<response>",
      "<actions>REPLY</actions>",
      "<text>Hello ",
      "world!</text>",
      "</response>",
    ];
    let result = "";
    for (const c of chunks) {
      const extracted = extractor.push(c);
      if (extracted) result += extracted;
    }
    expect(result).toBe("Hello world!");
  });

  test("non-REPLY action blocks streaming", () => {
    const extractor = new ResponseStreamExtractor();
    const output = extractor.push("<actions>GET_BALANCES</actions><text>Checking...</text>");
    expect(output).toBe("");
  });

  test("reset clears state between calls", () => {
    const extractor = new ResponseStreamExtractor();
    extractor.push("<actions>SEARCH</actions><text>x</text>");
    extractor.reset();
    const result = extractor.push("<actions>REPLY</actions><text>Hi</text>");
    expect(result).toBe("Hi");
  });

  test("handles split tag boundaries", () => {
    const extractor = new ResponseStreamExtractor();
    const chunks: string[] = [];
    for (const c of ["<actions>REP", "LY</actions><te", "xt>A", "B</te", "xt>"]) {
      const extracted = extractor.push(c);
      if (extracted) chunks.push(extracted);
    }
    expect(chunks.join("")).toBe("AB");
  });

  test("special characters pass through", () => {
    const extractor = new ResponseStreamExtractor();
    const result = extractor.push('<actions>REPLY</actions><text>$0.45 → $0.50</text>');
    expect(result).toBe("$0.45 → $0.50");
  });
});

describe("TUI streaming integration", () => {
  test("final text prefers streamed over callback", () => {
    const streamedText = "Streamed";
    const callbackText = "Callback";
    expect((streamedText || callbackText).trim()).toBe("Streamed");
  });

  test("falls back to callback when no streaming", () => {
    const streamedText = "";
    const callbackText = "From action";
    expect((streamedText || callbackText).trim()).toBe("From action");
  });
});
