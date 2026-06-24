import { describe, expect, it } from "vitest";
import { findChoiceRegions, parseChoiceBody } from "./message-choice-parser";

describe("parseChoiceBody", () => {
  it("parses value=label rows and preserves equals signs in labels", () => {
    expect(parseChoiceBody("yes=Approve\nno=Reject\nexpr=a=b=c")).toEqual([
      { value: "yes", label: "Approve" },
      { value: "no", label: "Reject" },
      { value: "expr", label: "a=b=c" },
    ]);
  });

  it("trims rows and skips malformed options", () => {
    expect(
      parseChoiceBody("\n no-equals \n =missing value \n v= \n ok = OK "),
    ).toEqual([{ value: "ok", label: "OK" }]);
  });
});

describe("findChoiceRegions", () => {
  it("locates a CHOICE block with an explicit id and allow_custom flag", () => {
    const text =
      "Approve this?\n[CHOICE:approval allow_custom id=choice-1]\nyes=Approve\nno=Reject\n[/CHOICE]";
    const regions = findChoiceRegions(text);

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      id: "choice-1",
      scope: "approval",
      allowCustom: true,
      options: [
        { value: "yes", label: "Approve" },
        { value: "no", label: "Reject" },
      ],
    });
    expect(text.slice(regions[0].start, regions[0].end)).toBe(
      "[CHOICE:approval allow_custom id=choice-1]\nyes=Approve\nno=Reject\n[/CHOICE]",
    );
  });

  it("generates an id when none is supplied", () => {
    const regions = findChoiceRegions("[CHOICE:next]\na=A\n[/CHOICE]");
    expect(regions).toHaveLength(1);
    expect(regions[0].id.length).toBeGreaterThan(0);
  });

  it("allows hyphenated and underscored scopes", () => {
    const regions = findChoiceRegions(
      "[CHOICE:app_create-flow id=c1]\nrun=Run\n[/CHOICE]",
    );
    expect(regions[0].scope).toBe("app_create-flow");
  });

  it("ignores blocks with no valid options", () => {
    expect(
      findChoiceRegions("[CHOICE:approval id=c1]\nnot-a-pair\n[/CHOICE]"),
    ).toEqual([]);
  });

  it("ignores malformed or unterminated markers", () => {
    expect(findChoiceRegions("[CHOICE id=c1]\ny=Yes\n[/CHOICE]")).toEqual([]);
    expect(findChoiceRegions("[CHOICE:approval id=c1]\ny=Yes")).toEqual([]);
  });

  it("finds multiple blocks in one message", () => {
    const text =
      "[CHOICE:first id=a]\ny=Yes\n[/CHOICE]\nthen\n[CHOICE:second id=b]\nn=No\n[/CHOICE]";
    const regions = findChoiceRegions(text);
    expect(regions.map((region) => region.id)).toEqual(["a", "b"]);
    expect(regions.map((region) => region.scope)).toEqual(["first", "second"]);
  });
});
