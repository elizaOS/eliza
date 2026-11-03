import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseAiJson } from "./ai-json-parse";

const AdCopy = z.object({ headlines: z.array(z.string()) });
const json = '{"headlines":["Ship agents faster"]}';

describe("parseAiJson", () => {
  test.each([
    ["bare JSON", json],
    ["fenced JSON", `\`\`\`json\n${json}\n\`\`\``],
    ["prose with a bracket before the JSON", `Here are the variants [EN]:\n${json}`],
    ["a note with braces after the JSON", `${json}\nNote: keep {brand} in title case.`],
  ])("reads the object from %s", (_name, text) => {
    expect(parseAiJson(text, AdCopy, "ad copy variants")).toEqual({
      headlines: ["Ship agents faster"],
    });
  });

  test("reports output that holds no JSON object", () => {
    expect(() => parseAiJson("No variants today.", AdCopy, "ad copy variants")).toThrow();
  });
});
