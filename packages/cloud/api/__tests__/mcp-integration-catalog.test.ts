/**
 * Contract coverage for the MCP integration catalog trust/health/kill-switch
 * policy across the public catalog routes and the transport gateway.
 * Deterministic harness: external collaborators (auth, community registry,
 * upstream forwarding, logger) are protocol-faithful mocks; the routes and the
 * policy module under test are real.
 */

import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getCurrentUser = mock(async () => null);
mock.module("@/lib/auth/workers-hono-auth", () => ({ getCurrentUser }));

const listPublic = mock(async () => []);
const toRegistryFormat = mock();
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: { listPublic, toRegistryFormat },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: mock(), error: mock(), info: mock(), warn: mock() },
}));

const forwardMcpUpstreamRequest = mock(
  async () =>
    new Response(JSON.stringify({ forwarded: true }), { status: 200 }),
);
mock.module("@/lib/mcp/mcp-upstream-forward", () => ({
  forwardMcpUpstreamRequest,
}));

const {
  integrationHealth,
  isKillSwitched,
  parseKillSwitch,
  plannerVisibleCapabilities,
  plannerVisibleFeatures,
  providerSlugFromEndpoint,
  resolveIntegrationAvailability,
} = await import("../src/lib/mcp/integration-catalog");
const registryRoute = (await import("../mcp/registry/route")).default;
const listRoute = (await import("../mcp/list/route")).default;
const { createMcpsTransportApp } = await import(
  "../src/lib/mcp/mcps-transport-gateway"
);

interface RegistryEntry {
  id: string;
  availability: string;
  health: string;
  status: string;
  features: string[];
  fullEndpoint: string;
  configTemplate: { servers: Record<string, unknown> };
  trust: {
    publisher: string;
    provenance: string;
    authMode: string;
    domains: string[];
    reviewedAt: string;
    capabilities: Array<{ name: string; access: string; reviewed: boolean }>;
  };
}

async function fetchRegistry(env: Record<string, string> = {}) {
  const response = await registryRoute.request("/", undefined, {
    NEXT_PUBLIC_APP_URL: "https://app.example.test",
    ...env,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { registry: RegistryEntry[] };
}

function transportApp(provider: string) {
  const host = new Hono();
  host.route("/:transport", createMcpsTransportApp(provider));
  return host;
}

test("parseKillSwitch sanitizes malformed operator input to an inert switch", () => {
  expect(parseKillSwitch(undefined).all).toBe(false);
  expect(parseKillSwitch(undefined).ids.size).toBe(0);
  expect(parseKillSwitch(42).ids.size).toBe(0);
  expect(parseKillSwitch("  ,, ,").ids.size).toBe(0);
  const parsed = parseKillSwitch(" GitHub , crypto-prices ");
  expect(parsed.all).toBe(false);
  expect(parsed.ids.has("github")).toBe(true);
  expect(parsed.ids.has("crypto-prices")).toBe(true);
  expect(parseKillSwitch("all").all).toBe(true);
  expect(parseKillSwitch("time,*").all).toBe(true);
});

test("kill switch matches catalog ids, provider slugs, and slug aliases", () => {
  const env = { MCP_KILL_SWITCH: "crypto-prices" };
  expect(isKillSwitched(env, "crypto-prices", "crypto")).toBe(true);
  expect(isKillSwitched(env, "crypto", "crypto")).toBe(true);
  expect(isKillSwitched(env, "time-server", "time")).toBe(false);
  expect(isKillSwitched({ MCP_KILL_SWITCH: "all" }, "anything", null)).toBe(
    true,
  );
});

test("availability derives from the transport contract", () => {
  expect(providerSlugFromEndpoint("/api/mcps/github/streamable-http")).toBe(
    "github",
  );
  expect(providerSlugFromEndpoint("/api/mcp")).toBeNull();
  expect(resolveIntegrationAvailability({}, "eliza-platform", "/api/mcp")).toBe(
    "available",
  );
  expect(
    resolveIntegrationAvailability(
      {},
      "time-server",
      "/api/mcps/time/streamable-http",
    ),
  ).toBe("available");
  expect(
    resolveIntegrationAvailability(
      {},
      "github",
      "/api/mcps/github/streamable-http",
    ),
  ).toBe("unconfigured");
  expect(
    resolveIntegrationAvailability(
      { MCP_GITHUB_STREAMABLE_HTTP_URL: "https://mcp.example.test/github" },
      "github",
      "/api/mcps/github/streamable-http",
    ),
  ).toBe("available");
  expect(
    resolveIntegrationAvailability(
      { MCP_GITHUB_STREAMABLE_HTTP_URL: "   " },
      "github",
      "/api/mcps/github/streamable-http",
    ),
  ).toBe("unconfigured");
  expect(
    resolveIntegrationAvailability(
      { MCP_KILL_SWITCH: "time" },
      "time-server",
      "/api/mcps/time/streamable-http",
    ),
  ).toBe("disabled");
});

test("unreviewed writes are hidden from planner-visible capabilities", () => {
  const capabilities = [
    { name: "read_ok", access: "read" as const, reviewed: true },
    { name: "read_unreviewed", access: "read" as const, reviewed: false },
    { name: "write_ok", access: "write" as const, reviewed: true },
    { name: "write_unreviewed", access: "write" as const, reviewed: false },
  ];
  const visible = plannerVisibleCapabilities(capabilities).map((c) => c.name);
  expect(visible).toEqual(["read_ok", "read_unreviewed", "write_ok"]);
  const trust = {
    publisher: "test",
    provenance: "first-party" as const,
    authMode: "none" as const,
    domains: [],
    reviewedAt: "2026-08-20",
    capabilities,
  };
  expect(
    plannerVisibleFeatures(trust, [
      "write_unreviewed",
      "write_ok",
      "not_in_trust_record",
    ]),
  ).toEqual(["write_ok"]);
});

test("health reflects availability and provenance", () => {
  expect(integrationHealth("available", "first-party")).toBe("operational");
  expect(integrationHealth("available", "operator-proxied")).toBe("unknown");
  expect(integrationHealth("disabled", "first-party")).toBe("unavailable");
});

test("registry never advertises unconfigured integrations", async () => {
  const body = await fetchRegistry();
  const ids = body.registry.map((entry) => entry.id);
  expect(ids).toContain("crypto-prices");
  expect(ids).toContain("time-server");
  expect(ids).toContain("weather");
  expect(ids).toContain("eliza-platform");
  expect(ids).not.toContain("github");
  expect(ids).not.toContain("linear");
  expect(ids).not.toContain("notion");
  expect(ids).not.toContain("web-search");
});

test("registry advertises an operator-proxied integration once configured, with trust metadata", async () => {
  const body = await fetchRegistry({
    MCP_GITHUB_STREAMABLE_HTTP_URL: "https://mcp.example.test/github",
  });
  const github = body.registry.find((entry) => entry.id === "github");
  expect(github).toBeDefined();
  if (!github) throw new Error("github entry missing");
  expect(github.availability).toBe("available");
  expect(github.health).toBe("unknown");
  expect(github.trust.provenance).toBe("operator-proxied");
  expect(github.trust.authMode).toBe("oauth");
  expect(github.trust.domains).toContain("api.github.com");
  expect(github.trust.reviewedAt.length).toBeGreaterThan(0);
  expect(github.fullEndpoint).toBe(
    "https://app.example.test/api/mcps/github/streamable-http",
  );
});

test("kill-switched registry entry is listed as disabled with connection surface withheld", async () => {
  const body = await fetchRegistry({ MCP_KILL_SWITCH: "crypto-prices" });
  const crypto = body.registry.find((entry) => entry.id === "crypto-prices");
  expect(crypto).toBeDefined();
  if (!crypto) throw new Error("crypto entry missing");
  expect(crypto.availability).toBe("disabled");
  expect(crypto.health).toBe("unavailable");
  expect(crypto.status).toBe("maintenance");
  expect(crypto.features).toEqual([]);
  expect(Object.keys(crypto.configTemplate.servers)).toEqual([]);
  expect(crypto.fullEndpoint).toBe("");
  const time = body.registry.find((entry) => entry.id === "time-server");
  expect(time?.availability).toBe("available");
});

test("global kill switch disables every platform entry", async () => {
  const body = await fetchRegistry({ MCP_KILL_SWITCH: "all" });
  expect(body.registry.length).toBeGreaterThan(0);
  for (const entry of body.registry) {
    expect(entry.availability).toBe("disabled");
    expect(entry.features).toEqual([]);
  }
});

test("mcp list annotates definitions and hides tools for kill-switched entries", async () => {
  const okResponse = await listRoute.request("/", undefined, {});
  expect(okResponse.status).toBe(200);
  const okBody = (await okResponse.json()) as {
    mcps: Array<{
      id: string;
      availability: string;
      health: string;
      tools: unknown[];
      trust: { provenance: string };
    }>;
    total: number;
  };
  expect(okBody.total).toBe(okBody.mcps.length);
  const platform = okBody.mcps.find((m) => m.id === "eliza-cloud-mcp");
  expect(platform?.availability).toBe("available");
  expect(platform?.health).toBe("operational");
  expect(platform?.tools.length).toBeGreaterThan(0);

  const killedResponse = await listRoute.request("/", undefined, {
    MCP_KILL_SWITCH: "weather-mcp",
  });
  const killedBody = (await killedResponse.json()) as {
    mcps: Array<{ id: string; availability: string; tools: unknown[] }>;
  };
  const weather = killedBody.mcps.find((m) => m.id === "weather-mcp");
  expect(weather?.availability).toBe("disabled");
  expect(weather?.tools).toEqual([]);
});

test("gateway rejects kill-switched providers with 503 before serving or forwarding", async () => {
  forwardMcpUpstreamRequest.mockClear();
  const time = transportApp("time");
  const killed = await time.request(
    "/streamable-http",
    { method: "POST" },
    {
      MCP_KILL_SWITCH: "time",
    },
  );
  expect(killed.status).toBe(503);
  const killedBody = (await killed.json()) as { error: string };
  expect(killedBody.error).toBe("integration_disabled");

  const github = transportApp("github");
  const killedProxy = await github.request(
    "/streamable-http",
    { method: "POST" },
    {
      MCP_KILL_SWITCH: "github",
      MCP_GITHUB_STREAMABLE_HTTP_URL: "https://mcp.example.test/github",
    },
  );
  expect(killedProxy.status).toBe(503);
  expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
});

test("gateway still answers 501 for unconfigured non-builtin providers and forwards configured ones", async () => {
  forwardMcpUpstreamRequest.mockClear();
  const github = transportApp("github");
  const unconfigured = await github.request(
    "/streamable-http",
    { method: "POST" },
    {},
  );
  expect(unconfigured.status).toBe(501);

  const configured = await github.request(
    "/streamable-http",
    { method: "POST" },
    { MCP_GITHUB_STREAMABLE_HTTP_URL: "https://mcp.example.test/github" },
  );
  expect(configured.status).toBe(200);
  expect(forwardMcpUpstreamRequest).toHaveBeenCalledTimes(1);
});
