import { expect, test } from "bun:test";
import { splitMessageLosslessly } from "./message-chunking";

test("whitespace breaks preserve astral combining marks with their base", () => {
  for (const mark of ["\u{1D165}", "\u{E0100}"]) {
    const text = `aaaaaa ${mark}bbbbbbbb`;
    const chunks = splitMessageLosslessly(text, 10);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]).not.toBe("aaaaaa ");
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
  }
});
