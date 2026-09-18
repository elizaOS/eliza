/** Exercises strict evaluator admission with real fixture matching and adversarial request/receipt pairs. */

import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { DeterministicModelCall } from "./deterministic-model-plugin";
import { createDeterministicModelFixtureRegistry } from "./deterministic-model-plugin";
import { postToolEvaluatorFixture } from "./post-tool-evaluator-fixture";

function call(
  input = "Draw sunset",
  args = { prompt: "sunset" },
  success = true,
  receiptId = "call-1",
): DeterministicModelCall {
  return {
    modelType: ModelType.RESPONSE_HANDLER,
    latestUserText: '{"plannerCompleted":true,"turnScope":"final"}',
    toolNames: [],
    params: {
      messages: [
        {
          role: "system",
          content: "evaluator_stage:\ntask: Evaluate latest action",
        },
        {
          role: "user",
          content: `message:user:\n${JSON.stringify({ text: input, source: "client_chat", channelType: "DM" })}\n\nevent:message_handler:\ncurrent route`,
        },
        {
          role: "user",
          content: '{"plannerCompleted":true,"turnScope":"final"}',
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "DRAW",
              input: args,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: receiptId,
              toolName: "DRAW",
              output: { type: "text", value: JSON.stringify({ success }) },
            },
          ],
        },
      ],
    },
  };
}

function registry() {
  return createDeterministicModelFixtureRegistry([
    postToolEvaluatorFixture({
      actionName: "DRAW",
      args: { prompt: "sunset" },
      input: "Draw sunset",
    }),
  ]);
}

describe("post-tool evaluator fixture", () => {
  it("evaluates the original request despite trailing planner metadata", () => {
    const fixtures = registry();
    expect(fixtures.resolve(call()).rawResponse).toMatchObject({
      success: true,
      decision: "FINISH",
    });
    fixtures.assertConsumed();
  });
  it("preserves the action-owned reply and binds only committed proof", () => {
    const candidate = call();
    const message = candidate.params.messages?.find(
      (message) => message.role === "tool",
    );
    if (!message || !Array.isArray(message.content))
      throw new Error("Missing tool result");
    const part = message.content[0];
    if (part.type !== "tool-result")
      throw new Error("Missing tool result part");
    const base = {
      operation: "image.create",
      resource: { kind: "image", id: "sunset" },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: "2026-09-15T12:00:00.000Z",
    };
    part.output = {
      type: "text",
      value: JSON.stringify({
        success: true,
        verifiedUserFacing: true,
        userFacingText: "Your sunset image is ready.",
        effectReceipts: [
          {
            ...base,
            receiptId: "created-image",
            outcome: "applied",
            commit: {
              kind: "durable",
              id: "image-write",
              committedAt: base.observedAt,
            },
          },
          { ...base, receiptId: "preview-image", outcome: "preview" },
        ],
      }),
    };
    const fixtures = createDeterministicModelFixtureRegistry([
      postToolEvaluatorFixture({
        actionName: "DRAW",
        args: { prompt: "sunset" },
        input: "Draw sunset",
        messageToUser: "Drawing the image.",
      }),
    ]);
    expect(fixtures.resolve(candidate).rawResponse).toMatchObject({
      messageToUser: "Your sunset image is ready.",
      effectReceiptIds: ["created-image"],
    });
    fixtures.assertConsumed();
  });

  it.each([
    ["another request", () => call("Draw sunrise")],
    ["wrong arguments", () => call("Draw sunset", { prompt: "sunrise" })],
    ["failed action", () => call("Draw sunset", { prompt: "sunset" }, false)],
    [
      "unrelated receipt",
      () => call("Draw sunset", { prompt: "sunset" }, true, "other-call"),
    ],
  ])("rejects %s", (_name, candidate) => {
    expect(() => registry().resolve(candidate())).toThrow(/no fixture matched/);
  });
  it.each([
    '{"text":"",',
    '{"text":"","text":"","source":"client_chat","channelType":"DM"}',
  ])(
    "rejects invalid envelopes even for an empty declared input: %s",
    (envelope) => {
      const candidate = call("");
      const message = candidate.params.messages?.[1];
      if (!message) throw new Error("Missing fixture input message");
      message.content = `message:user:\n${envelope}`;
      const fixtures = createDeterministicModelFixtureRegistry([
        postToolEvaluatorFixture({
          actionName: "DRAW",
          args: { prompt: "sunset" },
          input: "",
        }),
      ]);
      expect(() => fixtures.resolve(candidate)).toThrow(/no fixture matched/);
    },
  );

  it.each([
    null,
    "unstructured receipt",
    { type: "json", value: { success: true } },
    { type: "text", value: 42 },
  ])(
    "rejects non-text tool outputs at matching and response boundaries: %j",
    (output) => {
      const candidate = call();
      const message = candidate.params.messages?.find(
        (message) => message.role === "tool",
      );
      if (!message || !Array.isArray(message.content))
        throw new Error("Missing tool result");
      const part = message.content[0];
      if (part.type !== "tool-result")
        throw new Error("Missing tool result part");
      part.output = output;
      expect(() => registry().resolve(candidate)).toThrow(/no fixture matched/);
      const fixture = postToolEvaluatorFixture({
        actionName: "DRAW",
        args: { prompt: "sunset" },
        input: "Draw sunset",
      });
      const respond = fixture.response;
      if (typeof respond !== "function")
        throw new Error("Missing response handler");
      expect(() => respond(candidate)).toThrow(
        "Matched tool receipt is missing",
      );
    },
  );

  it("does not treat routing as post-tool evaluation", () => {
    const candidate = call();
    candidate.toolNames = ["HANDLE_RESPONSE"];
    expect(() => registry().resolve(candidate)).toThrow(/no fixture matched/);
  });
});
