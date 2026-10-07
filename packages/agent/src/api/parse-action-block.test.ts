import { describe, expect, it } from "vitest";
import {
  parseActionBlock,
  stripActionBlockFromDisplay,
} from "./parse-action-block.ts";

const respondWithBrace =
  'See this.\n{"action":"respond","response":"use } here","reasoning":"because {config}"}';
const respondThenProse =
  '{"action":"respond","response":"hi","reasoning":"ok"}\nThanks.';
const escapedQuote =
  '{"action":"respond","response":"say \\"hi\\"}","reasoning":"ok"}';

describe("parseActionBlock", () => {
  it("keeps a closing brace that sits inside the response string", () => {
    const parsed = parseActionBlock(respondWithBrace);
    expect(parsed?.action).toBe("respond");
    expect(parsed?.response).toBe("use } here");
    expect(parsed?.reasoning).toBe("because {config}");
    expect(stripActionBlockFromDisplay(respondWithBrace)).toBe("See this.");
  });

  it("parses an action that is followed by prose and hides the JSON", () => {
    expect(parseActionBlock(respondThenProse)?.response).toBe("hi");
    expect(stripActionBlockFromDisplay(respondThenProse)).toBe("Thanks.");
  });

  it("keeps an escaped quote and a later brace in the response", () => {
    expect(parseActionBlock(escapedQuote)?.response).toBe('say "hi"}');
    expect(stripActionBlockFromDisplay(escapedQuote)).toBe("");
  });

  it("parses and strips a fenced block whose response contains a brace", () => {
    const text =
      "Before\n```json\n" +
      '{"action":"respond","response":"a}b","reasoning":"ok"}\n' +
      "```\nAfter";
    expect(parseActionBlock(text)?.response).toBe("a}b");
    expect(stripActionBlockFromDisplay(text)).toBe("Before\n\nAfter");
  });

  it("prefers a fenced action over an earlier bare one", () => {
    const text =
      '{"action":"ignore","reasoning":"skip"}\n' +
      '```json\n{"action":"respond","response":"shown","reasoning":"ok"}\n```';
    expect(parseActionBlock(text)?.response).toBe("shown");
    expect(stripActionBlockFromDisplay(text)).toBe("");
  });

  it("parses a permission request and a key list that contains a brace", () => {
    const permission =
      '{"action":"permission_request","permission":"reminders","reason":"add } item","feature":"lifeops.reminders.create","fallback_offered":true,"fallback_label":"Use {internal}"}';
    const parsed = parseActionBlock(permission);
    expect(parsed?.permissionRequest).toEqual({
      permission: "reminders",
      reason: "add } item",
      feature: "lifeops.reminders.create",
      fallbackOffered: true,
      fallbackLabel: "Use {internal}",
    });

    const keys =
      '{"action":"respond","useKeys":true,"keys":["a}b"],"reasoning":"ok"}';
    expect(parseActionBlock(keys)?.keys).toEqual(["a}b"]);
  });

  it("does not promote a nested action from a rejected outer envelope", () => {
    for (const text of [
      '{"example":{"action":"respond","response":"nested","reasoning":"ok"}}',
      '{"action":"respond","response":"outer","extra":{"action":"ignore","reasoning":"nested"}}',
      '{"example":{"action":"permission_request","permission":"reminders","reason":"example","feature":"lifeops.reminders.create"}}',
    ]) {
      expect(parseActionBlock(text)).toBeNull();
      expect(stripActionBlockFromDisplay(text)).toBe(text);
    }
  });

  it("does not recover inner actions from an unfinished outer object", () => {
    const text = "{".repeat(1000) + '{"action":"respond","response":"nested"}';
    expect(parseActionBlock(text)).toBeNull();
    expect(stripActionBlockFromDisplay(text)).toBe(text);
  });

  it("leaves prose and non-action JSON in place", () => {
    expect(parseActionBlock("")).toBeNull();
    expect(parseActionBlock("hello {not json}")).toBeNull();
    const extra =
      'Note {"action":"respond","response":"hi","reasoning":"ok","extra":1} stays';
    expect(parseActionBlock(extra)).toBeNull();
    expect(stripActionBlockFromDisplay(extra)).toBe(extra);
  });
});
