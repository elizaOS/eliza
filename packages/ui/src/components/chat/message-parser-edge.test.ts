import { describe, expect, it } from "vitest";
import { findChoiceRegions } from "./message-choice-parser";
import { findFollowupsRegions } from "./message-followups-parser";
import { findFormRegions } from "./message-form-parser";
import { normalizeDisplayText } from "./message-parser-helpers";
import { findTaskRegions, MAX_TASK_TITLE_LEN } from "./message-task-parser";

const taskId = "0123abcd-1234-5678-9abc-deadbeefcafe";

describe("inline marker parser edge cases", () => {
  it("parses adjacent markers without one parser swallowing the next", () => {
    const formBody = JSON.stringify({
      id: "edge-form",
      fields: [{ name: "topic", type: "text", label: "Topic" }],
    });
    const text =
      "[CHOICE:approval id=dup]\ny=Yes\n[/CHOICE]" +
      "[FOLLOWUPS id=dup]\nnavigate:/apps=Open apps\n[/FOLLOWUPS]" +
      `[FORM]\n${formBody}\n[/FORM]` +
      `[TASK:${taskId}]Review launch notes[/TASK]`;

    const choices = findChoiceRegions(text);
    const followups = findFollowupsRegions(text);
    const forms = findFormRegions(text);
    const tasks = findTaskRegions(text);

    expect(choices).toHaveLength(1);
    expect(followups).toHaveLength(1);
    expect(forms).toHaveLength(1);
    expect(tasks).toHaveLength(1);
    expect(choices[0].end).toBe(followups[0].start);
    expect(followups[0].end).toBe(forms[0].start);
    expect(forms[0].end).toBe(tasks[0].start);
  });

  it("preserves unicode labels and task titles", () => {
    const choice = findChoiceRegions(
      "[CHOICE:greeting id=c1]\nhello=Bonjour \u2600\uFE0F\n[/CHOICE]",
    );
    const followups = findFollowupsRegions(
      "[FOLLOWUPS id=f1]\nreply:\u4F60\u597D=Say hello\n[/FOLLOWUPS]",
    );
    const tasks = findTaskRegions(
      `[TASK:${taskId}]\u4ED5\u4E8B\u3092\u78BA\u8A8D[/TASK]`,
    );

    expect(choice[0].options[0]).toEqual({
      value: "hello",
      label: "Bonjour \u2600\uFE0F",
    });
    expect(followups[0].options[0]).toEqual({
      kind: "reply",
      payload: "\u4F60\u597D",
      label: "Say hello",
    });
    expect(tasks[0].title).toBe("\u4ED5\u4E8B\u3092\u78BA\u8A8D");
  });

  it("keeps duplicate ids as distinct regions instead of deduping", () => {
    const choices = findChoiceRegions(
      "[CHOICE:one id=dup]\na=A\n[/CHOICE]\n[CHOICE:two id=dup]\nb=B\n[/CHOICE]",
    );
    const followups = findFollowupsRegions(
      "[FOLLOWUPS id=dup]\na=A\n[/FOLLOWUPS]\n[FOLLOWUPS id=dup]\nb=B\n[/FOLLOWUPS]",
    );

    expect(choices.map((region) => region.id)).toEqual(["dup", "dup"]);
    expect(choices.map((region) => region.scope)).toEqual(["one", "two"]);
    expect(followups.map((region) => region.id)).toEqual(["dup", "dup"]);
  });

  it("bounds normalized display text before later parser passes", () => {
    const longPrefix = "x".repeat(200_010);
    const marker = "[CHOICE:late id=c1]\ny=Yes\n[/CHOICE]";
    const normalized = normalizeDisplayText(`${longPrefix}${marker}`);

    expect(normalized).toHaveLength(200_000);
    expect(normalized).not.toContain("[CHOICE:late");
    expect(findChoiceRegions(normalized)).toEqual([]);
  });

  it("keeps task title bounds stable for very long titles", () => {
    const longTitle = "x".repeat(MAX_TASK_TITLE_LEN + 100);
    const tasks = findTaskRegions(`[TASK:${taskId}]${longTitle}[/TASK]`);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toHaveLength(MAX_TASK_TITLE_LEN);
    expect(tasks[0].title.endsWith("…")).toBe(true);
  });

  it("ignores malformed markers across parser families", () => {
    expect(findChoiceRegions("[CHOICE id=c1]\ny=Yes\n[/CHOICE]")).toEqual([]);
    expect(findFollowupsRegions("[FOLLOWUPS id=f1]\ny=Yes\n[/CHOICE]")).toEqual(
      [],
    );
    expect(
      findFormRegions('[FORM]\n{"fields":[{"name":"bad.name"}]}\n[/FORM]'),
    ).toEqual([]);
    expect(findTaskRegions("[TASK:ABCDEF12]Title[/TASK]")).toEqual([]);
  });
});
