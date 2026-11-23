/**
 * A product that serves this repository's Cloud Worker from its own base keeps
 * the Cerebras request form of `api.eliza.app` when the host lists that base in
 * `ELIZAOS_CLOUD_CANONICAL_CEREBRAS_BASE_URLS`. Without the declaration every
 * base keeps the form it has today, and no other base gets the Cerebras form.
 */
import { createHandleResponseTool, type IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderCachePlan } from "../../plugin-assistant/src/runtime/provider-cache-plan";
import { resetDevCloudEnvAuthorityForTests } from "../src/cloud-config/dev-cloud-env-authority";
import { handleActionPlanner, handleResponseHandler } from "../src/models/text";

const SETTING = "ELIZAOS_CLOUD_CANONICAL_CEREBRAS_BASE_URLS";
const CANONICAL_BASE = "https://api.eliza.app/api/v1";
const PRODUCT_BASE = "https://cloud.product.example/api/v1";
const OTHER_BASE = "https://gateway.other.example/api/v1";
/** The model a phone's launcher sets on every Cloud slot. */
const MODEL = "cerebras/qwen-3.8-27b";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDevCloudEnvAuthorityForTests();
});

const noParameters = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

/**
 * Planner tools as core sends them: every tool asks for strict decoding. The
 * first two schemas meet the strict contract; the others keep an optional
 * property, so the general form drops their flag and leaves a mixed batch.
 */
const plannerTools = [
  { name: "IGNORE", description: "Do nothing.", strict: true, parameters: noParameters },
  { name: "STOP", description: "End the turn.", strict: true, parameters: noParameters },
  {
    name: "DISCOVER_ACTIONS",
    description: "Find actions for a need.",
    strict: true,
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "PROPOSE_DEVICE_ACTION",
    description: "Propose an action on the device.",
    strict: true,
    parameters: {
      type: "object",
      properties: { action: { type: "string" }, note: { type: "string", maxLength: 280 } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "REPLY",
    description: "Answer the user.",
    strict: true,
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, tone: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

/** Stage 1's single tool, with the Calendar string bounds the canonical form projects out. */
const stage1Tool = createHandleResponseTool({
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["intents", "calendarReadBindings"],
    properties: {
      intents: { type: "array", items: { type: "string" } },
      calendarReadBindings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["filterEvidence"],
          properties: {
            filterEvidence: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["query", "quote"],
                properties: {
                  query: { type: "string", minLength: 1, maxLength: 160 },
                  quote: { type: "string", minLength: 1, maxLength: 2048 },
                },
              },
            },
          },
        },
      },
    },
  },
});

const evaluatorSchema = {
  type: "object",
  properties: { success: { type: "boolean" }, decision: { type: "string" } },
  required: ["success", "decision"],
  additionalProperties: false,
};

/** The cache bookkeeping core attaches to every Stage 1, planner and evaluator call. */
function cacheOptions(hasTools: boolean): Record<string, unknown> {
  const plan = buildProviderCachePlan({
    conversationId: "synthetic-conversation",
    prefixHash: "a".repeat(64),
    promptSegments: [{ stable: true }],
    hasTools,
  });
  return {
    ...plan.providerOptions,
    eliza: { ...(plan.providerOptions.eliza as object), thinking: "off" },
  };
}

const KINDS = ["stage1", "planner", "evaluator"] as const;
type Kind = (typeof KINDS)[number];

type Sent = { url: string; body: string; json: Record<string, unknown> };

/** Render one request through the real handler and return the bytes it would upload. */
async function send(
  kind: Kind,
  baseUrl: string,
  options: { declared?: string; selected?: boolean } = {}
): Promise<Sent> {
  const settings: Record<string, string> = {
    ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
    ELIZAOS_CLOUD_BASE_URL: baseUrl,
    ELIZAOS_CLOUD_SMALL_MODEL: MODEL,
    ELIZAOS_CLOUD_LARGE_MODEL: MODEL,
    ...(options.declared === undefined ? {} : { [SETTING]: options.declared }),
  };
  const runtime = {
    character: { name: "Product base test", bio: [] },
    getSetting: (key: string) => settings[key],
    getModel: (type: string) =>
      options.selected === false
        ? undefined
        : type === "RESPONSE_HANDLER"
          ? handleResponseHandler
          : type === "ACTION_PLANNER"
            ? handleActionPlanner
            : undefined,
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
  const sent: Sent[] = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = String(init?.body);
    sent.push({ url: String(url), body, json: JSON.parse(body) });
    return Response.json({
      choices: [
        { message: { role: "assistant", content: '{"text":"ok"}' }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  const messages = [
    { role: "system", content: "You are a careful assistant." },
    { role: "user", content: "What is on my calendar tomorrow?" },
  ];
  try {
    if (kind === "stage1") {
      await handleResponseHandler(runtime, {
        messages,
        tools: [stage1Tool],
        toolChoice: "required",
        maxTokens: 4096,
        providerOptions: cacheOptions(true),
      } as never);
    } else if (kind === "planner") {
      await handleActionPlanner(runtime, {
        messages,
        tools: plannerTools,
        toolChoice: "required",
        maxTokens: 4096,
        providerOptions: cacheOptions(true),
      } as never);
    } else {
      await handleResponseHandler(runtime, {
        messages,
        responseSchema: evaluatorSchema,
        maxTokens: 4096,
        providerOptions: cacheOptions(false),
      } as never);
    }
  } finally {
    fetchSpy.mockRestore();
  }
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe(`${baseUrl.replace(/\/+$/, "")}/chat/completions`);
  expect(sent[0].json.model).toBe(MODEL);
  return sent[0];
}

const strictFlags = (sent: Sent): unknown[] =>
  ((sent.json.tools ?? []) as Array<{ function: { strict?: boolean } }>).map(
    (tool) => tool.function.strict
  );

describe("the canonical Cerebras form on api.eliza.app", () => {
  it("uses one strictness mode per tool batch, JSON-object output and no providerOptions copy", async () => {
    const stage1 = await send("stage1", CANONICAL_BASE);
    const planner = await send("planner", CANONICAL_BASE);
    const evaluator = await send("evaluator", CANONICAL_BASE);
    expect(strictFlags(stage1)).toEqual([true]);
    expect(strictFlags(planner)).toEqual([false, false, false, false, false]);
    expect(evaluator.json.response_format).toEqual({ type: "json_object" });
    for (const sent of [stage1, planner, evaluator]) {
      expect(sent.json).not.toHaveProperty("providerOptions");
      expect(sent.json).not.toHaveProperty("provider_options");
      expect(sent.json.prompt_cache_key).toMatch(/^eliza-workflow-v1:[a-f0-9]{64}$/);
    }
  });

  it.each(KINDS)(
    "%s is the same request with and without a declared product base",
    async (kind) => {
      const plain = await send(kind, CANONICAL_BASE);
      expect((await send(kind, CANONICAL_BASE)).body).toBe(plain.body);
      expect((await send(kind, CANONICAL_BASE, { declared: PRODUCT_BASE })).body).toBe(plain.body);
    }
  );
});

describe("a product Cloud base that the host has not declared", () => {
  it("keeps the general form: mixed strict flags, no response_format, providerOptions sent twice", async () => {
    const stage1 = await send("stage1", PRODUCT_BASE);
    const planner = await send("planner", PRODUCT_BASE);
    const evaluator = await send("evaluator", PRODUCT_BASE);
    expect(strictFlags(planner)).toEqual([true, true, undefined, undefined, undefined]);
    expect(evaluator.json).not.toHaveProperty("response_format");
    for (const sent of [stage1, planner, evaluator]) {
      expect(sent.json.providerOptions).toBeDefined();
      expect(sent.json.provider_options).toEqual(sent.json.providerOptions);
    }
    // Stage 1 keeps the string bounds the canonical form projects out.
    expect(stage1.body).toContain('"maxLength":2048');
    expect((await send("stage1", CANONICAL_BASE)).body).not.toContain('"maxLength":2048');
  });

  it.each([
    ["a wildcard", "*"],
    ["a boolean", "true"],
    ["the host alone", "cloud.product.example"],
    ["the origin without its path", "https://cloud.product.example"],
    ["a shorter path", "https://cloud.product.example/api"],
    ["a longer path", `${PRODUCT_BASE}/extra`],
    ["another gateway", OTHER_BASE],
    ["a blank value", "  "],
  ])("does not read %s as a declaration of the product base", async (_label, declared) => {
    for (const kind of KINDS) {
      expect((await send(kind, PRODUCT_BASE, { declared })).body).toBe(
        (await send(kind, PRODUCT_BASE)).body
      );
    }
  });
});

describe("a product Cloud base the host declares in ELIZAOS_CLOUD_CANONICAL_CEREBRAS_BASE_URLS", () => {
  it.each(KINDS)("%s uploads the api.eliza.app request, byte for byte", async (kind) => {
    const canonical = await send(kind, CANONICAL_BASE);
    const product = await send(kind, PRODUCT_BASE, { declared: PRODUCT_BASE });
    expect(product.body).toBe(canonical.body);
    expect(JSON.stringify(product.json.tools)).toBe(JSON.stringify(canonical.json.tools));
    expect(strictFlags(product)).toEqual(strictFlags(canonical));
    expect(product.json.response_format).toEqual(canonical.json.response_format);
    expect(Object.keys(product.json)).toEqual(Object.keys(canonical.json));
    // The declaration changed the request: it is not the undeclared form.
    expect(product.body).not.toBe((await send(kind, PRODUCT_BASE)).body);
  });

  it("is read from the process environment, where a launcher sets it beside the base", async () => {
    vi.stubEnv(SETTING, PRODUCT_BASE);
    for (const kind of KINDS) {
      expect((await send(kind, PRODUCT_BASE)).body).toBe((await send(kind, CANONICAL_BASE)).body);
    }
  });

  it("is read from the launcher's frozen tuple under a development authority", async () => {
    const canonical: Record<string, string> = {};
    for (const kind of KINDS) canonical[kind] = (await send(kind, CANONICAL_BASE)).body;
    // A self-hosted development launcher owns the base, the key and every
    // other ELIZAOS_CLOUD_* value from its launch environment.
    vi.stubEnv("ELIZA_DEV_SOURCE", "1");
    vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "self-hosted");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "synthetic-test-key");
    vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", PRODUCT_BASE);
    vi.stubEnv(SETTING, PRODUCT_BASE);
    resetDevCloudEnvAuthorityForTests();
    for (const kind of KINDS) {
      expect((await send(kind, PRODUCT_BASE)).body).toBe(canonical[kind]);
      // The tuple was frozen on that first read: a later change to the
      // process environment does not withdraw or move the declaration.
      vi.stubEnv(SETTING, OTHER_BASE);
    }
  });

  it("accepts a list, and ignores blanks and trailing slashes", async () => {
    const declared = ` ${OTHER_BASE} , ,${PRODUCT_BASE}// `;
    for (const kind of KINDS) {
      expect((await send(kind, PRODUCT_BASE, { declared })).body).toBe(
        (await send(kind, CANONICAL_BASE)).body
      );
      expect((await send(kind, `${PRODUCT_BASE}/`, { declared: PRODUCT_BASE })).body).toBe(
        (await send(kind, CANONICAL_BASE)).body
      );
    }
  });

  it("leaves a gateway the host did not list on the general form", async () => {
    for (const kind of KINDS) {
      expect((await send(kind, OTHER_BASE, { declared: PRODUCT_BASE })).body).toBe(
        (await send(kind, OTHER_BASE)).body
      );
    }
    expect(strictFlags(await send("planner", OTHER_BASE, { declared: PRODUCT_BASE }))).toEqual([
      true,
      true,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("still requires this provider to be the selected text handler", async () => {
    for (const kind of KINDS) {
      expect(
        (await send(kind, PRODUCT_BASE, { declared: PRODUCT_BASE, selected: false })).body
      ).toBe((await send(kind, PRODUCT_BASE)).body);
    }
  });
});
