/**
 * Parsing of `[CHECKLIST]` blocks into shared plan entries: valid items, status
 * defaulting, malformed JSON -> null, and the item cap. Pure function, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  findChecklistRegions,
  MAX_CHECKLIST_ITEMS,
  parseChecklistBody,
} from "./message-checklist-parser";

describe("parseChecklistBody", () => {
  it("parses items and defaults an unknown status to pending", () => {
    const spec = parseChecklistBody(
      '{"title":"Todos","items":[{"content":"a","status":"completed"},{"content":"b","status":"nope"}]}',
    );
    expect(spec).toEqual({
      title: "Todos",
      items: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ],
    });
  });

  it("returns null for malformed JSON or empty items", () => {
    expect(parseChecklistBody("{")).toBeNull();
    expect(parseChecklistBody('{"items":[]}')).toBeNull();
    expect(parseChecklistBody('{"items":[{"content":""}]}')).toBeNull();
  });

  it("caps the item list", () => {
    const items = Array.from({ length: MAX_CHECKLIST_ITEMS + 5 }, (_, i) => ({
      content: `c${i}`,
    }));
    const spec = parseChecklistBody(JSON.stringify({ items }));
    expect(spec?.items).toHaveLength(MAX_CHECKLIST_ITEMS);
  });

  it("finds a checklist region", () => {
    const text = '[CHECKLIST]\n{"items":[{"content":"x"}]}\n[/CHECKLIST]';
    const regions = findChecklistRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].checklist.items[0].content).toBe("x");
  });
});
