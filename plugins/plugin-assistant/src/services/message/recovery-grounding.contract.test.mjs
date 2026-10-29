// Source-owning controlled output contracts; no provider calls.
// SDK root: node --test plugins/plugin-assistant/src/services/message/recovery-grounding.contract.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { runWithStreamingContext } from "@elizaos/core";
import { reviewRecoveredReply } from "./recovery-grounding.ts";

const api = { runWithStreamingContext, reviewRecoveredReply };
function fixture(output) {
  const calls = [],
    errors = [];
  return {
    calls,
    errors,
    runtime: {
      useModel: async (type, params) => {
        calls.push({ type, params });
        if (output instanceof Error) throw output;
        return output;
      },
      reportError: (scope, error) => errors.push({ scope, error }),
    },
  };
}
const args = (f) => ({
  runtime: f.runtime,
  reply: "Heading home.",
  evidenceJson: '{"synthetic":"prepared navigation evidence"}',
  effectReceiptIds: [],
  allowFullContextRequest: false,
});
test("review derives the existing shared output schema while keeping ordinary thinking off", async () => {
  const f = fixture('{"grounded":true,"claims":[]}');
  await api.reviewRecoveredReply(args(f));
  assert.ok(f.calls[0].params.responseSchema?.anyOf);
  assert.equal(f.calls[0].params.responseFormat, undefined);
  assert.equal(f.calls[0].params.providerOptions.eliza.thinking, "off");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.tools, undefined);
});
test("valid negative grounding verdict is returned and is not REVIEW_FAILED", async () => {
  const f = fixture(
    '{"grounded":false,"claims":[{"quote":"Heading home.","actor":"assistant","change":false,"supported":false,"evidence":""}]}',
  );
  const result = await api.reviewRecoveredReply(args(f));
  assert.equal(result.claims[0].supported, false);
  assert.equal(f.errors.length, 0);
  assert.equal(f.calls.length, 1);
});
test("provider failure retains its exact cause and emits REVIEW_FAILED without a retry", async () => {
  const cause = Object.assign(Error("Synthetic provider error"), {
    statusCode: 429,
    code: "SYNTHETIC",
  });
  const f = fixture(cause);
  await assert.rejects(
    api.reviewRecoveredReply(args(f)),
    (error) =>
      error.code === "REPLY_GROUNDING_REVIEW_FAILED" && error.cause === cause,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.errors[0].scope, "MessageService.replyRecoveryGrounding");
});
for (const [label, raw] of [
  ["malformed JSON", "{invalid"],
  [
    "invalid schema",
    '{"grounded":"no","completedChangeClaim":false,"reason":"x"}',
  ],
  ["forbidden full restoration", '{"contextRequest":"full"}'],
])
  test(`${label} follows REVIEW_FAILED and cannot authorize delivery`, async () => {
    const f = fixture(raw);
    await assert.rejects(
      api.reviewRecoveredReply(args(f)),
      (error) =>
        error.code === "REPLY_GROUNDING_REVIEW_FAILED" &&
        error.cause instanceof Error,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.errors.length, 1);
  });
test("full restoration request is accepted only when the existing caller explicitly permits it", async () => {
  const f = fixture('{"contextRequest":"full"}');
  assert.deepEqual(
    await api.reviewRecoveredReply({
      ...args(f),
      allowFullContextRequest: true,
    }),
    { contextRequest: "full" },
  );
  assert.equal(f.calls.length, 1);
});
for (const [label, raw, stage] of [
  ["provider", Object.assign(Error("Synthetic"), { statusCode: 429 }), "model"],
  ["malformed", "{invalid", "parse"],
  [
    "schema",
    '{"grounded":"no","completedChangeClaim":false,"reason":"x"}',
    "schema",
  ],
  ["full", '{"contextRequest":"full"}', "context_request"],
])
  test(`${label} failure reports only finite review-stage metadata while preserving failure`, async () => {
    const f = fixture(raw);
    await assert.rejects(api.reviewRecoveredReply(args(f)), (error) => {
      assert.equal(error.code, "REPLY_GROUNDING_REVIEW_FAILED");
      assert.equal(error.context.reviewStage, stage);
      assert.equal(
        error.context.providerStatus,
        label === "provider" ? 429 : undefined,
      );
      assert.deepEqual(
        Object.keys(error.context).sort(),
        label === "provider"
          ? ["providerStatus", "reviewStage"]
          : ["reviewStage"],
      );
      return true;
    });
    assert.equal(f.calls.length, 1);
  });
test("hostile provider status getter cannot alter original error or enter finite context", async () => {
  let reads = 0;
  const cause = Object.defineProperty(
    Error("Synthetic original"),
    "statusCode",
    {
      get() {
        reads++;
        throw Error("Getter forbidden");
      },
    },
  );
  const f = fixture(cause);
  await assert.rejects(
    api.reviewRecoveredReply(args(f)),
    (error) =>
      error.cause === cause &&
      error.context.reviewStage === "model" &&
      error.context.providerStatus === undefined,
  );
  assert.equal(reads, 0);
});

for (const raw of [
  '{"grounded":true,"claims":[{"quote":"","actor":"assistant","change":false,"supported":true,"evidence":""}]}',
  '{"grounded":true,"claims":[{"quote":"   ","actor":"assistant","change":false,"supported":true,"evidence":""}]}',
  '{"grounded":true,"claims":[],"extra":"forbidden"}',
])
  test("derived wire schema never weakens strict local verdict or reason validation", async () => {
    const f = fixture(raw);
    await assert.rejects(
      api.reviewRecoveredReply(args(f)),
      (error) =>
        error.code === "REPLY_GROUNDING_REVIEW_FAILED" &&
        error.context.reviewStage === "schema",
    );
    assert.equal(f.calls.length, 1);
  });

// The interop assertion is limited to this fixed derived schema.
test("fixed derived schema satisfies core object-valued properties contract", async () => {
  const f = fixture('{"grounded":true,"claims":[]}');
  await api.reviewRecoveredReply(args(f));
  const schema = f.calls[0].params.responseSchema;
  let propertyMaps = 0;
  function inspect(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) inspect(child);
      return;
    }
    if (Object.hasOwn(node, "properties")) {
      propertyMaps++;
      assert.ok(
        node.properties !== null &&
          typeof node.properties === "object" &&
          !Array.isArray(node.properties),
      );
      for (const property of Object.values(node.properties))
        assert.ok(
          property !== null &&
            typeof property === "object" &&
            !Array.isArray(property),
        );
    }
    for (const child of Object.values(node)) inspect(child);
  }
  inspect(schema);
  assert.equal(propertyMaps, 3);
  assert.deepEqual(
    schema.anyOf.map((branch) => Object.keys(branch.properties)),
    [["grounded", "claims"], ["contextRequest"]],
  );
});
