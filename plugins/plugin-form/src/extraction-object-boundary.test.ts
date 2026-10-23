/**
 * The model reply is untrusted text. A provider can return the answer object
 * with a line of narration before or after it, and that narration can contain
 * a brace: "I read it into the {dueDate} slot". The extracted object must come
 * from the string-aware object span, not from the first and last brace in the
 * whole reply, or a valid answer is dropped and the person is asked again.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { detectCorrection, extractSingleField } from "./extraction";
import type { FormControl } from "./types";

const dueDate: FormControl = {
  key: "dueDate",
  label: "Due date",
  type: "text",
  required: false,
};

const email: FormControl = {
  key: "email",
  label: "Email",
  type: "email",
  required: false,
};

/** A runtime whose model returns one recorded reply string. */
function runtimeReplying(reply: string): IAgentRuntime {
  return {
    useModel: async () => reply,
    getService: () => null,
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  } as unknown as IAgentRuntime;
}

describe("model reply object boundary", () => {
  it("keeps a field answer that narration with a brace follows", async () => {
    const reply = [
      '{"found": true, "value": "Friday", "confidence": 0.92, "reasoning": "The person named a weekday."}',
      "I put it in the {dueDate} slot.",
    ].join("\n");

    const result = await extractSingleField(
      runtimeReplying(reply),
      "make it Friday",
      dueDate,
    );

    expect(result?.value).toBe("Friday");
    expect(result?.confidence).toBeCloseTo(0.92);
  });

  it("does not read a brace inside the answer text as the object end", async () => {
    const reply =
      '{"found": true, "value": "use {name} in the body", "confidence": 0.7} The end } here.';

    const result = await extractSingleField(
      runtimeReplying(reply),
      "put the placeholder in",
      dueDate,
    );

    expect(result?.value).toBe("use {name} in the body");
  });

  it("keeps a correction that a trailing brace narration follows", async () => {
    const reply = [
      '{"has_correction": true, "corrections": [{"field": "Email", "old_value": "a@b.com", "new_value": "new@example.com", "confidence": 0.9}]}',
      "The reply used the {corrections} array.",
    ].join("\n");

    const corrections = await detectCorrection(
      runtimeReplying(reply),
      "no, it is new@example.com",
      { email: "a@b.com" },
      [email],
    );

    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.field).toBe("email");
    expect(corrections[0]?.value).toBe("new@example.com");
  });

  it("still reports no answer when the reply holds no object", async () => {
    const result = await extractSingleField(
      runtimeReplying("I could not find a due date."),
      "sometime soon",
      dueDate,
    );

    expect(result).toBeNull();
  });
});
