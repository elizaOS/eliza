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

  test("prefers a fenced object over a JSON snippet quoted in the prose", () => {
    const AdCopyVariants = z.object({
      headlines: z.array(z.string()),
      descriptions: z.array(z.string()),
      callToActions: z.array(z.string()),
      hashtags: z.array(z.string()),
    });
    const payload = {
      headlines: ["Ship agents faster"],
      descriptions: ["Build once"],
      callToActions: ["Try Eliza"],
      hashtags: ["agents"],
    };
    const json = JSON.stringify(payload);
    const reply = [
      'The status badge reads {"ok": true}.',
      "Here is the promotional JSON:",
      "```json",
      json,
      "```",
    ].join("\n");
    expect(parseAiJson(reply, AdCopyVariants, "ad copy variants")).toEqual(payload);
  });

  test("reports output that holds no JSON object", () => {
    expect(() => parseAiJson("No variants today.", AdCopy, "ad copy variants")).toThrow();
  });
});
