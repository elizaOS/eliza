// Unit tests for the `[CHOICE]` marker parser: option body parsing
// (value=label, equals-in-label) and region detection. Pure functions over
// string fixtures — no model, no render.

import { describe, expect, it } from "vitest";
import { findChoiceRegions, parseChoiceBody } from "./message-choice-parser";

describe("parseChoiceBody", () => {
  it("parses trimmed value=label options", () => {
    expect(parseChoiceBody(" yes = Approve \nno=Reject")).toEqual([
      { value: "yes", label: "Approve" },
      { value: "no", label: "Reject" },
    ]);
  });

  it("allows equals signs inside labels", () => {
    expect(parseChoiceBody("expr=Total = subtotal + tax")).toEqual([
      { value: "expr", label: "Total = subtotal + tax" },
    ]);
  });

  it("skips malformed lines without throwing", () => {
    expect(parseChoiceBody("\nno-equals\n=only label\nvalue=\n")).toEqual([]);
  });
});

describe("findChoiceRegions", () => {
  it("returns the region, scope, explicit id, and options", () => {
    const text =
      "Approve this?\n[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]\nDone.";
    const regions = findChoiceRegions(text);

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      id: "c1",
      scope: "approval",
      allowCustom: false,
      options: [
        { value: "yes", label: "Approve" },
        { value: "no", label: "Reject" },
      ],
    });
    expect(text.slice(regions[0].start, regions[0].end)).toContain(
      "[CHOICE:approval id=c1]",
    );
  });

  it("supports allow_custom and generated ids", () => {
    const regions = findChoiceRegions(
      "[CHOICE:booking allow_custom]\nwindow=Pick a window\n[/CHOICE]",
    );

    expect(regions).toHaveLength(1);
    expect(regions[0].allowCustom).toBe(true);
    expect(regions[0].id.length).toBeGreaterThan(0);
  });

  it("finds multiple blocks in one message", () => {
    const text =
      "[CHOICE:first id=a]\nyes=Yes\n[/CHOICE]\n[CHOICE:second id=b]\nno=No\n[/CHOICE]";

    expect(findChoiceRegions(text).map((region) => region.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("ignores blocks whose bodies have no valid options", () => {
    expect(
      findChoiceRegions("[CHOICE:approval id=c1]\nnot-a-pair\n[/CHOICE]"),
    ).toEqual([]);
  });

  it("ignores malformed or unsupported headers", () => {
    expect(findChoiceRegions("[CHOICE:bad/scope]\nyes=Yes\n[/CHOICE]")).toEqual(
      [],
    );
    expect(findChoiceRegions("[CHOICE:approval]\nyes=Yes")).toEqual([]);
  });
});
