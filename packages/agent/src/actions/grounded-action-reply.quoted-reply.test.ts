/**
 * The grounded reply path rejects model output that "looks structured" and
 * falls back to the canonical text. A model reply wrapped in quotation marks
 * is prose, not structure — and normalizeReplyText exists precisely to strip
 * those quotes — but it parsed as a JSON string, so the guard discarded it and
 * the user got boilerplate instead of the grounded answer.
 *
 * These cases pin the guard at its real call site: quoted prose is delivered
 * (normalized), while genuinely structured output still falls back.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { renderGroundedActionReply } from "./grounded-action-reply.ts";

const FALLBACK = "I've handled that.";

function runtimeReturning(modelOutput: string): IAgentRuntime {
  return {
    useModel: vi.fn(async () => modelOutput),
    getMemories: vi.fn(async () => []),
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;
}

async function render(modelOutput: string): Promise<string> {
  return renderGroundedActionReply({
    runtime: runtimeReturning(modelOutput),
    message: { content: { text: "add milk" } } as unknown as Memory,
    state: undefined as unknown as State | undefined,
    intent: "confirm",
    domain: "lifeops",
    scenario: "test",
    fallback: FALLBACK,
  });
}

describe("renderGroundedActionReply — quoted prose is not structured output", () => {
  it("delivers a double-quoted prose reply, stripped of its quotes", async () => {
    const out = await render('"Sure — I added milk to your shopping list."');
    expect(out).toBe("Sure — I added milk to your shopping list.");
    expect(out).not.toBe(FALLBACK);
  });

  it("delivers a single-quoted prose reply", async () => {
    const out = await render("'Added milk.'");
    expect(out).toBe("Added milk.");
  });

  it("delivers an unquoted prose reply unchanged", async () => {
    const out = await render("Added milk to your list.");
    expect(out).toBe("Added milk to your list.");
  });

  it("still falls back for a real JSON object reply", async () => {
    const out = await render('{"response": "Added milk", "confidence": 0.9}');
    expect(out).toBe(FALLBACK);
  });

  it("still falls back for a fenced JSON object reply", async () => {
    const out = await render('```json\n{"response": "Added milk"}\n```');
    expect(out).toBe(FALLBACK);
  });

  it("still falls back for schema-key output and XML-ish output", async () => {
    expect(await render("shouldAct: true\nresponse: Added milk")).toBe(
      FALLBACK,
    );
    expect(await render("<thinking>should I</thinking>")).toBe(FALLBACK);
  });

  it("still falls back for an empty reply", async () => {
    expect(await render("   ")).toBe(FALLBACK);
  });
});
