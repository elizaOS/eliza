/**
 * Agent inference markup is retired (#22961 / #32907). Publishing must not turn
 * it back on, and an agent row whose stored `monetization_enabled` flag is still
 * set (for example one re-published before this fence) must bill A2A and MCP
 * callers the base inference cost only and advertise no surcharge.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { type Env, Hono } from "hono";

const OWNER = { id: "owner-user", organization_id: "owner-org" };
const CALLER = { id: "caller-user", organization_id: "caller-org" };

type Agent = Record<string, unknown> & { id: string; is_public: boolean };

let agent: Agent;
const publishWrites: Array<{ id: string; options: Record<string, unknown> }> =
  [];
const admissions: Array<{
  flatCost: {
    baseTotalCost: number;
    platformMarkup: number;
    totalCost: number;
  };
  settled: number[];
}> = [];

function storedMonetizedAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Markup Agent",
    user_id: OWNER.id,
    organization_id: OWNER.organization_id,
    is_public: true,
    a2a_enabled: true,
    mcp_enabled: true,
    monetization_enabled: true,
    inference_markup_percentage: "1000.00",
    system: null,
    bio: "An agent whose stored row still carries a creator markup.",
    settings: {},
    category: null,
    tags: [],
    avatar_url: null,
    ...overrides,
  };
}

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => OWNER,
}));
mock.module("@/api-app/middleware/org-membership", () => ({
  assertOrgMembership: async () => {},
}));
mock.module("@elizaos/cloud-shared/db/repositories/characters", () => ({
  userCharactersRepository: {
    publish: async (id: string, options: Record<string, unknown>) => {
      publishWrites.push({ id, options });
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/characters/characters", () => ({
  charactersService: {
    getById: async () => agent,
    getByIdCacheOnly: async () => ({ kind: "ready", character: agent }),
    invalidateCache: async () => {},
    listPublic: async () => [agent],
    countPublicCatalog: async () => 1,
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/user-mcps", () => ({
  userMcpsService: {
    listPublic: async () => [],
    countPublic: async () => 0,
    getPublicProxyUrl: () => "",
  },
}));
mock.module("@elizaos/cloud-shared/lib/cache/client", () => ({
  cache: { get: async () => null, set: async () => {} },
}));
mock.module("@/api-app/lib/generative-route-auth", () => ({
  asGenerativeCacheApiError: () => null,
  getGenerativeExecutionContext: () => undefined,
  requireGenerativeRouteCaller: async () => ({
    user: CALLER,
    apiKeyId: null,
    admissionSnapshot: undefined,
    credential: undefined,
  }),
  resolveInferenceCredentialAdmissionDenial: () => null,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/deferred-credential-admission-guard",
  () => ({
    deferredCredentialAdmissionGuard: () => ({
      credentialForAdmission: () => undefined,
      [Symbol.asyncDispose]: async () => {},
    }),
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    RateLimitPresets: { STANDARD: {} },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }),
);
mock.module("@elizaos/cloud-shared/lib/pricing", () => ({
  estimateRequestCost: async () => 0.01,
  calculateCost: async () => ({ totalCost: 0.02 }),
  getProviderFromModel: () => "openai",
}));
mock.module("@elizaos/cloud-shared/lib/providers/language-model", () => ({
  getLanguageModel: () => ({}),
  resolveAiProviderSource: () => "gateway",
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-inference-admission",
  () => ({
    admitOrganizationInference: async (input: {
      flatCost: (typeof admissions)[number]["flatCost"];
    }) => {
      const record = { flatCost: input.flatCost, settled: [] as number[] };
      admissions.push(record);
      return {
        markProviderDispatched: async () => {},
        settle: async (amount: number) => {
          record.settled.push(amount);
          return undefined;
        },
        settleUnknown: async () => undefined,
      };
    },
  }),
);
mock.module("ai", () => ({
  streamText: async () => ({
    textStream: (async function* () {
      yield "hello";
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    }),
  }),
}));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { default: publishRoute } = await import(
  "../v1/agents/[agentId]/publish/route"
);
const { default: a2aRoute } = await import("../agents/[id]/a2a/route");
const { default: mcpRoute, handleToolCall } = await import(
  "../agents/[id]/mcp/route"
);
const { default: discoveryRoute } = await import("../v1/discovery/route");
afterAll(() => mock.restore());

beforeEach(() => {
  agent = storedMonetizedAgent();
  publishWrites.length = 0;
  admissions.length = 0;
});

function mounted<E extends Env>(route: Hono<E>, path: string): Hono<E> {
  return new Hono<E>().route(path, route);
}

async function json<T>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

const env = { NEXT_PUBLIC_APP_URL: "https://cloud.test" };

async function publish(body: Record<string, unknown>) {
  return mounted(publishRoute, "/agents/:agentId/publish").request(
    "/agents/agent-1/publish",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

test("publishing with enableMonetization is refused with the typed 410 and writes nothing", async () => {
  agent = storedMonetizedAgent({
    is_public: false,
    monetization_enabled: false,
    inference_markup_percentage: "0.00",
  });

  const response = await publish({
    enableMonetization: true,
    markupPercentage: 1000,
  });

  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({
    code: "creator_monetization_retired",
  });
  expect(publishWrites).toHaveLength(0);
});

test("the refusal also answers an already-public agent instead of reporting success", async () => {
  const response = await publish({ enableMonetization: true });
  expect(response.status).toBe(410);
  expect(publishWrites).toHaveLength(0);
});

test("a requested markup is refused too, instead of being silently dropped", async () => {
  agent = storedMonetizedAgent({ is_public: false });
  const response = await publish({ markupPercentage: 250 });
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({
    code: "creator_monetization_retired",
  });
  expect(publishWrites).toHaveLength(0);
});

test.each([
  ["an out-of-range markup", { markupPercentage: 5000 }],
  ["a string markup", { markupPercentage: "250" }],
  ["a string enable flag", { enableMonetization: "true" }],
])(
  "%s that fails validation is still refused, not published with defaults",
  async (_label, body) => {
    agent = storedMonetizedAgent({ is_public: false });
    const response = await publish(body);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      code: "creator_monetization_retired",
    });
    expect(publishWrites).toHaveLength(0);
  },
);

test("any other invalid publish body is a typed 400, not a publish with defaults", async () => {
  agent = storedMonetizedAgent({ is_public: false });
  const response = await publish({ a2aEnabled: "yes" });
  expect(response.status).toBe(400);
  expect(publishWrites).toHaveLength(0);
});

test.each(["{", '{"a2aEnabled":', "not JSON"])(
  "malformed JSON %s never publishes with defaults",
  async (body) => {
    agent = storedMonetizedAgent({ is_public: false });
    const response = await mounted(
      publishRoute,
      "/agents/:agentId/publish",
    ).request(
      "/agents/agent-1/publish",
      { method: "POST", headers: { "content-type": "application/json" }, body },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
    expect(publishWrites).toHaveLength(0);
  },
);

test.each(["", " \n\t"])(
  "an empty publish body %j retains defaults",
  async (body) => {
    agent = storedMonetizedAgent({ is_public: false });
    const response = await mounted(
      publishRoute,
      "/agents/:agentId/publish",
    ).request(
      "/agents/agent-1/publish",
      { method: "POST", headers: { "content-type": "application/json" }, body },
      env,
    );
    expect(response.status).toBe(200);
    expect(publishWrites).toEqual([
      {
        id: "agent-1",
        options: {
          payoutWalletAddress: undefined,
          a2aEnabled: true,
          mcpEnabled: true,
        },
      },
    ]);
  },
);

test("an ordinary publish writes no monetization option and reports markup off", async () => {
  agent = storedMonetizedAgent({ is_public: false });

  const response = await publish({ markupPercentage: 0, mcpEnabled: false });

  expect(response.status).toBe(200);
  expect(publishWrites).toEqual([
    {
      id: "agent-1",
      options: {
        payoutWalletAddress: undefined,
        a2aEnabled: true,
        mcpEnabled: false,
      },
    },
  ]);
  expect(await response.json()).toMatchObject({
    agent: { monetizationEnabled: false, markupPercentage: 0 },
  });
});

test("A2A chat on a stored monetized row reserves and settles the base cost only", async () => {
  const response = await mounted(a2aRoute, "/agents/:id/a2a").request(
    "/agents/agent-1/a2a",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chat",
        params: { messages: [{ role: "user", content: "hi" }] },
      }),
    },
    env,
  );

  expect(response.status).toBe(200);
  expect(admissions).toHaveLength(1);
  expect(admissions[0]?.flatCost).toEqual({
    baseTotalCost: 0.01,
    platformMarkup: 0,
    totalCost: 0.01,
  });
  expect(admissions[0]?.settled).toEqual([0.02]);
  expect(await response.json()).toMatchObject({
    result: { cost: { base: 0.02, markup: 0, total: 0.02 } },
  });
});

test("MCP chat on a stored monetized row reserves and settles the base cost only", async () => {
  const app = new Hono().post("/", (c) =>
    handleToolCall(
      c as never,
      agent as never,
      { name: "chat", arguments: { message: "hi" } },
      1,
      { ...CALLER, apiKeyId: null },
    ),
  );

  const response = await app.request("/", { method: "POST" }, env);

  expect(response.status).toBe(200);
  expect(admissions).toHaveLength(1);
  expect(admissions[0]?.flatCost).toEqual({
    baseTotalCost: 0.01,
    platformMarkup: 0,
    totalCost: 0.01,
  });
  expect(admissions[0]?.settled).toEqual([0.02]);
  expect(await response.json()).toMatchObject({
    result: { _meta: { cost: { base: 0.02, markup: 0, total: 0.02 } } },
  });
});

test("agent cards and info calls advertise no creator markup for a stored monetized row", async () => {
  const a2aCard = await json<unknown>(
    mounted(a2aRoute, "/agents/:id/a2a").request(
      "/agents/agent-1/a2a",
      {},
      env,
    ),
  );
  expect(JSON.stringify(a2aCard)).not.toContain("markupPercentage");

  const mcpCard = await json<{ pricing: unknown }>(
    mounted(mcpRoute, "/agents/:id/mcp").request(
      "/agents/agent-1/mcp",
      {},
      env,
    ),
  );
  expect(mcpCard.pricing).toEqual({
    type: "credits",
    description: "Standard inference costs",
  });

  const info = await json<{ result: unknown }>(
    mounted(a2aRoute, "/agents/:id/a2a").request(
      "/agents/agent-1/a2a",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getAgentInfo" }),
      },
      env,
    ),
  );
  expect(info.result).toMatchObject({
    monetizationEnabled: false,
    markupPercentage: "0",
  });

  const app = new Hono().post("/", (c) =>
    handleToolCall(c as never, agent as never, { name: "get_info" }, 3, {
      ...CALLER,
      apiKeyId: null,
    }),
  );
  const getInfo = await json<{ result: { content: Array<{ text: string }> } }>(
    app.request("/", { method: "POST" }, env),
  );
  expect(JSON.parse(getInfo.result.content[0]?.text ?? "{}")).toMatchObject({
    monetization: false,
    markup: "0",
  });
});

test("discovery lists a stored monetized agent at the standard metered price it is billed", async () => {
  const listing = await json<{
    services: Array<{ id: string; pricing?: unknown }>;
  }>(
    mounted(discoveryRoute, "/discovery").request(
      "/discovery?types=agent",
      {},
      env,
    ),
  );
  expect(listing.services.map((service) => service.id)).toEqual(["agent-1"]);
  // Metered at the base inference cost: neither a markup nor "free".
  expect(listing.services[0]?.pricing).toEqual({
    type: "credits",
    description: "Standard inference costs",
  });
});
