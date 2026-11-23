/**
 * A provider 400 keeps the fields that say what was wrong with the request, so
 * the caller's runtime classifies it as it does on a direct provider route.
 * Cerebras sends its 400 flat; the AI SDK then reports "Bad Request" with the
 * body only in `responseBody`, and the gateway used to send that message alone.
 * The SDK errors here are made by the gateway's own provider library from a
 * local response; nothing is sent.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText } from "ai";

process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
const previousKey = process.env.CEREBRAS_API_KEY;
process.env.CEREBRAS_API_KEY = "cerebras-key-for-provider-400-test";

const { __streamingCreditTestHooks: hooks } = await import("./route");

afterAll(() => {
  if (previousKey === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = previousKey;
});

/** Cerebras's body, as a resident logged it (direct route, November 2026). */
const PARSER_ERROR = {
  message:
    "Failed to generate tool_calls. Exception: Failed to generate tool call but tool_choice = 'required'.",
  type: "generation_error",
  param: "tool_calls",
  code: "parser_error",
  id: "",
  failed_generation: "PRIVATE_FAILED_GENERATION",
};

/** The error the gateway's Cerebras client throws for one provider answer. */
async function providerError(status: number, body: unknown): Promise<unknown> {
  const model = createOpenAI({
    apiKey: "synthetic",
    baseURL: "https://provider.invalid/v1",
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        status,
        statusText: status === 400 ? "Bad Request" : "Provider Error",
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  }).chat("qwen-3.8-27b");
  try {
    await generateText({ model, prompt: "hi", maxRetries: 0 });
  } catch (error) {
    return error;
  }
  throw new Error("provider call succeeded");
}

test("a flat Cerebras parser_error keeps its code, param and message", async () => {
  const error = await providerError(400, PARSER_ERROR);
  // What the gateway receives today: the reason phrase, the body unparsed.
  expect(APICallError.isInstance(error)).toBe(true);
  expect((error as APICallError).message).toBe("Bad Request");
  expect((error as APICallError).data).toBeUndefined();
  expect(hooks.getRecoverableProviderErrorStatus(error)).toBe(400);
  const fields = hooks.getProviderRequestErrorFields(error, undefined);
  expect(fields).toEqual({
    code: "parser_error",
    param: "tool_calls",
    message: PARSER_ERROR.message,
  });
  expect(Object.keys(fields)).toEqual(["code", "param", "message"]);
  expect(JSON.stringify(fields)).not.toContain("PRIVATE_FAILED_GENERATION");
});

test("an enveloped 400 is read from the SDK's parsed data", async () => {
  const error = await providerError(400, {
    error: {
      message:
        "Please reduce the length of the messages or completion. Current length is 140000 while limit is 131072",
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    },
  });
  expect((error as APICallError).data).toBeDefined();
  expect(hooks.getProviderRequestErrorFields(error, undefined)).toEqual({
    code: "context_length_exceeded",
    param: "messages",
    message:
      "Please reduce the length of the messages or completion. Current length is 140000 while limit is 131072",
  });
});

test("the message is redacted, then bounded", async () => {
  const key = "PROMPT_CACHE_KEY_SENTINEL";
  const error = await providerError(400, {
    ...PARSER_ERROR,
    message: `  ${key} ${"x".repeat(1_000)}`,
  });
  const fields = hooks.getProviderRequestErrorFields(error, key);
  expect(fields.code).toBe("parser_error");
  expect(fields.param).toBe("tool_calls");
  expect(fields.message).toHaveLength(200);
  expect(fields.message?.startsWith("[REDACTED_PROMPT_CACHE_KEY] x")).toBe(
    true,
  );
  expect(JSON.stringify(fields)).not.toContain(key);
});

test("only listed codes and params pass; billing and quota codes never do", async () => {
  for (const [code, param] of [
    ["insufficient_quota", "tools"],
    ["rate_limit_exceeded", "messages"],
    ["credit_balance_exhausted", "tool_calls"],
    ["authentication_error", "response_format"],
    ["PRIVATE_SENTINEL", "tools[0].function.parameters.PRIVATE_SENTINEL"],
  ]) {
    const fields = hooks.getProviderRequestErrorFields(
      await providerError(400, { message: "Rejected", code, param }),
      undefined,
    );
    expect(fields.code).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain("PRIVATE_SENTINEL");
    expect(JSON.stringify(fields)).not.toContain(code);
  }
  expect(
    hooks.getProviderRequestErrorFields(
      await providerError(400, { message: "Rejected", code: 400, param: 7 }),
      undefined,
    ),
  ).toEqual({ message: "Rejected" });
});

test("nothing is read from any other status or error", async () => {
  for (const status of [401, 402, 403, 404, 422, 429, 500, 503]) {
    const error = await providerError(status, PARSER_ERROR);
    expect(hooks.getProviderRequestErrorFields(error, undefined)).toEqual({});
  }
  expect(
    hooks.getProviderRequestErrorFields(
      Object.assign(new Error("Bad Request"), {
        status: 400,
        responseBody: JSON.stringify(PARSER_ERROR),
      }),
      undefined,
    ),
  ).toEqual({});
});

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeAll(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe("https://api.cerebras.ai/v1/chat/completions");
    return new Response(JSON.stringify(PARSER_ERROR), {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
});
afterAll(() => fetchSpy.mockRestore());

test("the terminal stream chunk carries the fields ahead of the message", async () => {
  const settlements: string[] = [];
  const response = await hooks.handleStreamingRequest(
    "gpt-oss-120b",
    undefined,
    [{ role: "user", content: "hi" }],
    {
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "HANDLE_RESPONSE",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "required",
    },
    {
      id: "00000000-0000-0000-0000-00000000e002",
      organization_id: "00000000-0000-0000-0000-00000000e001",
    },
    null,
    null,
    "provider-400",
    "provider-400",
    null,
    Date.now(),
    undefined,
    10_000,
    100,
    async (amount) => {
      settlements.push(`exact:${amount}`);
      return null;
    },
    async () => {
      settlements.push("unknown");
      return null;
    },
    undefined,
    {},
    100,
    {},
    "bitrouter",
    null,
    false,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const frame = text
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""))
    .find((data) => data.startsWith('{"error"'));
  expect(frame).toBeDefined();
  expect(JSON.parse(frame as string)).toEqual({
    error: {
      provider_code: "parser_error",
      param: "tool_calls",
      message: "Bad Request",
      type: "invalid_request_error",
      code: 400,
      provider_message: PARSER_ERROR.message,
    },
  });
  expect(Object.keys(JSON.parse(frame as string).error)).toEqual([
    "provider_code",
    "param",
    "message",
    "type",
    "code",
    "provider_message",
  ]);
  expect(text).not.toContain("PRIVATE_FAILED_GENERATION");
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
});

test("the buffered body carries the fields ahead of the message", async () => {
  const error = await providerError(400, PARSER_ERROR);
  const body = hooks.bufferedErrorBody(
    error,
    "Bad Request",
    400,
    false,
    undefined,
  );
  expect(body).toEqual({
    error: {
      code: "parser_error",
      param: "tool_calls",
      message: "Bad Request",
      type: "invalid_request_error",
      provider_message: PARSER_ERROR.message,
    },
  });
  expect(Object.keys(body.error)).toEqual([
    "code",
    "param",
    "message",
    "type",
    "provider_message",
  ]);
  expect(JSON.stringify(body)).not.toContain("PRIVATE_FAILED_GENERATION");
  // Any other status keeps the gateway's own body.
  const upstream = await providerError(500, PARSER_ERROR);
  expect(
    hooks.bufferedErrorBody(upstream, "Upstream failed", 503, false, undefined),
  ).toEqual({
    error: { message: "Upstream failed", type: "service_unavailable" },
  });
  expect(
    hooks.bufferedErrorBody(
      error,
      "Insufficient credits",
      402,
      true,
      undefined,
    ),
  ).toEqual({
    error: {
      message: "Insufficient credits",
      type: "insufficient_quota",
      code: "insufficient_credits",
    },
  });
});
