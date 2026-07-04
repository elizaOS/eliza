// Unit tests for the `[FOLLOWUPS]` marker parser: chip body parsing (reply /
// navigate / prompt kinds, defaulting, MAX_FOLLOWUPS cap) and region detection.
// Pure functions over string fixtures — no model, no render.

import { describe, expect, it } from "vitest";
import {
  findFollowupsRegions,
  MAX_FOLLOWUPS,
  parseFollowupsBody,
} from "./message-followups-parser";

describe("parseFollowupsBody", () => {
  it("defaults bare value=label lines to the reply kind", () => {
    const options = parseFollowupsBody("yes please=Yes\nno thanks=No");
    expect(options).toEqual([
      { kind: "reply", payload: "yes please", label: "Yes" },
      { kind: "reply", payload: "no thanks", label: "No" },
    ]);
  });

  it("parses explicit kind prefixes", () => {
    const options = parseFollowupsBody(
      "reply:run it=Run it\nnavigate:/apps=Open apps\nprompt:Draft a reply=Draft",
    );
    expect(options).toEqual([
      { kind: "reply", payload: "run it", label: "Run it" },
      { kind: "navigate", payload: "/apps", label: "Open apps" },
      { kind: "prompt", payload: "Draft a reply", label: "Draft" },
    ]);
  });

  it("treats an unknown kind prefix as part of a reply payload", () => {
    const options = parseFollowupsBody("bogus:thing=Label");
    expect(options).toEqual([
      { kind: "reply", payload: "bogus:thing", label: "Label" },
    ]);
  });

  it("skips malformed lines without throwing", () => {
    const options = parseFollowupsBody(
      "\n   \nno-equals-here\n=only label\nv=",
    );
    expect(options).toEqual([]);
  });

  it("caps the number of options", () => {
    const lines = Array.from(
      { length: MAX_FOLLOWUPS + 3 },
      (_, i) => `v${i}=Label ${i}`,
    ).join("\n");
    expect(parseFollowupsBody(lines)).toHaveLength(MAX_FOLLOWUPS);
  });
});

describe("findFollowupsRegions", () => {
  it("returns the region and a generated id when none is supplied", () => {
    const text = "Here you go.\n[FOLLOWUPS]\nrerun=Run again\n[/FOLLOWUPS]";
    const regions = findFollowupsRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].options).toEqual([
      { kind: "reply", payload: "rerun", label: "Run again" },
    ]);
    expect(regions[0].id.length).toBeGreaterThan(0);
    expect(text.slice(regions[0].start, regions[0].end)).toContain(
      "[FOLLOWUPS]",
    );
  });

  it("uses the explicit id from the marker", () => {
    const regions = findFollowupsRegions(
      "[FOLLOWUPS id=abc123]\nx=One\n[/FOLLOWUPS]",
    );
    expect(regions[0].id).toBe("abc123");
  });

  it("ignores a block whose body has no valid options", () => {
    expect(
      findFollowupsRegions("[FOLLOWUPS]\nnot-a-pair\n[/FOLLOWUPS]"),
    ).toEqual([]);
  });

  it("finds multiple blocks in one message", () => {
    const text =
      "[FOLLOWUPS]\na=A\n[/FOLLOWUPS]\nmiddle\n[FOLLOWUPS]\nb=B\n[/FOLLOWUPS]";
    expect(findFollowupsRegions(text)).toHaveLength(2);
  });
});
