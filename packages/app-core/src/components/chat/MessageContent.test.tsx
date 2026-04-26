import { describe, expect, it } from "vitest";
import {
  findChoiceRegions,
  parseChoiceBody,
} from "./message-choice-parser";

describe("parseChoiceBody", () => {
  it("parses key = label lines and ignores blank lines", () => {
    const options = parseChoiceBody(
      "new = Create new\nedit-1 = Edit Babylon\n\ncancel = Cancel",
    );
    expect(options).toEqual([
      { value: "new", label: "Create new" },
      { value: "edit-1", label: "Edit Babylon" },
      { value: "cancel", label: "Cancel" },
    ]);
  });

  it("skips lines without an equals sign", () => {
    expect(parseChoiceBody("just text\nok = Yes")).toEqual([
      { value: "ok", label: "Yes" },
    ]);
  });
});

describe("findChoiceRegions", () => {
  it("parses a CHOICE block with explicit id into a choice region", () => {
    const text =
      "Pick one:\n[CHOICE:app-create id=abc]\nnew = New\ncancel = Cancel\n[/CHOICE]";
    const regions = findChoiceRegions(text);
    expect(regions).toHaveLength(1);
    const [region] = regions;
    expect(region.id).toBe("abc");
    expect(region.scope).toBe("app-create");
    expect(region.options).toEqual([
      { value: "new", label: "New" },
      { value: "cancel", label: "Cancel" },
    ]);
  });

  it("synthesises an id when the marker omits one", () => {
    const text = "[CHOICE:plugin-create]\nyes = Yes\nno = No\n[/CHOICE]";
    const regions = findChoiceRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].id.length).toBeGreaterThan(0);
    expect(regions[0].scope).toBe("plugin-create");
    expect(regions[0].options).toHaveLength(2);
  });

  it("returns the matched start/end positions covering the whole block", () => {
    const text =
      "before\n[CHOICE:app-create id=x]\nnew = New\n[/CHOICE]\nafter";
    const regions = findChoiceRegions(text);
    expect(regions).toHaveLength(1);
    const slice = text.slice(regions[0].start, regions[0].end);
    expect(slice.startsWith("[CHOICE:")).toBe(true);
    expect(slice.endsWith("[/CHOICE]")).toBe(true);
  });
});
