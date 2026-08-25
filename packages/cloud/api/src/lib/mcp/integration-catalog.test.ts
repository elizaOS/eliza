/**
 * Unit tests for MCP integration-catalog trust, kill-switch, and
 * availability policy. The suite drives the real module with no mocks and
 * records every exported function: env-key slugging, endpoint provider
 * extraction, kill-switch parsing, alias matching, availability, health,
 * and planner-visible capability/feature filtering. There is no queue,
 * capacity, or comparator — empty input, a single token, and a missing
 * kill-switch id are the corresponding edges, observed as implemented.
 */

import { describe, expect, test } from "vitest";
import {
  INTEGRATION_TRUST,
  type IntegrationCapability,
  type IntegrationTrust,
  integrationHealth,
  isKillSwitched,
  parseKillSwitch,
  plannerVisibleCapabilities,
  plannerVisibleFeatures,
  providerSlugFromEndpoint,
  resolveIntegrationAvailability,
  upstreamEnvKeyForProvider,
} from "./integration-catalog";

function cap(
  name: string,
  access: "read" | "write",
  reviewed: boolean,
): IntegrationCapability {
  return { name, access, reviewed };
}

function trustWith(
  capabilities: readonly IntegrationCapability[],
): IntegrationTrust {
  return {
    publisher: "test",
    provenance: "first-party",
    authMode: "none",
    domains: [],
    reviewedAt: "2026-08-20",
    capabilities,
  };
}

describe("INTEGRATION_TRUST", () => {
  test("lists every first-party catalog id, including list/registry aliases", () => {
    expect(Object.keys(INTEGRATION_TRUST)).toEqual([
      "eliza-platform",
      "eliza-cloud-mcp",
      "time-server",
      "time-mcp",
      "weather",
      "weather-mcp",
      "crypto-prices",
      "crypto-mcp",
      "doordash",
      "web-search",
      "linear",
      "notion",
      "github",
    ]);
  });

  test("alias catalog ids share the same trust record object", () => {
    expect(INTEGRATION_TRUST["eliza-platform"]).toBe(
      INTEGRATION_TRUST["eliza-cloud-mcp"],
    );
    expect(INTEGRATION_TRUST["time-server"]).toBe(
      INTEGRATION_TRUST["time-mcp"],
    );
    expect(INTEGRATION_TRUST.weather).toBe(INTEGRATION_TRUST["weather-mcp"]);
    expect(INTEGRATION_TRUST["crypto-prices"]).toBe(
      INTEGRATION_TRUST["crypto-mcp"],
    );
  });

  test("every entry has publisher, provenance, auth, domains, review date, and capabilities", () => {
    for (const [id, trust] of Object.entries(INTEGRATION_TRUST)) {
      expect(trust.publisher.length, id).toBeGreaterThan(0);
      expect(
        ["first-party", "operator-proxied", "community"].includes(
          trust.provenance,
        ),
        id,
      ).toBe(true);
      expect(
        ["none", "session", "api-key", "oauth"].includes(trust.authMode),
        id,
      ).toBe(true);
      expect(Array.isArray(trust.domains), id).toBe(true);
      expect(trust.reviewedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(trust.capabilities.length, id).toBeGreaterThan(0);
      for (const capability of trust.capabilities) {
        expect(
          capability.name.length,
          `${id}:${capability.name}`,
        ).toBeGreaterThan(0);
        expect(["read", "write"].includes(capability.access)).toBe(true);
        expect(typeof capability.reviewed).toBe("boolean");
      }
    }
  });

  test("on-platform first-party tools have empty domains; proxied tools name their upstreams", () => {
    expect(INTEGRATION_TRUST["eliza-platform"].domains).toEqual([]);
    expect(INTEGRATION_TRUST["time-server"].domains).toEqual([]);
    expect(INTEGRATION_TRUST.weather.domains).toEqual([
      "api.open-meteo.com",
      "geocoding-api.open-meteo.com",
    ]);
    expect(INTEGRATION_TRUST["crypto-prices"].domains).toEqual([
      "api.coingecko.com",
    ]);
    expect(INTEGRATION_TRUST.github.provenance).toBe("operator-proxied");
    expect(INTEGRATION_TRUST.github.authMode).toBe("oauth");
    expect(INTEGRATION_TRUST.github.domains).toEqual(["api.github.com"]);
    expect(INTEGRATION_TRUST["web-search"].provenance).toBe("operator-proxied");
    expect(INTEGRATION_TRUST.doordash.authMode).toBe("api-key");
  });
});

describe("upstreamEnvKeyForProvider", () => {
  test("uppercases the provider and wraps it in the streamable-http env contract", () => {
    expect(upstreamEnvKeyForProvider("github")).toBe(
      "MCP_GITHUB_STREAMABLE_HTTP_URL",
    );
    expect(upstreamEnvKeyForProvider("GitHub")).toBe(
      "MCP_GITHUB_STREAMABLE_HTTP_URL",
    );
  });

  test("replaces every non-alphanumeric character with an underscore, including the empty slug", () => {
    expect(upstreamEnvKeyForProvider("web-search")).toBe(
      "MCP_WEB_SEARCH_STREAMABLE_HTTP_URL",
    );
    expect(upstreamEnvKeyForProvider("door.dash")).toBe(
      "MCP_DOOR_DASH_STREAMABLE_HTTP_URL",
    );
    expect(upstreamEnvKeyForProvider("")).toBe("MCP__STREAMABLE_HTTP_URL");
  });
});

describe("providerSlugFromEndpoint", () => {
  test("extracts the /api/mcps/<provider>/ slug and lowercases it", () => {
    expect(providerSlugFromEndpoint("/api/mcps/github/streamable-http")).toBe(
      "github",
    );
    expect(providerSlugFromEndpoint("/api/mcps/GitHub/streamable-http")).toBe(
      "github",
    );
    expect(
      providerSlugFromEndpoint("https://app.example.test/api/mcps/linear/sse"),
    ).toBe("linear");
    expect(providerSlugFromEndpoint("/api/mcps/foo-2/bar")).toBe("foo-2");
  });

  test("accepts a slug at end-of-string or with a trailing slash", () => {
    expect(providerSlugFromEndpoint("/api/mcps/time")).toBe("time");
    expect(providerSlugFromEndpoint("/api/mcps/time/")).toBe("time");
  });

  test("returns null when the path is not a transport slug (missing item)", () => {
    expect(providerSlugFromEndpoint("/api/mcp")).toBeNull();
    expect(providerSlugFromEndpoint("/api/mcps/")).toBeNull();
    expect(providerSlugFromEndpoint("nope")).toBeNull();
    expect(providerSlugFromEndpoint("")).toBeNull();
  });

  test("does not treat a query string or underscore as a slug terminator match", () => {
    // Observed: the regex requires `/` or end-of-string after the slug.
    expect(providerSlugFromEndpoint("/api/mcps/github?x=1")).toBeNull();
    expect(providerSlugFromEndpoint("/api/mcps/foo_bar")).toBeNull();
  });

  test("matches an unanchored /api/mcps/ occurrence inside a larger string", () => {
    expect(providerSlugFromEndpoint("x/api/mcps/github")).toBe("github");
  });
});

describe("parseKillSwitch", () => {
  test("non-string or empty operator input becomes an inert switch", () => {
    expect(parseKillSwitch(undefined)).toEqual({ all: false, ids: new Set() });
    expect(parseKillSwitch(null)).toEqual({ all: false, ids: new Set() });
    expect(parseKillSwitch(42)).toEqual({ all: false, ids: new Set() });
    expect(parseKillSwitch(true)).toEqual({ all: false, ids: new Set() });
    expect(parseKillSwitch({ all: true })).toEqual({
      all: false,
      ids: new Set(),
    });
    expect(parseKillSwitch("")).toEqual({ all: false, ids: new Set() });
    expect(parseKillSwitch("  ,, ,")).toEqual({ all: false, ids: new Set() });
  });

  test("trims, lowercases, and deduplicates tokens (single element and duplicates)", () => {
    const parsed = parseKillSwitch(" GitHub , crypto-prices ,github");
    expect(parsed.all).toBe(false);
    expect([...parsed.ids]).toEqual(["github", "crypto-prices"]);
  });

  test("all or * arms the global switch and still keeps the token set", () => {
    expect(parseKillSwitch("all")).toEqual({
      all: true,
      ids: new Set(["all"]),
    });
    expect(parseKillSwitch("ALL")).toEqual({
      all: true,
      ids: new Set(["all"]),
    });
    expect(parseKillSwitch(" All ")).toEqual({
      all: true,
      ids: new Set(["all"]),
    });
    expect(parseKillSwitch("*")).toEqual({ all: true, ids: new Set(["*"]) });
    expect(parseKillSwitch("time,*")).toEqual({
      all: true,
      ids: new Set(["time", "*"]),
    });
  });
});

describe("isKillSwitched", () => {
  test("a global switch disables every catalog id, including a null provider slug", () => {
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "all" }, "eliza-platform", null),
    ).toBe(true);
    expect(isKillSwitched({ MCP_KILL_SWITCH: "*" }, "anything", "github")).toBe(
      true,
    );
  });

  test("matches catalog ids case-insensitively and provider slugs exactly as tokenized", () => {
    expect(isKillSwitched({ MCP_KILL_SWITCH: "github" }, "GitHub", null)).toBe(
      true,
    );
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "github" }, "other", "github"),
    ).toBe(true);
    // Observed: providerSlug is not lowercased; mixed-case slug misses the token.
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "github" }, "other", "GitHub"),
    ).toBe(false);
  });

  test("a null provider slug cannot match aliases after the catalog-id check misses", () => {
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "github" }, "eliza-platform", null),
    ).toBe(false);
  });

  test("provider-slug aliases disable both catalog listings and the transport slug", () => {
    expect(
      isKillSwitched(
        { MCP_KILL_SWITCH: "crypto-prices" },
        "crypto-mcp",
        "crypto",
      ),
    ).toBe(true);
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "time-mcp" }, "time-server", "time"),
    ).toBe(true);
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "weather-mcp" }, "weather", "weather"),
    ).toBe(true);
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "web-search" }, "x", "search"),
    ).toBe(true);
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "search" }, "web-search", "search"),
    ).toBe(true);
  });

  test("a missing kill-switch token leaves the integration enabled", () => {
    expect(isKillSwitched({}, "github", "github")).toBe(false);
    expect(
      isKillSwitched({ MCP_KILL_SWITCH: "nope" }, "github", "github"),
    ).toBe(false);
    expect(
      isKillSwitched(
        { MCP_KILL_SWITCH: "crypto-prices" },
        "time-server",
        "time",
      ),
    ).toBe(false);
  });
});

describe("resolveIntegrationAvailability", () => {
  test("kill switch wins over platform, builtin, and configured upstreams", () => {
    expect(
      resolveIntegrationAvailability(
        { MCP_KILL_SWITCH: "all" },
        "eliza-platform",
        "/api/mcp",
      ),
    ).toBe("disabled");
    expect(
      resolveIntegrationAvailability(
        { MCP_KILL_SWITCH: "time" },
        "time-server",
        "/api/mcps/time/streamable-http",
      ),
    ).toBe("disabled");
    expect(
      resolveIntegrationAvailability(
        {
          MCP_KILL_SWITCH: "github",
          MCP_GITHUB_STREAMABLE_HTTP_URL: "https://mcp.example.test/github",
        },
        "github",
        "/api/mcps/github/streamable-http",
      ),
    ).toBe("disabled");
  });

  test("platform catalog ids are available even without a transport slug", () => {
    expect(
      resolveIntegrationAvailability({}, "eliza-platform", "/api/mcp"),
    ).toBe("available");
    expect(
      resolveIntegrationAvailability({}, "eliza-cloud-mcp", "/api/mcp"),
    ).toBe("available");
  });

  test("platform membership is an exact catalog-id match, not a case fold", () => {
    // Observed: PLATFORM_IDS.has is case-sensitive; mixed-case falls through
    // to the null-slug unconfigured branch.
    expect(
      resolveIntegrationAvailability({}, "Eliza-Platform", "/api/mcp"),
    ).toBe("unconfigured");
  });

  test("a non-platform endpoint without a provider slug is unconfigured", () => {
    expect(resolveIntegrationAvailability({}, "github", "/api/mcp")).toBe(
      "unconfigured",
    );
    expect(resolveIntegrationAvailability({}, "github", "")).toBe(
      "unconfigured",
    );
  });

  test("builtin time/weather/crypto transports are available without upstream env", () => {
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
        "weather",
        "/api/mcps/weather/streamable-http",
      ),
    ).toBe("available");
    expect(
      resolveIntegrationAvailability(
        {},
        "crypto-prices",
        "/api/mcps/crypto/streamable-http",
      ),
    ).toBe("available");
  });

  test("operator-proxied providers require a non-empty trimmed upstream URL", () => {
    expect(
      resolveIntegrationAvailability(
        {},
        "github",
        "/api/mcps/github/streamable-http",
      ),
    ).toBe("unconfigured");
    expect(
      resolveIntegrationAvailability(
        { MCP_GITHUB_STREAMABLE_HTTP_URL: "   " },
        "github",
        "/api/mcps/github/streamable-http",
      ),
    ).toBe("unconfigured");
    expect(
      resolveIntegrationAvailability(
        { MCP_GITHUB_STREAMABLE_HTTP_URL: 1 },
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
        { MCP_SEARCH_STREAMABLE_HTTP_URL: "https://mcp.example.test/search" },
        "web-search",
        "/api/mcps/search/streamable-http",
      ),
    ).toBe("available");
  });

  test("doordash is available when BROWSER is present or a non-empty upstream is set", () => {
    expect(
      resolveIntegrationAvailability(
        {},
        "doordash",
        "/api/mcps/doordash/streamable-http",
      ),
    ).toBe("unconfigured");
    expect(
      resolveIntegrationAvailability(
        { MCP_DOORDASH_STREAMABLE_HTTP_URL: "   " },
        "doordash",
        "/api/mcps/doordash/streamable-http",
      ),
    ).toBe("unconfigured");
    expect(
      resolveIntegrationAvailability(
        {
          MCP_DOORDASH_STREAMABLE_HTTP_URL: "https://mcp.example.test/doordash",
        },
        "doordash",
        "/api/mcps/doordash/streamable-http",
      ),
    ).toBe("available");
    expect(
      resolveIntegrationAvailability(
        { BROWSER: { fetch } },
        "doordash",
        "/api/mcps/doordash/streamable-http",
      ),
    ).toBe("available");
    // Observed: any defined BROWSER value counts, including null / 0 / "".
    expect(
      resolveIntegrationAvailability(
        { BROWSER: null },
        "doordash",
        "/api/mcps/doordash/streamable-http",
      ),
    ).toBe("available");
    expect(
      resolveIntegrationAvailability(
        { BROWSER: 0 },
        "doordash",
        "/api/mcps/doordash/streamable-http",
      ),
    ).toBe("available");
    expect(
      resolveIntegrationAvailability(
        { BROWSER: "" },
        "doordash",
        "/api/mcps/doordash/streamable-http",
      ),
    ).toBe("available");
  });
});

describe("integrationHealth", () => {
  test("only an available first-party integration is operational", () => {
    expect(integrationHealth("available", "first-party")).toBe("operational");
    expect(integrationHealth("available", "operator-proxied")).toBe("unknown");
    expect(integrationHealth("available", "community")).toBe("unknown");
  });

  test("disabled or unconfigured availability is unavailable regardless of provenance", () => {
    expect(integrationHealth("disabled", "first-party")).toBe("unavailable");
    expect(integrationHealth("unconfigured", "first-party")).toBe(
      "unavailable",
    );
    expect(integrationHealth("unconfigured", "community")).toBe("unavailable");
  });
});

describe("plannerVisibleCapabilities", () => {
  test("empty input yields an empty list", () => {
    expect(plannerVisibleCapabilities([])).toEqual([]);
  });

  test("a single reviewed write is visible; a single unreviewed write is not", () => {
    expect(
      plannerVisibleCapabilities([cap("write_ok", "write", true)]),
    ).toEqual([cap("write_ok", "write", true)]);
    expect(
      plannerVisibleCapabilities([cap("write_hidden", "write", false)]),
    ).toEqual([]);
  });

  test("keeps reviewed capabilities and unreviewed reads, in input order", () => {
    const capabilities = [
      cap("read_ok", "read", true),
      cap("read_unreviewed", "read", false),
      cap("write_ok", "write", true),
      cap("write_unreviewed", "write", false),
    ];
    expect(plannerVisibleCapabilities(capabilities).map((c) => c.name)).toEqual(
      ["read_ok", "read_unreviewed", "write_ok"],
    );
  });

  test("every shipped catalog capability is reviewed, so the full list is planner-visible", () => {
    const github = INTEGRATION_TRUST.github.capabilities;
    expect(github.every((capability) => capability.reviewed)).toBe(true);
    expect(plannerVisibleCapabilities(github)).toEqual([...github]);
  });
});

describe("plannerVisibleFeatures", () => {
  test("empty feature list or empty trust capabilities yield no names", () => {
    const populated = trustWith([cap("search", "read", true)]);
    expect(plannerVisibleFeatures(populated, [])).toEqual([]);
    expect(plannerVisibleFeatures(trustWith([]), ["search"])).toEqual([]);
  });

  test("drops names missing from the trust record and unreviewed writes", () => {
    const record = trustWith([
      cap("read_ok", "read", true),
      cap("read_unreviewed", "read", false),
      cap("write_ok", "write", true),
      cap("write_unreviewed", "write", false),
    ]);
    expect(
      plannerVisibleFeatures(record, [
        "write_unreviewed",
        "write_ok",
        "not_in_trust_record",
        "read_unreviewed",
      ]),
    ).toEqual(["write_ok", "read_unreviewed"]);
  });

  test("preserves advertised feature order, including duplicate names", () => {
    const record = trustWith([
      cap("search", "read", true),
      cap("fetch_page", "read", true),
    ]);
    expect(
      plannerVisibleFeatures(record, ["fetch_page", "search", "search"]),
    ).toEqual(["fetch_page", "search", "search"]);
  });
});
