import { describe, expect, it } from "vitest";
import { parseCalendarJsonRecord } from "../../src/internal/detail.js";

describe("calendar model JSON fences", () => {
  it("parses JSON payloads inside json5-labelled code fences", () => {
    const plan = { subaction: "list", queries: [] };
    for (const label of ["json5", "JSON5", "json", ""]) {
      expect(
        parseCalendarJsonRecord(
          `\`\`\`${label}\n${JSON.stringify(plan)}\n\`\`\``,
        ),
      ).toEqual(plan);
    }
    expect(parseCalendarJsonRecord("```json5\nnot json\n```")).toBeNull();
    expect(parseCalendarJsonRecord("```json5\n[]\n```")).toBeNull();
  });
});
