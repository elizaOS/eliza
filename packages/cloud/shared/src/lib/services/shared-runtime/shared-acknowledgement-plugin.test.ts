import assert from "node:assert/strict";
import { test } from "node:test";
import { IMESSAGE_CLASSIC_REACTIONS } from "@elizaos/contracts/imessage-reaction";
import { AgentRuntime, createMessageMemory, stringToUuid } from "@elizaos/core";
import { shouldRespondFieldEvaluator } from "@elizaos/plugin-assistant";
import { createSharedAcknowledgementPlugin } from "./shared-acknowledgement-plugin.ts";

const accepted = [...IMESSAGE_CLASSIC_REACTIONS, "😀", "❤️", "👍🏽", "👩🏽‍💻", "🇯🇵", "1️⃣"];
test("existing response-handler evaluator selects each supported reaction without extra work", () => {
  for (const value of accepted) {
    let choice: string | undefined;
    const plugin = createSharedAcknowledgementPlugin((selected) => {
      choice = selected;
    });
    const evaluator = plugin.responseHandlerFieldEvaluators?.[0];
    assert.ok(evaluator);
    assert.equal(evaluator.parse(value), value);
    assert.ok(evaluator);
    evaluator.handle({
      value,
      parsed: {
        contexts: [],
        replyText: "",
        facts: [],
        relationships: [],
        addressedTo: [],
        shouldRespond: "IGNORE",
        intents: [],
        candidateActionNames: [],
      },
      turnSignal: new AbortController().signal,
    } as never);
    assert.equal(choice, value);
  }
});

test("reply/work/abort and malformed choices never produce a reaction", () => {
  for (const variant of [
    {
      shouldRespond: "IGNORE",
      replyText: "A text reply",
      intents: [],
      candidateActionNames: [],
    },
    { shouldRespond: "RESPOND", intents: [], candidateActionNames: [] },
    { shouldRespond: "STOP", intents: [], candidateActionNames: [] },
    {
      shouldRespond: "IGNORE",
      intents: ["answer pending question"],
      candidateActionNames: [],
    },
    {
      shouldRespond: "IGNORE",
      intents: [],
      candidateActionNames: ["WEB_SEARCH"],
    },
  ]) {
    let choice: string | undefined = "like";
    const evaluator = createSharedAcknowledgementPlugin((selected) => {
      choice = selected;
    }).responseHandlerFieldEvaluators?.[0];
    assert.ok(evaluator);
    evaluator.handle({
      value: "❤️",
      parsed: {
        contexts: [],
        replyText: "",
        facts: [],
        relationships: [],
        addressedTo: [],
        ...variant,
      },
      turnSignal: new AbortController().signal,
    } as never);
    assert.equal(choice, undefined);
  }
  for (const value of [undefined, null, "none", "+like", "😀😀", "text"]) {
    let choice: string | undefined = "like";
    const evaluator = createSharedAcknowledgementPlugin((selected) => {
      choice = selected;
    }).responseHandlerFieldEvaluators?.[0];
    const aborted = new AbortController();
    aborted.abort();
    assert.ok(evaluator);
    evaluator.handle({
      value,
      parsed: {
        contexts: [],
        replyText: "",
        facts: [],
        relationships: [],
        addressedTo: [],
        shouldRespond: "IGNORE",
        intents: [],
        candidateActionNames: [],
      },
      turnSignal: aborted.signal,
    } as never);
    assert.equal(choice, undefined);
    assert.ok(evaluator);
    assert.equal(evaluator.parse(value), "none");
  }
});

test("the canonical Core field registry handles the acknowledgement after IGNORE and clears it for STOP", async () => {
  const runtime = new AgentRuntime({
    agentId: stringToUuid("ack-registry-agent"),
    character: { name: "Ack registry test", bio: [] },
    plugins: [],
  });
  let choice: string | undefined;
  runtime.registerResponseHandlerFieldEvaluator(shouldRespondFieldEvaluator);
  const evaluator = createSharedAcknowledgementPlugin((selected) => {
    choice = selected;
  }).responseHandlerFieldEvaluators?.[0];
  assert.ok(evaluator);
  runtime.registerResponseHandlerFieldEvaluator(evaluator);
  const message = createMessageMemory({
    id: stringToUuid("ack-registry-message"),
    agentId: runtime.agentId,
    entityId: stringToUuid("ack-registry-user"),
    roomId: stringToUuid("ack-registry-room"),
    content: { text: "Thanks", source: "blooio", channelType: "DM" },
  });
  for (const shouldRespond of ["IGNORE", "STOP"] as const) {
    const result = await runtime.responseHandlerFieldRegistry.dispatch({
      rawParsed: {
        shouldRespond,
        replyText: "",
        intents: [],
        candidateActionNames: [],
        contexts: [],
        facts: [],
        relationships: [],
        addressedTo: [],
        acknowledgementReaction: "🎉",
      },
      runtime,
      message,
      state: { values: {}, data: {}, text: "" } as never,
      senderRole: "USER",
      turnSignal: new AbortController().signal,
    });
    assert.equal(choice, shouldRespond === "IGNORE" ? "🎉" : undefined);
    assert.ok(
      result.traces.find((trace) => trace.fieldName === "acknowledgementReaction")?.handled,
    );
    assert.equal(result.preempt, undefined);
  }
});
