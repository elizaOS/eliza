// Edge cases for the inline-widget region finders (choice / followups / form /
// task): adjacent markers, unicode payloads, duplicate ids, stable offsets in
// long messages, title capping, and rejection of malformed lookalike markers.
// Pure functions — no React, no jsdom.
import { describe, expect, it } from "vitest";
import { findChoiceRegions } from "./message-choice-parser";
import { findFollowupsRegions } from "./message-followups-parser";
import { findFormRegions } from "./message-form-parser";
import { findTaskRegions, MAX_TASK_TITLE_LEN } from "./message-task-parser";

describe("inline widget parser edge cases", () => {
  it("handles adjacent markers without merging regions", () => {
    const text =
      "[CHOICE:approval id=c1]\nyes=Yes\n[/CHOICE][FOLLOWUPS id=f1]\nagain=Again\n[/FOLLOWUPS]";

    const choice = findChoiceRegions(text);
    const followups = findFollowupsRegions(text);

    expect(choice).toHaveLength(1);
    expect(followups).toHaveLength(1);
    expect(choice[0].end).toBe(followups[0].start);
  });

  it("preserves unicode payloads and labels", () => {
    const [choice] = findChoiceRegions(
      "[CHOICE:language id=lang]\nja=日本語\nar=العربية\n[/CHOICE]",
    );
    const [followups] = findFollowupsRegions(
      "[FOLLOWUPS id=fu]\nprompt:继续=继续\n[/FOLLOWUPS]",
    );

    expect(choice.options).toEqual([
      { value: "ja", label: "日本語" },
      { value: "ar", label: "العربية" },
    ]);
    expect(followups.options).toEqual([
      { kind: "prompt", payload: "继续", label: "继续" },
    ]);
  });

  it("keeps duplicate ids as separate parser regions", () => {
    const text =
      "[CHOICE:approval id=dup]\nyes=Yes\n[/CHOICE]\n[CHOICE:approval id=dup]\nno=No\n[/CHOICE]";

    const regions = findChoiceRegions(text);

    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.id)).toEqual(["dup", "dup"]);
    expect(regions[0].start).toBeLessThan(regions[1].start);
  });

  it("keeps stable offsets in very long messages", () => {
    const prefix = "x".repeat(200_000);
    const marker = "[CHOICE:approval id=c1]\nyes=Yes\n[/CHOICE]";
    const [region] = findChoiceRegions(`${prefix}${marker}`);

    expect(region.start).toBe(prefix.length);
    expect(region.end).toBe(prefix.length + marker.length);
  });

  it("caps long task titles while preserving a valid region", () => {
    const id = "0123abcd-1234-5678-9abc-deadbeefcafe";
    const longTitle = "a".repeat(MAX_TASK_TITLE_LEN + 25);
    const [region] = findTaskRegions(`[TASK:${id}]${longTitle}[/TASK]`);

    expect(region.title).toHaveLength(MAX_TASK_TITLE_LEN);
    expect(region.title.endsWith("…")).toBe(true);
  });

  it("ignores malformed lookalike markers across parser types", () => {
    expect(findChoiceRegions("[CHOICE:approval]\nyes=Yes\n[/CHOIC]")).toEqual(
      [],
    );
    expect(
      findFollowupsRegions("[FOLLOWUPS]\nagain=Again\n[/FOLLOWUP]"),
    ).toEqual([]);
    expect(findFormRegions("[FORM]\n{}\n[/FOR]")).toEqual([]);
    expect(
      findTaskRegions("[TASK:0123abcd-1234-5678-9abc-deadbeefcafe][/TASK]"),
    ).toEqual([]);
  });
});
