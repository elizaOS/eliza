/**
 * Deterministic unit coverage for `parseActionBlock` and
 * `stripActionBlockFromDisplay`: parsing fenced and bare action JSON (respond,
 * ignore, permission_request), rejecting unknown/malformed/mixed blocks and
 * unknown permission ids, and stripping the action block from user-visible
 * display text.
 */
import { describe, expect, it } from "vitest";
import {
  parseActionBlock,
  stripActionBlockFromDisplay,
} from "./parse-action-block";

describe("parseActionBlock", () => {
  it("parses respond with text", () => {
    const result = parseActionBlock(
      'Sure thing.\n```json\n{"action":"respond","reasoning":"acknowledge","response":"hi"}\n```',
    );
    expect(result?.action).toBe("respond");
    expect(result?.response).toBe("hi");
  });

  it("parses bare-JSON ignore action", () => {
    const result = parseActionBlock(
      'Working on it. {"action":"ignore","reasoning":"already handled"}',
    );
    expect(result?.action).toBe("ignore");
  });

  it("parses permission_request with all fields", () => {
    const text =
      'I would like to add that.\n```json\n{"action":"permission_request","reasoning":"need apple reminders","permission":"reminders","reason":"Add \'pick up groceries\' to your Apple Reminders.","feature":"lifeops.reminders.create","fallback_offered":true,"fallback_label":"Use internal reminders instead"}\n```';
    const result = parseActionBlock(text);
    expect(result?.action).toBe("permission_request");
    expect(result?.permissionRequest).toBeDefined();
    expect(result?.permissionRequest?.permission).toBe("reminders");
    expect(result?.permissionRequest?.feature).toBe("lifeops.reminders.create");
    expect(result?.permissionRequest?.fallbackOffered).toBe(true);
    expect(result?.permissionRequest?.fallbackLabel).toBe(
      "Use internal reminders instead",
    );
  });

  it("parses permission_request without optional fallback fields", () => {
    const text =
      '```json\n{"action":"permission_request","reasoning":"camera needed","permission":"camera","reason":"I need camera access to take a photo.","feature":"camsnap.capture.take"}\n```';
    const result = parseActionBlock(text);
    expect(result?.action).toBe("permission_request");
    expect(result?.permissionRequest?.fallbackOffered).toBe(false);
    expect(result?.permissionRequest?.fallbackLabel).toBeUndefined();
  });

  it("rejects permission_request with unknown permission id", () => {
    const text =
      '```json\n{"action":"permission_request","reasoning":"x","permission":"telepathy","reason":"y","feature":"a.b.c"}\n```';
    expect(parseActionBlock(text)).toBeNull();
  });

  it("rejects permission_request missing reason", () => {
    const text =
      '```json\n{"action":"permission_request","reasoning":"x","permission":"reminders","feature":"a.b.c"}\n```';
    expect(parseActionBlock(text)).toBeNull();
  });

  it("rejects permission_request missing feature", () => {
    const text =
      '```json\n{"action":"permission_request","reasoning":"x","permission":"reminders","reason":"y"}\n```';
    expect(parseActionBlock(text)).toBeNull();
  });

  it("rejects permission_request with empty reason string", () => {
    const text =
      '```json\n{"action":"permission_request","reasoning":"x","permission":"reminders","reason":"","feature":"a.b.c"}\n```';
    expect(parseActionBlock(text)).toBeNull();
  });

  it("rejects unknown action", () => {
    const text = '```json\n{"action":"explode","reasoning":"x"}\n```';
    expect(parseActionBlock(text)).toBeNull();
  });

  it("rejects respond mixing in permission_request fields", () => {
    const text =
      '```json\n{"action":"respond","reasoning":"x","response":"hi","permission":"reminders"}\n```';
    expect(parseActionBlock(text)).toBeNull();
  });

  it("parses escalate and complete actions", () => {
    const escalateResult = parseActionBlock(
      'Need help.\n```json\n{"action":"escalate","reasoning":"requires human operator"}\n```',
    );
    expect(escalateResult?.action).toBe("escalate");
    expect(escalateResult?.reasoning).toBe("requires human operator");

    const completeResult = parseActionBlock(
      'All done.\n{"action":"complete","reasoning":"task finished"}',
    );
    expect(completeResult?.action).toBe("complete");
    expect(completeResult?.reasoning).toBe("task finished");
  });

  it("parses respond with useKeys array", () => {
    const result = parseActionBlock(
      'Pressing shortcut.\n```json\n{"action":"respond","reasoning":"send keystroke","useKeys":true,"keys":["Enter","Escape"]}\n```',
    );
    expect(result?.action).toBe("respond");
    expect(result?.useKeys).toBe(true);
    expect(result?.keys).toEqual(["Enter", "Escape"]);
  });

  it("rejects respond with empty keys array and no response text", () => {
    const result = parseActionBlock(
      '```json\n{"action":"respond","reasoning":"no keys","useKeys":true,"keys":[]}\n```',
    );
    expect(result).toBeNull();
  });
});

describe("stripActionBlockFromDisplay", () => {
  it("strips a fenced permission_request block", () => {
    const text =
      "Here is the result.\n```json\n" +
      '{"action":"permission_request","reasoning":"x","permission":"camera","reason":"y","feature":"a.b.c"}' +
      "\n```";
    expect(stripActionBlockFromDisplay(text)).toBe("Here is the result.");
  });

  it("strips a fenced respond block", () => {
    const text =
      "Here is the message.\n```json\n" +
      '{"action":"respond","reasoning":"test","response":"hi"}' +
      "\n```";
    expect(stripActionBlockFromDisplay(text)).toBe("Here is the message.");
  });

  it("strips a bare permission_request block", () => {
    const text =
      'Adding that. {"action":"permission_request","reasoning":"x","permission":"calendar","reason":"y","feature":"a.b.c"}';
    expect(stripActionBlockFromDisplay(text)).toBe("Adding that.");
  });

  it("leaves text without action blocks unchanged", () => {
    expect(stripActionBlockFromDisplay("just plain text")).toBe(
      "just plain text",
    );
  });

  it("leaves text with unknown action block unchanged", () => {
    const text =
      'Look at this: ```json\n{"action":"custom_external","data":123}\n```';
    expect(stripActionBlockFromDisplay(text)).toBe(text);
  });
});
