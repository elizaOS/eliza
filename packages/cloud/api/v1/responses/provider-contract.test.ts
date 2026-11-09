/** Real Responses+chat routes and OpenAI SDK; authority/billing are controlled ports. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
const auth = await import(
  "@elizaos/cloud-shared/lib/services/inference-auth-context"
);
const providers = await import(
  "@elizaos/cloud-shared/lib/providers/language-model"
);
const catalogue = await import(
  "@elizaos/cloud-shared/lib/services/model-catalog"
);
const limits = await import("@elizaos/cloud-shared/lib/middleware/rate-limit");
const admission = await import(
  "@elizaos/cloud-shared/lib/services/organization-inference-admission"
);
const billing = await import("@elizaos/cloud-shared/lib/services/ai-billing");
const ledger = await import(
  "@elizaos/cloud-shared/lib/services/ai-billing-settled"
);
const wireRequests: Record<string, unknown>[] = [];
let authCalls = 0;
let admissions = 0;
const spies: Array<{ mockRestore(): void }> = [];
const model = createOpenAI({
  apiKey: "local-test-key",
  baseURL: "https://provider.invalid/v1",
  fetch: (async (input, init) => {
    expect(String(input)).toBe("https://provider.invalid/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    wireRequests.push(body);
    if (body.stream) {
      const chunk = {
        id: "provider-original",
        object: "chat.completion.chunk",
        created: 123,
        model: "test",
      };
      return new Response(
        [
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: "stream output" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return Response.json({
      id: "provider-original",
      object: "chat.completion",
      created: 123,
      model: "test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "  exact output \n" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }) as typeof fetch,
}).chat("test");
beforeAll(() => {
  spies.push(
    spyOn(auth, "resolveInferenceAuthContext").mockImplementation(async () => {
      authCalls++;
      return {
        kind: "authorized",
        source: "cache",
        ctx: { userId: "test-user", orgId: "test-org", apiKeyId: null },
      } as Awaited<ReturnType<typeof auth.resolveInferenceAuthContext>>;
    }),
  );
  spies.push(spyOn(limits, "enforceOrgRateLimit").mockResolvedValue(null));
  spies.push(
    spyOn(providers, "hasLanguageModelProviderConfigured").mockReturnValue(
      true,
    ),
  );
  spies.push(
    spyOn(providers, "resolvePooledDirectProviderForModel").mockReturnValue(
      null,
    ),
  );
  spies.push(
    spyOn(providers, "resolveAiProviderSource").mockReturnValue("openai"),
  );
  spies.push(spyOn(providers, "getLanguageModel").mockReturnValue(model));
  spies.push(
    spyOn(catalogue, "getCachedGatewayModelById").mockResolvedValue(null),
  );
  spies.push(
    spyOn(admission, "admitOrganizationInference").mockImplementation(
      async () => {
        admissions++;
        return {
          mode: "durable_object_debit",
          settle: async () => null,
          settleUnknown: async () => null,
        } as Awaited<ReturnType<typeof admission.admitOrganizationInference>>;
      },
    ),
  );
  spies.push(
    spyOn(billing, "billUsage").mockResolvedValue({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      totalCost: 0,
    } as Awaited<ReturnType<typeof billing.billUsage>>),
  );
  spies.push(
    spyOn(ledger, "recordSettledInferenceBilling").mockResolvedValue({
      usageRecord: null,
      record: {} as Awaited<
        ReturnType<typeof ledger.recordSettledInferenceBilling>
      >["record"],
    }),
  );
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

test("all system messages and media reach the actual SDK wire in order", async () => {
  const { default: app } = await import("./route");
  const tasks: Promise<unknown>[] = [];
  const input = [
    { role: "system", content: " second instruction \n" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "before" },
        { type: "input_image", image_url: "https://images.test/image.png" },
        { type: "input_text", text: "after" },
      ],
    },
    { role: "developer", content: " third instruction \n" },
  ];
  // A non-Worker direct chat call uses the same conversion. The Hono wrapper supplies
  // an execution context; we provide cache-only catalogue data for that path below.
  const cached = spyOn(
    catalogue,
    "getGatewayModelByIdCacheOnly",
  ).mockResolvedValue({ kind: "ready", model: null, stale: false });
  try {
    const response = await app.fetch(
      new Request("https://cloud.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/test",
          instructions: " first instruction \n",
          input,
        }),
      }),
      {},
      {
        waitUntil(task) {
          tasks.push(task);
        },
        passThroughOnException() {},
        props: {},
      },
    );
    const body = (await response.json()) as { output_text: string };
    await Promise.all(tasks);
    expect(response.status).toBe(200);
    expect(authCalls).toBe(1);
    expect(admissions).toBe(1);
    expect(wireRequests).toHaveLength(1);
    expect(wireRequests[0]?.messages).toEqual([
      { role: "system", content: " first instruction \n" },
      { role: "system", content: " second instruction \n" },
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "image_url",
            image_url: { url: "https://images.test/image.png" },
          },
          { type: "text", text: "after" },
        ],
      },
      { role: "system", content: " third instruction \n" },
    ]);
    expect(body.output_text).toBe("  exact output \n");
  } finally {
    cached.mockRestore();
  }
});

test("distinct requests keep distinct response identities within one clock tick", async () => {
  const { handleChatCompletionsPOST } = await import(
    "../chat/completions/route"
  );
  const frozenClock = spyOn(Date, "now").mockReturnValue(123000);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await handleChatCompletionsPOST(
        new Request("https://cloud.test/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "openai/test",
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
      );
      expect(response.status).toBe(200);
      ids.push(((await response.json()) as { id: string }).id);
    }
    expect(ids[0]).not.toBe(ids[1]);
  } finally {
    frozenClock.mockRestore();
  }
});

test("streaming retains instructions and a stable unique identity per request", async () => {
  const { handleChatCompletionsPOST } = await import(
    "../chat/completions/route"
  );
  const frozenClock = spyOn(Date, "now").mockReturnValue(123000);
  const requestIds: string[] = [];
  const messages = [
    { role: "system", content: "first" },
    { role: "user", content: "hello" },
    { role: "system", content: "second" },
  ];
  try {
    for (let i = 0; i < 2; i++) {
      const response = await handleChatCompletionsPOST(
        new Request("https://cloud.test/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "openai/test",
            stream: true,
            messages,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const chunks = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)) as { id: string });
      expect(chunks.length).toBeGreaterThan(1);
      expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
      requestIds.push(chunks[0]!.id);
      expect(wireRequests.at(-1)?.messages).toEqual(messages);
    }
    expect(requestIds[0]).not.toBe(requestIds[1]);
  } finally {
    frozenClock.mockRestore();
  }
});
