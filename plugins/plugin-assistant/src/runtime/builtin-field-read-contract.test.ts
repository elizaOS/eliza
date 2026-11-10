import { ResponseHandlerFieldRegistry } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { requiredFixtureValue } from "../../test/required-fixture-value.ts";
import { ACKNOWLEDGMENT_RULE } from "../prompts/acknowledgment";
import { messageHandlerTemplate } from "../services/message/prompts";
import {
  contextsFieldEvaluator,
  intentsFieldEvaluator,
  replyEffectStatusFieldEvaluator,
  replyTextFieldEvaluator,
} from "./builtin-field-evaluators";

const fields = [
  contextsFieldEvaluator,
  intentsFieldEvaluator,
  replyTextFieldEvaluator,
  replyEffectStatusFieldEvaluator,
];
const registry = new ResponseHandlerFieldRegistry();
for (const field of fields) registry.register(field);
const context = {
  runtime: { agentId: "agent" },
  message: {
    id: "message",
    entityId: "owner",
    roomId: "room",
    content: {
      text: "See if I have any notes and anything on my calendar today.",
    },
  },
  state: { values: {}, data: {}, text: "" },
  senderRole: "OWNER",
  turnSignal: new AbortController().signal,
} as Parameters<typeof registry.dispatch>[0];
describe("Stage1 fresh-read contract", () => {
  it("puts pending fresh reads, absence checks and separate outcomes on the native schema", () => {
    const schema = registry.composeSchema();
    expect(Object.keys(requiredFixtureValue(schema.properties))).toEqual([
      "contexts",
      "intents",
      "replyEffectStatus",
      "replyText",
    ]);
    expect(
      requiredFixtureValue(schema.properties).intents.description,
    ).toContain("no stored records exist");
    expect(
      requiredFixtureValue(schema.properties).intents.description,
    ).toContain("Notes and Calendar checks are separate outcomes");
    expect(
      requiredFixtureValue(schema.properties).replyEffectStatus.description,
    ).toContain("Read-only does not mean none");
    expect(
      requiredFixtureValue(schema.properties).replyEffectStatus.description,
    ).toContain("retrieving stored history is pending");
  });
  it("retains the same guidance in legacy and compressed field prompts", async () => {
    const prompt = await registry.composePromptSlices(context);
    expect(prompt.rendered).toContain("Read-only does not mean none");
    expect(prompt.rendered).toContain("do not paraphrase the user's request");
    expect(intentsFieldEvaluator.descriptionCompressed).toContain("fresh read");
    expect(replyEffectStatusFieldEvaluator.descriptionCompressed).toContain(
      "fresh reads",
    );
    expect(replyTextFieldEvaluator.descriptionCompressed).toContain(
      "do not paraphrase the user's request",
    );
    expect(
      replyTextFieldEvaluator.schema.description?.startsWith(
        ACKNOWLEDGMENT_RULE,
      ),
    ).toBe(true);
  });
  it("retains compound read intents and pending through the actual registry", async () => {
    const rawParsed = {
      contexts: ["notes", "calendar"],
      intents: ["Read saved notes", "Read today's calendar"],
      replyEffectStatus: "pending",
      replyText: "Let me check.",
    };
    const result = await registry.dispatch({ ...context, rawParsed });
    expect(result.parsed.intents).toEqual(rawParsed.intents);
    expect(result.parsed.replyEffectStatus).toBe("pending");
    expect(result.parsed.replyText).toBe(rawParsed.replyText);
  });
  it("keeps simple and non-applied statuses without fabricating work", () => {
    for (const status of ["none", "non_applied", "pending", "applied"])
      expect(
        requiredFixtureValue(replyEffectStatusFieldEvaluator.parse)(
          status,
          context,
        ),
      ).toBe(status);
    expect(
      requiredFixtureValue(intentsFieldEvaluator.parse)([], context),
    ).toEqual([]);
  });
  it("preserves a requested exact quotation of first-person text", () => {
    const text = "You said: “I want to see my calendar.”";
    expect(
      requiredFixtureValue(replyTextFieldEvaluator.parse)(text, context),
    ).toBe(text);
  });
  it("does not pretend guidance is a classifier or manufacture a canned acknowledgement", async () => {
    const rawParsed = {
      contexts: ["simple"],
      intents: [],
      replyEffectStatus: "none",
      replyText:
        "I want to see if I have any saved notes, and double-check nothing is actually on the calendar today.",
    };
    const result = await registry.dispatch({ ...context, rawParsed });
    expect(result.parsed.intents).toEqual([]);
    expect(result.parsed.replyText).toBe(rawParsed.replyText);
  });
  it("instructs fresh absence checks in the shared task without a hard-coded tool list", () => {
    expect(messageHandlerTemplate).toContain(
      "verifying that nothing exists, is pending execution even without a write",
    );
    expect(messageHandlerTemplate).toContain(
      "Preserve independent requested checks as independent intents",
    );
    expect(messageHandlerTemplate).not.toMatch(/CALENDAR_FEED|NOTES_LIST/);
  });
});
