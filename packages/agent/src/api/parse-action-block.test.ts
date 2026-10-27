import { describe, expect, test } from "bun:test";
import {
  parseActionBlock,
  stripActionBlockFromDisplay,
} from "./parse-action-block";

const strict =
  '```json\n{"action":"respond","response":"Deploy finished.","reasoning":"r"}\n```';
const extraKey =
  '```json\n{"action":"respond","response":"Deploy finished.","reasoning":"secret","confidence":0.92}\n```';

describe("action envelope display and routing", () => {
  test("a strict envelope is stripped from the display and routed", () => {
    const text = `Routing this now.\n${strict}`;
    expect(stripActionBlockFromDisplay(text)).toBe("Routing this now.");
    expect(parseActionBlock(text)?.action).toBe("respond");
  });

  test("an envelope with an extra key is stripped but not routed", () => {
    const text = `Routing this now.\n${extraKey}`;
    const shown = stripActionBlockFromDisplay(text);
    expect(shown).toBe("Routing this now.");
    expect(shown).not.toContain("secret");
    expect(parseActionBlock(text)).toBeNull();
  });

  test("a display-only envelope does not hide a later strict envelope", () => {
    const text = `${extraKey}\nNext.\n${strict}`;
    expect(stripActionBlockFromDisplay(text)).toBe("Next.");
    expect(parseActionBlock(text)?.action).toBe("respond");
  });
});
