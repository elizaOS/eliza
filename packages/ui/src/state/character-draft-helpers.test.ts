import { expect, test } from "vitest";
import { normalizeGeneratedMessageExamples } from "./character-draft-helpers";

test("character examples stop JSON before trailing prose", () => {
  const records = [
    { role: "user", content: 'Hello [world] "quoted" \\ slash' },
  ];
  for (const normalize of [normalizeGeneratedMessageExamples]) {
    const expected = normalize(records);
    for (const value of [records, { messageExamples: records }, [records]]) {
      const json = JSON.stringify(value);
      for (const prefix of ["", "Examples: "]) {
        expect(normalize(`${prefix}${json} Note: [keep] {these}`)).toEqual(
          expected,
        );
      }
      expect(normalize(json)).toEqual(expected);
      expect(normalize(`\`\`\`json\r\n${json}\r\n\`\`\``)).toEqual(expected);
    }
    for (const input of [
      "not JSON",
      "[{broken] trailing ]",
      '{"messageExamples":"unterminated',
    ]) {
      expect(normalize(input)).toEqual([]);
    }
  }
});
