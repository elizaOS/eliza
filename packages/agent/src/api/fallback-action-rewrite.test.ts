/**
 * Voice-rewrite reading for fallback action results.
 *
 * When a planner-missed action runs through the fallback path, its result
 * text is rewritten in the character's voice by a TEXT_SMALL call that is
 * asked for strict JSON (`{"response":"..."}`). The reply used to be read
 * with a bare `JSON.parse`, so a reply that wraps the object in prose or
 * a markdown fence threw away the rewrite — and with it the action's
 * actual result (the ids, times and confirmations the rewrite prompt
 * says to preserve). The user instead got a content-free "I ran X and
 * got a result, but I couldn't format the details cleanly here."
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { rewriteFallbackActionText } from "./fallback-action-helpers.ts";

const RESULT_TEXT = "Reminder set for 2026-11-04 09:00 (id: abc-123).";
const VOICED = "Done — I'll remind you at 9:00 tomorrow (id abc-123).";
const GENERIC =
  "I ran REMIND and got a result, but I couldn't format the details cleanly here.";

function runtimeReturning(reply: string): AgentRuntime {
  return {
    character: { name: "Eliza" },
    useModel: async () => reply,
    logger: { debug: () => {} },
  } as unknown as AgentRuntime;
}

async function rewrite(reply: string): Promise<string> {
  return rewriteFallbackActionText({
    runtime: runtimeReturning(reply),
    actionName: "REMIND",
    text: RESULT_TEXT,
  });
}

describe("rewriteFallbackActionText reply reading", () => {
  it("uses the response from a strict JSON reply", async () => {
    await expect(rewrite(JSON.stringify({ response: VOICED }))).resolves.toBe(
      VOICED,
    );
  });

  it("uses the response from a fenced JSON reply", async () => {
    await expect(
      rewrite(
        ["```json", JSON.stringify({ response: VOICED }), "```"].join("\n"),
      ),
    ).resolves.toBe(VOICED);
  });

  it("uses the response from a reply with prose before the object", async () => {
    await expect(
      rewrite(`Here is the rewrite: ${JSON.stringify({ response: VOICED })}`),
    ).resolves.toBe(VOICED);
  });

  it("uses the fenced response when prose quotes a JSON payload first", async () => {
    await expect(
      rewrite(
        [
          'Result payload {"id":"abc-123","status":"scheduled"} — rewritten:',
          "```json",
          JSON.stringify({ response: VOICED }),
          "```",
        ].join("\n"),
      ),
    ).resolves.toBe(VOICED);
  });

  it("uses the fenced response when prose quotes a draft response first", async () => {
    await expect(
      rewrite(
        [
          "Here is a draft " +
            JSON.stringify({
              response: "I will ping you sometime (id DRAFT).",
            }) +
            " — rewritten:",
          "```json",
          JSON.stringify({ response: VOICED }),
          "```",
        ].join("\n"),
      ),
    ).resolves.toBe(VOICED);
  });

  it("uses the final fenced response when an earlier fence holds a draft", async () => {
    await expect(
      rewrite(
        [
          "Here is a draft " +
            JSON.stringify({
              response: "I'll ping you sometime (id DRAFT).",
            }) +
            " — rewritten:",
          "```json",
          JSON.stringify({
            response: "I'll ping you sometime (id DRAFT).",
          }),
          "```",
          "Final answer:",
          "```json",
          JSON.stringify({ response: VOICED }),
          "```",
        ].join("\n"),
      ),
    ).resolves.toBe(VOICED);
  });

  it("falls back when the reply holds no JSON object", async () => {
    await expect(rewrite("no json at all")).resolves.toBe(GENERIC);
  });

  it("falls back when the object has no response string", async () => {
    await expect(rewrite(JSON.stringify({ note: "x" }))).resolves.toBe(GENERIC);
  });
});
