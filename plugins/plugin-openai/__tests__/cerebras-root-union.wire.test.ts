import { type IAgentRuntime, runWithTrajectoryContext } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { reviewRecoveredReply } from "../../plugin-assistant/src/services/message/recovery-grounding.ts";
import { handleTextSmall } from "../models/text.ts";

afterEach(() => vi.unstubAllGlobals());
async function capturedSchema() {
  let schema: unknown;
  await reviewRecoveredReply({
    runtime: {
      useModel: async (_type: unknown, params: { responseSchema: unknown }) => {
        schema = params.responseSchema;
        return JSON.stringify({
          grounded: true,
          claims: [],
        });
      },
      reportError: () => {},
    } as unknown as IAgentRuntime,
    reply: "Opening Notes.",
    evidenceJson: "{}",
    effectReceiptIds: [],
    allowFullContextRequest: true,
  });
  return schema;
}
function runtime() {
  return createSQLiteTestRuntime({
    character: {
      name: "RootUnionWire",
      bio: ["Fixture"],
      settings: {
        ELIZA_PROVIDER: "cerebras",
        OPENAI_API_KEY: "fixture-key",
        CEREBRAS_API_KEY: "fixture-key",
        OPENAI_BASE_URL: "https://provider.invalid/v1",
        CEREBRAS_BASE_URL: "https://provider.invalid/v1",
        OPENAI_SMALL_MODEL: "qwen-3.8-27b",
        CEREBRAS_SMALL_MODEL: "qwen-3.8-27b",
      },
    },
    logLevel: "fatal",
  });
}
function transport(value: unknown, bodies: any[], wrapped = true) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://provider.invalid/")) throw Error("External request forbidden");
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.response_format?.json_schema?.schema.anyOf)
      return new Response(
        JSON.stringify({
          error: {
            message: "Extra top level keys found in JSON schema: {'anyOf'}.",
            type: "invalid_request_error",
            param: "response_format",
            code: "wrong_api_format",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    const content = JSON.stringify(wrapped ? { __eliza_response: value } : value);
    const event = {
      id: "fixture",
      object: body.stream ? "chat.completion.chunk" : "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          ...(body.stream ? { delta: { content } } : { message: { role: "assistant", content } }),
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
    };
    return new Response(
      body.stream ? `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n` : JSON.stringify(event),
      {
        headers: {
          "content-type": body.stream ? "text/event-stream" : "application/json",
        },
      }
    );
  });
}
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string")
    return value.text;
  throw Error("Missing text");
}

it.each([false, true])(
  "roundtrips the actual recovered-reply union without leaking wrapper (stream=%s)",
  async (stream) => {
    const schema = await capturedSchema();
    const before = JSON.stringify(schema);
    expect((schema as any).anyOf).toHaveLength(2);
    for (const value of [
      {
        grounded: true,
        claims: [],
      },
      { contextRequest: "full" },
    ]) {
      const bodies: any[] = [];
      transport(value, bodies);
      const r = runtime();
      const chunks: string[] = [];
      const result = await runWithTrajectoryContext({ trajectoryStepId: "union-wire" }, () =>
        handleTextSmall(r, {
          prompt: "Return the supplied schema.",
          responseSchema: schema,
          stream,
          onStreamChunk: (x: string) => chunks.push(x),
        } as never)
      );
      const text = stream ? await (result as any).text : textOf(result);
      if (stream)
        for await (const _ of (result as any).textStream) {
        }
      expect(JSON.parse(text)).toEqual(value);
      expect(text).not.toContain("__eliza_response");
      expect(JSON.stringify(chunks)).not.toContain("__eliza_response");
      expect(bodies).toHaveLength(1);
      const wire = bodies[0].response_format.json_schema.schema;
      expect(wire.type).toBe("object");
      expect(wire).not.toHaveProperty("anyOf");
      expect(wire.properties.__eliza_response.anyOf).toHaveLength(2);
      expect(JSON.stringify(schema)).toBe(before);
      await r.adapter.close();
    }
  }
);
it("retains the original recovered-reply validation after unwrapping", async () => {
  const bodies: any[] = [];
  transport(
    {
      grounded: "yes",
      claims: [],
    },
    bodies
  );
  const r = runtime();
  r.registerModel("TEXT_SMALL", handleTextSmall, "openai", 100);
  await expect(
    runWithTrajectoryContext({ trajectoryStepId: "invalid-union" }, () =>
      reviewRecoveredReply({
        runtime: r,
        reply: "Opening Notes.",
        evidenceJson: "{}",
        effectReceiptIds: [],
        allowFullContextRequest: true,
      })
    )
  ).rejects.toThrow();
  expect(bodies).toHaveLength(1);
  await r.adapter.close();
});
it.each([false, true])(
  "rejects a malformed provider wrapper before delivery (stream=%s)",
  async (stream) => {
    const bodies: any[] = [];
    transport({ grounded: true, claims: [] }, bodies, false);
    const r = runtime();
    const chunks: string[] = [];
    const schema = await capturedSchema();
    await expect(
      runWithTrajectoryContext({ trajectoryStepId: "invalid-wrapper" }, () =>
        handleTextSmall(r, {
          prompt: "Return schema",
          responseSchema: schema,
          stream,
          onStreamChunk: (x: string) => chunks.push(x),
        } as never)
      )
    ).rejects.toThrow();
    expect(chunks).toEqual([]);
    expect(bodies).toHaveLength(1);
    await r.adapter.close();
  }
);
it.each([
  { grounded: "yes", claims: [] },
  { contextRequest: "wrong" },
  {
    grounded: true,
    claims: [],
    extra: true,
  },
])("rejects an invalid union before streaming any text: %j", async (value) => {
  const bodies: any[] = [];
  transport(value, bodies);
  const r = runtime();
  const chunks: string[] = [];
  const schema = await capturedSchema();
  await expect(
    runWithTrajectoryContext({ trajectoryStepId: "invalid-stream-union" }, () =>
      handleTextSmall(r, {
        prompt: "Return schema",
        responseSchema: schema,
        stream: true,
        onStreamChunk: (x: string) => chunks.push(x),
      } as never)
    )
  ).rejects.toThrow();
  expect(chunks).toEqual([]);
  expect(bodies).toHaveLength(1);
  await r.adapter.close();
});
it("does not relocate schemas with root-relative references", async () => {
  const bodies: any[] = [];
  transport({ grounded: true }, bodies, false);
  const r = runtime();
  const schema = {
    anyOf: [{ $ref: "#/$defs/verdict" }],
    $defs: {
      verdict: {
        type: "object",
        properties: { grounded: { type: "boolean" } },
      },
    },
  };
  await expect(
    runWithTrajectoryContext({ trajectoryStepId: "references" }, () =>
      handleTextSmall(r, {
        prompt: "Return schema",
        responseSchema: schema,
      } as never)
    )
  ).rejects.toThrow();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].response_format.json_schema.schema).toHaveProperty("anyOf");
  expect(bodies[0].response_format.json_schema.schema).not.toHaveProperty(
    "properties.__eliza_response"
  );
  await r.adapter.close();
});

it("preserves nested union branches and strict properties", async () => {
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: {
          kind: { const: "value", type: "string" },
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["kind", "value"],
        additionalProperties: false,
      },
    ],
  };
  for (const value of [
    { kind: "value", value: "text" },
    { kind: "value", value: 12 },
  ]) {
    const bodies: any[] = [];
    transport(value, bodies);
    const r = runtime();
    const result = await runWithTrajectoryContext({ trajectoryStepId: "nested-union" }, () =>
      handleTextSmall(r, {
        prompt: "Return schema",
        responseSchema: schema,
      } as never)
    );
    expect(JSON.parse(textOf(result))).toEqual(value);
    expect(bodies).toHaveLength(1);
    await r.adapter.close();
  }
});
