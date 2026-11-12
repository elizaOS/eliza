/** Actual Hono adapter with controlled canonical-auth/provider ports; no live-provider claim. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { mapChatCompletionToResponse } from "./compatibility";

type ResponseBody = Omit<
  ReturnType<typeof mapChatCompletionToResponse>,
  "error"
> & {
  error?: string;
};

let requests: Request[] = [];
let bodies: Record<string, unknown>[] = [];
let nativeRequests = 0;
let respond: () => Response;
const completion = (
  finishReason = "stop",
  content: string | null = " answer \n",
) => ({
  id: "chatcmpl_original",
  model: "openai/test",
  created: 123,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: finishReason,
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});
mock.module(
  new URL("../chat/completions/route.ts", import.meta.url).pathname,
  () => ({
    handleChatCompletionsPOST: async (request: Request) => {
      requests.push(request);
      bodies.push(await request.json());
      return respond();
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/native-application-inference",
  () => ({
    prepareNativeApplicationInference: async (
      _context: unknown,
      request: Request,
    ) => {
      nativeRequests++;
      return { request, actor: undefined };
    },
    nativeApplicationInferenceErrorResponse: () => undefined,
  }),
);
const { default: app } = await import("./route");

beforeEach(() => {
  requests = [];
  bodies = [];
  nativeRequests = 0;
  respond = () => Response.json(completion());
});
// The leaf router owns '/', as mounted by the production file router.
async function run(
  input: unknown,
  options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
) {
  const response = await app.fetch(
    new Request("https://cloud.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(input),
      signal: options.signal,
    }),
    {},
    { waitUntil() {}, passThroughOnException() {}, props: {} },
  );
  return { response, body: (await response.json()) as ResponseBody };
}
const request = (input: unknown, extra: Record<string, unknown> = {}) => ({
  model: "openai/test",
  input,
  ...extra,
});

test("preserves every instruction and exact text, including whitespace and empty parts", async () => {
  const input = [
    { role: "system", content: " second instruction \n" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "  code:\n    x = 1\n\n" },
        { type: "input_text", text: "" },
      ],
    },
    { role: "developer", content: "third instruction" },
  ];
  const { response, body } = await run(
    request(input, { instructions: " first instruction \n" }),
  );
  expect(response.status).toBe(200);
  expect(bodies[0]?.messages).toEqual([
    { role: "system", content: " first instruction \n" },
    { role: "system", content: " second instruction \n" },
    {
      role: "user",
      content: [
        { type: "text", text: "  code:\n    x = 1\n\n" },
        { type: "text", text: "" },
      ],
    },
    { role: "system", content: "third instruction" },
  ]);
  expect(body.output_text).toBe(" answer \n");
  expect(body.id).toBe("resp_chatcmpl_original");
  expect(body.created_at).toBe(123);
  expect(body.usage).toEqual({
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  });
});

test("preserves interleaved image, file and text parts", async () => {
  const { response } = await run(
    request([
      {
        role: "user",
        content: [
          { type: "input_text", text: "before" },
          {
            type: "input_image",
            image_url: "https://images.test/photo.png",
            detail: "auto",
          },
          {
            type: "input_file",
            file_data: "data:application/pdf;base64,AA==",
            filename: "notes.pdf",
          },
          { type: "input_text", text: "after" },
        ],
      },
    ]),
  );
  expect(response.status).toBe(200);
  expect(bodies[0]?.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "before" },
        {
          type: "image_url",
          image_url: { url: "https://images.test/photo.png" },
        },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,AA==",
            filename: "notes.pdf",
          },
        },
        { type: "text", text: "after" },
      ],
    },
  ]);
});

test("groups parallel calls and retains original tool identities, arguments and outputs", async () => {
  const input = [
    {
      type: "function_call",
      call_id: "call_first",
      name: "weather",
      arguments: '{"city":"NYC"}',
    },
    {
      type: "function_call",
      call_id: "call_second",
      name: "weather",
      arguments: '{"city":"LA"}',
    },
    {
      type: "function_call_output",
      call_id: "call_second",
      output: "  LA result \n",
    },
    {
      type: "function_call_output",
      call_id: "call_first",
      output: "NYC result",
    },
    { role: "user", content: "compare" },
  ];
  const { response } = await run(
    request(input, {
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          parameters: { type: "object" },
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: "weather" },
    }),
  );
  expect(response.status).toBe(200);
  expect(bodies[0]).toMatchObject({
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_first",
            type: "function",
            function: { name: "weather", arguments: '{"city":"NYC"}' },
          },
          {
            id: "call_second",
            type: "function",
            function: { name: "weather", arguments: '{"city":"LA"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_second", content: "  LA result \n" },
      { role: "tool", tool_call_id: "call_first", content: "NYC result" },
      { role: "user", content: "compare" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object" },
          strict: false,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "weather" } },
  });
});

test("forwards sampling, output limits and strict JSON schema to canonical admission", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const { response } = await run(
    request("hello", {
      temperature: 0,
      top_p: 0.5,
      max_output_tokens: 100,
      text: {
        format: {
          type: "json_schema",
          name: "Answer",
          description: "An answer",
          schema,
          strict: true,
        },
      },
      store: false,
    }),
  );
  expect(response.status).toBe(200);
  expect(bodies[0]).toMatchObject({
    temperature: 0,
    top_p: 0.5,
    max_tokens: 100,
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Answer",
        description: "An answer",
        schema,
        strict: true,
      },
    },
  });
});

test("preserves authentication, app scope, request identity and cancellation", async () => {
  const abort = new AbortController();
  const { response } = await run(request("hello"), {
    signal: abort.signal,
    headers: {
      Authorization: "Bearer controlled-test-credential",
      "X-App-Id": "original-app",
      "X-Request-Id": "original-request",
    },
  });
  expect(response.status).toBe(200);
  expect(nativeRequests).toBe(1);
  expect(requests).toHaveLength(1);
  for (const [key, value] of Object.entries({
    Authorization: "Bearer controlled-test-credential",
    "X-App-Id": "original-app",
    "X-Request-Id": "original-request",
  }))
    expect(requests[0]?.headers.get(key)).toBe(value);
  abort.abort();
  expect(requests[0]?.signal.aborted).toBe(true);
});

for (const [reason, incompleteReason] of [
  ["length", "max_output_tokens"],
  ["content_filter", "content_filter"],
]) {
  test(`retains ${reason} as incomplete rather than completed`, async () => {
    respond = () => Response.json(completion(reason, " partial \n"));
    const { response, body } = await run(request("hello"));
    expect(response.status).toBe(200);
    expect(body.status).toBe("incomplete");
    expect(body.output[0].status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({ reason: incompleteReason });
    expect(body.output_text).toBe(" partial \n");
  });
}

test("retains a provider refusal and function call without inventing visible text", async () => {
  respond = () =>
    Response.json({
      ...completion("tool_calls", null),
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            refusal: "refused action",
            tool_calls: [
              {
                id: "original",
                type: "function",
                function: { name: "safe_action", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });
  const { body } = await run(request("hello"));
  expect(body.output_text).toBe("");
  expect(body.output).toEqual([
    {
      id: "msg_chatcmpl_original",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "refusal", refusal: "refused action" }],
    },
    {
      id: "fc_original",
      type: "function_call",
      status: "completed",
      call_id: "original",
      name: "safe_action",
      arguments: "{}",
    },
  ]);
});

test("leaves absent provider usage unknown", async () => {
  const { usage: _, ...payload } = completion();
  respond = () => Response.json(payload);
  const { body } = await run(request("hello"));
  expect(body.usage).toBeNull();
});

const invalidInputs: Array<[string, unknown]> = [
  [
    "invalid item identity",
    request([{ id: {}, role: "assistant", content: "partial" }]),
  ],
  [
    "invalid item status",
    request([
      { status: ["in_progress"], role: "assistant", content: "partial" },
    ]),
  ],
  [
    "unfinished item",
    request([{ status: "in_progress", role: "assistant", content: "partial" }]),
  ],
  ["non-string role", request([{ role: ["user"], content: "hello" }])],
  ["non-string tool choice", request("hello", { tool_choice: ["auto"] })],
  [
    "unknown content",
    request([
      { role: "user", content: [{ type: "input_audio", data: "AA==" }] },
    ]),
  ],
  [
    "file identifier",
    request([
      {
        role: "user",
        content: [{ type: "input_file", file_id: "file_original" }],
      },
    ]),
  ],
  [
    "unrepresentable image detail",
    request([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://test/image",
            detail: "high",
          },
        ],
      },
    ]),
  ],
  [
    "non-user media",
    request([
      {
        role: "system",
        content: [{ type: "input_image", image_url: "https://test/image" }],
      },
    ]),
  ],
  [
    "annotated text",
    request([
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "a",
            annotations: [{ type: "url_citation" }],
          },
        ],
      },
    ]),
  ],
  [
    "stored previous response",
    request("hello", { previous_response_id: "resp_original" }),
  ],
  ["stored output", request("hello", { store: true })],
  ["streaming", request("hello", { stream: true })],
  ["hosted tools", request("hello", { tools: [{ type: "web_search" }] })],
  [
    "unsupported schema mode",
    request("hello", {
      text: {
        format: {
          type: "json_schema",
          name: "test",
          schema: {},
          strict: false,
        },
      },
    }),
  ],
  [
    "duplicate call",
    request([
      { type: "function_call", call_id: "same", name: "test", arguments: "{}" },
      { type: "function_call", call_id: "same", name: "test", arguments: "{}" },
    ]),
  ],
  [
    "unmatched output",
    request([
      { type: "function_call_output", call_id: "unknown", output: "data" },
    ]),
  ],
  [
    "missing output",
    request([
      {
        type: "function_call",
        call_id: "missing",
        name: "test",
        arguments: "{}",
      },
    ]),
  ],
  [
    "invalid arguments",
    request([
      {
        type: "function_call",
        call_id: "bad",
        name: "test",
        arguments: "not-json",
      },
    ]),
  ],
  [
    "unknown named tool",
    request("hello", { tool_choice: { type: "function", name: "missing" } }),
  ],
  [
    "conflicting token limits",
    request("hello", { max_tokens: 10, max_output_tokens: 20 }),
  ],
  ["invalid token limit", request("hello", { max_output_tokens: -1 })],
  ["invalid model type", { model: {}, input: "hello" }],
  ["non-object body", []],
];
describe("explicit refusal before native or canonical effects", () => {
  for (const [name, input] of invalidInputs)
    test(name, async () => {
      const { response } = await run(input);
      expect(response.status).toBe(400);
      expect(nativeRequests).toBe(0);
      expect(requests).toHaveLength(0);
    });
});

for (const [name, payload] of [
  ["empty object", {}],
  ["non-string finish reason", completion(["stop"] as unknown as string)],
  [
    "invalid role",
    {
      ...completion(),
      choices: [
        { finish_reason: "stop", message: { role: "user", content: "hello" } },
      ],
    },
  ],
  ["no choices", { ...completion(), choices: [] }],
  ["missing provider identity", { ...completion(), id: undefined }],
  [
    "missing finish reason",
    { ...completion(), choices: [{ message: { content: "text" } }] },
  ],
  ["unknown terminal reason", completion("error")],
  ["empty completed output", completion("stop", null)],
  [
    "unidentified call",
    {
      ...completion(),
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              { type: "function", function: { name: "test", arguments: "{}" } },
            ],
          },
        },
      ],
    },
  ],
  ["fabricated zero usage", { ...completion(), usage: {} }],
] as Array<[string, unknown]>)
  test(`malformed provider ${name} fails without fabricated completion`, async () => {
    respond = () => Response.json(payload);
    const { response, body } = await run(request("hello"));
    expect(requests).toHaveLength(1);
    expect(response.status).toBe(503);
    expect(body.status).toBeUndefined();
    expect(body.error).toBe("Responses provider unavailable");
  });

test("invalid provider JSON is sanitized", async () => {
  respond = () => new Response("not json: PRIVATE_PROVIDER_DETAIL");
  const { response, body } = await run(request("hello"));
  expect(response.status).toBe(503);
  expect(JSON.stringify(body)).not.toContain("PRIVATE_PROVIDER_DETAIL");
});
for (const status of [401, 403, 429, 503])
  test(`keeps the canonical ${status} refusal`, async () => {
    respond = () =>
      Response.json(
        { error: "canonical refusal" },
        { status, headers: { "Retry-After": "3" } },
      );
    const { response, body } = await run(request("hello"));
    expect(response.status).toBe(status);
    expect(body.error).toBe(
      status >= 500 ? "Responses provider unavailable" : "canonical refusal",
    );
    if (status < 500) expect(response.headers.get("Retry-After")).toBe("3");
  });

for (const [shape, payload, code] of [
  [
    "admission",
    {
      error: {
        message:
          "Inference admission is temporarily unavailable. Retry shortly.",
        type: "service_unavailable",
        code: "inference_admission_unavailable",
      },
    },
    "inference_admission_unavailable",
  ],
  [
    "billing",
    { error: { type: "service_unavailable", code: "billing_unavailable" } },
    "billing_unavailable",
  ],
  [
    "rate limiter",
    {
      success: false,
      error: "Rate limit unavailable",
      code: "rate_limit_unavailable",
    },
    "rate_limit_unavailable",
  ],
] as const)
  test(`a typed retryable ${shape} 503 keeps its body and Retry-After`, async () => {
    respond = () =>
      Response.json(payload, { status: 503, headers: { "Retry-After": "1" } });
    const { response, body } = await run(request("hello"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(body as unknown).toEqual(payload);
    expect(JSON.stringify(body)).toContain(code);
  });
