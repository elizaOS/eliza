// Streaming guarantee for the inline-widget region finders: a partially streamed
// block emits no region until its closing marker has fully arrived, so half-typed
// markers never flash a broken widget mid-stream. Pure functions — no jsdom.
import { describe, expect, it } from "vitest";
import { findChoiceRegions } from "./message-choice-parser";
import { findFollowupsRegions } from "./message-followups-parser";
import { findFormRegions } from "./message-form-parser";
import { findTaskRegions } from "./message-task-parser";

describe("inline widget parser streaming prefixes", () => {
  const cases = [
    {
      name: "CHOICE",
      text: "[CHOICE:approval id=c1]\nyes=Approve\n[/CHOICE]",
      find: findChoiceRegions,
    },
    {
      name: "FORM",
      text: '[FORM]\n{"fields":[{"name":"email","type":"text"}]}\n[/FORM]',
      find: findFormRegions,
    },
    {
      name: "FOLLOWUPS",
      text: "[FOLLOWUPS id=f1]\nreply=Reply\n[/FOLLOWUPS]",
      find: findFollowupsRegions,
    },
    {
      name: "TASK",
      text: "[TASK:0123abcd-1234-5678-9abc-deadbeefcafe]Build it[/TASK]",
      find: findTaskRegions,
    },
  ] as const;

  for (const { name, text, find } of cases) {
    it(`${name} emits no region until the closing marker has fully streamed`, () => {
      for (let length = 1; length < text.length; length += 1) {
        expect(find(text.slice(0, length)), `prefix length ${length}`).toEqual(
          [],
        );
      }

      expect(find(text)).toHaveLength(1);
    });
  }
});
