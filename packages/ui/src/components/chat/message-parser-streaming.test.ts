import { describe, expect, it } from "vitest";
import { findChoiceRegions } from "./message-choice-parser";
import { findFollowupsRegions } from "./message-followups-parser";
import { findFormRegions } from "./message-form-parser";
import { findTaskRegions } from "./message-task-parser";

const taskId = "0123abcd-1234-5678-9abc-deadbeefcafe";

const formBody = JSON.stringify({
  fields: [{ name: "destination", type: "text", label: "Destination" }],
});

const parserCases = [
  {
    name: "CHOICE",
    full: "[CHOICE:approval id=c1]\nyes=Approve\n[/CHOICE]",
    find: findChoiceRegions,
  },
  {
    name: "FOLLOWUPS",
    full: "[FOLLOWUPS id=f1]\nreply:again=Try again\n[/FOLLOWUPS]",
    find: findFollowupsRegions,
  },
  {
    name: "FORM",
    full: `[FORM]\n${formBody}\n[/FORM]`,
    find: findFormRegions,
  },
  {
    name: "TASK",
    full: `[TASK:${taskId}]Build the app[/TASK]`,
    find: findTaskRegions,
  },
];

describe("streaming inline-marker parsers", () => {
  it.each(parserCases)("does not emit a $name widget for any proper prefix", ({
    full,
    find,
  }) => {
    for (let end = 0; end < full.length; end++) {
      expect(find(full.slice(0, end))).toEqual([]);
    }
    expect(find(full)).toHaveLength(1);
  });
});
