// SDK root: node --import=tsx --conditions=eliza-source --test plugins/plugin-assistant/src/services/message/recovery-grounding.native-wire.test.mjs
// fetch is replaced in every case; no paid or real HTTP request is permitted.
// No-network wire check: actual plugin-elizacloud TEXT_SMALL handler + SDK request serialization.
import assert from "node:assert/strict";
import test from "node:test";
import { handleTextSmall } from "../../../../plugin-elizacloud/src/models/text.ts";
import { reviewRecoveredReply } from "./recovery-grounding.ts";

function fixture(model = "qwen-3.8-27b", canonical = true) {
  const settings = {
    ELIZAOS_CLOUD_API_KEY: "synthetic-no-network-key",
    ELIZAOS_CLOUD_BASE_URL: canonical
      ? "https://api.eliza.app/api/v1"
      : "https://synthetic.invalid/api/v1",
    ELIZAOS_CLOUD_SMALL_MODEL: model,
    ELIZAOS_CLOUD_APPLICATION_SLOT: "alphaphone",
  };
  const calls = [];
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Wire fixture", bio: [], settings: {} },
    getSetting: (key) => settings[key] ?? null,
    getModel: (type) => (type === "TEXT_SMALL" ? handleTextSmall : undefined),
    emitEvent: async () => {},
    getService: () => null,
    reportError() {},
    useModel: async (type, params) => {
      assert.equal(type, "TEXT_SMALL");
      calls.push(params);
      return handleTextSmall(runtime, params);
    },
  };
  return { runtime, calls };
}
async function capture(work) {
  const requests = [],
    previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url: String(url), body });
    if (!String(url).includes("chat/completions"))
      throw Error("Unexpected mocked route; no network fallback");
    return Response.json({
      id: "synthetic-response",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify(
              body.response_format?.json_schema?.schema?.properties
                ?.__eliza_response
                ? {
                    __eliza_response: {
                      grounded: true,
                      claims: [],
                    },
                  }
                : {
                    grounded: true,
                    claims: [],
                  },
            ),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
  };
  try {
    const result = await work();
    return { result, requests };
  } finally {
    globalThis.fetch = previous;
  }
}
test("legacy top-level responseFormat is ignored by actual native Cloud adapter", async () => {
  const f = fixture();
  const r = await capture(() =>
    handleTextSmall(f.runtime, {
      prompt: "Return JSON only.",
      responseFormat: { type: "json_object" },
      providerOptions: { eliza: { thinking: "off" } },
    }),
  );
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].body.response_format, undefined);
  assert.equal(r.requests[0].body.reasoning_effort, "none");
});
for (const [model, canonical, expected] of [
  ["qwen-3.8-27b", true, "json_object"],
  ["gemma-4-31b", true, undefined],
  ["zai-glm-4.7", true, undefined],
  ["qwen-3.8-27b", false, undefined],
])
  test(`derived verdict schema reaches actual Cloud wire for ${model}, canonical=${canonical}`, async () => {
    const f = fixture(model, canonical);
    const r = await capture(() =>
      reviewRecoveredReply({
        runtime: f.runtime,
        reply: "Heading home.",
        evidenceJson: '{"synthetic":"prepared navigation"}',
        effectReceiptIds: [],
        allowFullContextRequest: false,
      }),
    );
    assert.deepEqual(r.result.claims, []);
    assert.equal(r.requests.length, 1);
    const body = r.requests[0].body;
    assert.equal(body.response_format?.type, expected);
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.tools, undefined);
    assert.ok(
      f.calls[0].responseSchema,
      "Actual review must request existing shared responseSchema contract",
    );
    assert.equal(f.calls[0].responseFormat, undefined);
    const system = body.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    assert.ok(system.includes("Response JSON schema:"));
    assert.ok(system.includes(JSON.stringify(f.calls[0].responseSchema)));
  });
test("the same derived verdict schema also reaches the direct OpenAI/Cerebras handler wire", async () => {
  const { handleTextSmall: direct, __INTERNAL_sanitizeJsonSchema: sanitize } =
    await import("../../../../plugin-openai/models/text.ts");
  const f = fixture();
  const settings = {
    OPENAI_API_KEY: "synthetic-direct-key",
    OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    CEREBRAS_API_KEY: "synthetic-direct-key",
    CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1",
    CEREBRAS_SMALL_MODEL: "qwen-3.8-27b",
    OPENAI_SMALL_MODEL: "qwen-3.8-27b",
    ELIZA_BRAIN_PROVIDER: "cerebras",
  };
  const original = f.runtime.getSetting;
  f.runtime.getSetting = (key) => settings[key] ?? original(key);
  f.runtime.useModel = async (type, params) => {
    f.calls.push(params);
    return direct(f.runtime, params);
  };
  const r = await capture(() =>
    reviewRecoveredReply({
      runtime: f.runtime,
      reply: "Heading home.",
      evidenceJson: '{"synthetic":"prepared navigation"}',
      effectReceiptIds: [],
      allowFullContextRequest: false,
    }),
  );
  assert.deepEqual(r.result.claims, []);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].body.response_format.type, "json_schema");
  assert.ok(r.requests[0].body.response_format.json_schema.schema);
  assert.equal(r.requests[0].body.response_format.json_schema.strict, true);
  assert.deepEqual(
    r.requests[0].body.response_format.json_schema.schema.properties
      .__eliza_response.anyOf,
    sanitize(f.calls[0].responseSchema, true, "$", undefined, {
      preserveStructure: true,
    }).anyOf,
  );
  assert.ok(f.calls[0].responseSchema.anyOf);
  assert.equal(f.calls[0].providerOptions.eliza.thinking, "off");
});
