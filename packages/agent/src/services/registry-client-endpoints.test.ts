/**
 * Behavioral coverage for custom-registry endpoint URL normalisation, SSRF
 * pre-screening, default-field folding, and merge-without-override rules.
 * `fetchWithSsrfGuard` and `dns.lookup` are stubbed as network seams only;
 * parse, private-IP policy, and map mutation run on the real module.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { fetchWithSsrfGuard, logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryEndpoint } from "../config/types.eliza.ts";
import {
  isDefaultEndpoint,
  mergeCustomEndpoints,
  normaliseEndpointUrl,
  parseRegistryEndpointUrl,
} from "./registry-client-endpoints.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn() };
});

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    fetchWithSsrfGuard: vi.fn(),
  };
});

const PUBLIC_IPV4_URL = "https://1.1.1.1/registry";
const SECOND_IPV4_URL = "https://8.8.8.8/registry";
const HOSTNAME_URL = "https://plugins.example.test/registry";

type Guarded = Awaited<ReturnType<typeof fetchWithSsrfGuard>>;

function seededPlugin(name: string): RegistryPluginInfo {
  return {
    name,
    gitRepo: "seed/repo",
    gitUrl: "https://github.com/seed/repo.git",
    directory: null,
    description: "seeded",
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
    git: {
      v0Branch: null,
      v1Branch: null,
      v2Branch: null,
    },
    supports: { v0: false, v1: false, v2: false },
  };
}

function guardedResult(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string },
): Guarded {
  return {
    response: {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      statusText: init?.statusText ?? "OK",
      json: async () => body,
    } as unknown as Response,
    finalUrl: PUBLIC_IPV4_URL,
    release: vi.fn(async () => undefined),
  };
}

function endpoint(
  url: string,
  label = "custom",
  enabled?: boolean,
): RegistryEndpoint {
  if (enabled === undefined) {
    return { label, url };
  }
  return { label, url, enabled };
}

describe("normaliseEndpointUrl", () => {
  it("leaves a URL without a trailing slash unchanged", () => {
    expect(normaliseEndpointUrl("https://example.com/registry")).toBe(
      "https://example.com/registry",
    );
  });

  it("strips a single trailing slash", () => {
    expect(normaliseEndpointUrl("https://example.com/")).toBe(
      "https://example.com",
    );
  });

  it("strips a run of trailing slashes up to 1024", () => {
    expect(normaliseEndpointUrl(`https://example.com${"/".repeat(3)}`)).toBe(
      "https://example.com",
    );
    expect(normaliseEndpointUrl(`https://example.com${"/".repeat(1024)}`)).toBe(
      "https://example.com",
    );
  });

  it("leaves a leftover slash when more than 1024 trailing slashes are present", () => {
    expect(normaliseEndpointUrl(`https://example.com${"/".repeat(1025)}`)).toBe(
      "https://example.com/",
    );
    expect(normaliseEndpointUrl(`https://example.com${"/".repeat(1026)}`)).toBe(
      "https://example.com//",
    );
  });

  it("does not strip interior slashes or query text", () => {
    expect(normaliseEndpointUrl("https://example.com/a/b")).toBe(
      "https://example.com/a/b",
    );
    expect(normaliseEndpointUrl("https://example.com/a/?q=1")).toBe(
      "https://example.com/a/?q=1",
    );
  });

  it("turns a slash-only string into empty and leaves empty input empty", () => {
    expect(normaliseEndpointUrl("///")).toBe("");
    expect(normaliseEndpointUrl("")).toBe("");
  });
});

describe("isDefaultEndpoint", () => {
  it("treats trailing-slash variants as the same endpoint", () => {
    expect(
      isDefaultEndpoint(
        "https://example.com/registry/",
        "https://example.com/registry",
      ),
    ).toBe(true);
  });

  it("is a case-sensitive string compare, not a URL-canonical fold", () => {
    expect(
      isDefaultEndpoint(
        "https://Example.com/registry",
        "https://example.com/registry",
      ),
    ).toBe(false);
  });

  it("rejects distinct hosts even after slash stripping", () => {
    expect(
      isDefaultEndpoint("https://a.example.com/", "https://b.example.com/"),
    ).toBe(false);
  });

  it("treats two empty strings as equal", () => {
    expect(isDefaultEndpoint("", "")).toBe(true);
  });
});

describe("parseRegistryEndpointUrl", () => {
  it("accepts a public https hostname", () => {
    const parsed = parseRegistryEndpointUrl(
      "https://plugins.example.com/registry",
    );
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("plugins.example.com");
  });

  it("accepts a public IPv4 literal", () => {
    expect(parseRegistryEndpointUrl(PUBLIC_IPV4_URL).hostname).toBe("1.1.1.1");
  });

  it("accepts a public IPv6 literal", () => {
    const parsed = parseRegistryEndpointUrl(
      "https://[2001:4860:4860::8888]/registry",
    );
    expect(parsed.hostname).toBe("[2001:4860:4860::8888]");
  });

  it("rejects a relative or empty value as not an absolute URL", () => {
    expect(() => parseRegistryEndpointUrl("not-a-url")).toThrow(
      "Endpoint URL must be a valid absolute URL",
    );
    expect(() => parseRegistryEndpointUrl("")).toThrow(
      "Endpoint URL must be a valid absolute URL",
    );
    expect(() => parseRegistryEndpointUrl("/relative")).toThrow(
      "Endpoint URL must be a valid absolute URL",
    );
  });

  it("rejects any protocol other than https", () => {
    expect(() =>
      parseRegistryEndpointUrl("http://example.com/registry"),
    ).toThrow("Endpoint URL must use https://");
    expect(() =>
      parseRegistryEndpointUrl("ftp://example.com/registry"),
    ).toThrow("Endpoint URL must use https://");
    expect(() =>
      parseRegistryEndpointUrl("wss://example.com/registry"),
    ).toThrow("Endpoint URL must use https://");
  });

  it("blocks loopback and metadata host literals", () => {
    expect(() =>
      parseRegistryEndpointUrl("https://localhost/registry"),
    ).toThrow('Endpoint host "localhost" is blocked');
    expect(() =>
      parseRegistryEndpointUrl("https://127.0.0.1/registry"),
    ).toThrow('Endpoint host "127.0.0.1" is blocked');
    expect(() => parseRegistryEndpointUrl("https://[::1]/registry")).toThrow(
      'Endpoint host "::1" is blocked',
    );
    expect(() => parseRegistryEndpointUrl("https://0.0.0.0/registry")).toThrow(
      'Endpoint host "0.0.0.0" is blocked',
    );
    expect(() =>
      parseRegistryEndpointUrl("https://169.254.169.254/registry"),
    ).toThrow('Endpoint host "169.254.169.254" is blocked');
  });

  it("blocks .localhost and .local suffixes, but not .internal", () => {
    expect(() =>
      parseRegistryEndpointUrl("https://plugins.localhost/registry"),
    ).toThrow('Endpoint host "plugins.localhost" is blocked');
    expect(() =>
      parseRegistryEndpointUrl("https://plugins.local/registry"),
    ).toThrow('Endpoint host "plugins.local" is blocked');
    expect(
      parseRegistryEndpointUrl("https://metadata.google.internal/registry")
        .hostname,
    ).toBe("metadata.google.internal");
  });

  it("blocks RFC1918, link-local, CGNAT, and unique-local IP literals", () => {
    expect(() => parseRegistryEndpointUrl("https://10.0.0.1/registry")).toThrow(
      'Endpoint host "10.0.0.1" is blocked',
    );
    expect(() =>
      parseRegistryEndpointUrl("https://192.168.1.5/registry"),
    ).toThrow('Endpoint host "192.168.1.5" is blocked');
    expect(() =>
      parseRegistryEndpointUrl("https://172.16.0.1/registry"),
    ).toThrow('Endpoint host "172.16.0.1" is blocked');
    expect(() =>
      parseRegistryEndpointUrl("https://169.254.1.1/registry"),
    ).toThrow('Endpoint host "169.254.1.1" is blocked');
    expect(() =>
      parseRegistryEndpointUrl("https://100.64.0.1/registry"),
    ).toThrow('Endpoint host "100.64.0.1" is blocked');
    expect(() =>
      parseRegistryEndpointUrl("https://[fc00::1]/registry"),
    ).toThrow('Endpoint host "fc00::1" is blocked');
    expect(() =>
      parseRegistryEndpointUrl("https://[fe80::1]/registry"),
    ).toThrow('Endpoint host "fe80::1" is blocked');
  });

  it("blocks an octal loopback after the URL parser canonicalises it to 127.0.0.1", () => {
    expect(() =>
      parseRegistryEndpointUrl("https://0177.0.0.1/registry"),
    ).toThrow('Endpoint host "127.0.0.1" is blocked');
  });
});

describe("mergeCustomEndpoints", () => {
  beforeEach(() => {
    vi.mocked(fetchWithSsrfGuard).mockReset();
    vi.mocked(dnsLookup).mockReset();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns immediately for an empty endpoint list", async () => {
    const plugins = new Map<string, RegistryPluginInfo>([
      ["seed", seededPlugin("seed")],
    ]);
    await mergeCustomEndpoints(plugins, []);
    expect(fetchWithSsrfGuard).not.toHaveBeenCalled();
    expect([...plugins.keys()]).toEqual(["seed"]);
  });

  it("returns immediately when every endpoint is disabled", async () => {
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [
      endpoint(PUBLIC_IPV4_URL, "off", false),
    ]);
    expect(fetchWithSsrfGuard).not.toHaveBeenCalled();
    expect(plugins.size).toBe(0);
  });

  it("treats a missing enabled flag as enabled", async () => {
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(
      guardedResult({ registry: {} }),
    );
    await mergeCustomEndpoints(new Map(), [endpoint(PUBLIC_IPV4_URL)]);
    expect(fetchWithSsrfGuard).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrfGuard).toHaveBeenCalledWith({
      url: PUBLIC_IPV4_URL,
      maxRedirects: 0,
      timeoutMs: 2500,
    });
  });

  it("folds a single endpoint's registry into an empty map with defaults", async () => {
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(
      guardedResult({ registry: { "plugin-a": {} } }),
    );
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [endpoint(PUBLIC_IPV4_URL, "one")]);

    expect(plugins.size).toBe(1);
    expect(plugins.get("plugin-a")).toEqual({
      name: "plugin-a",
      gitRepo: "unknown/unknown",
      gitUrl: "https://github.com/unknown/unknown.git",
      directory: null,
      description: "",
      homepage: null,
      topics: [],
      stars: 0,
      language: "TypeScript",
      npm: {
        package: "plugin-a",
        v0Version: null,
        v1Version: null,
        v2Version: null,
      },
      git: {
        v0Branch: null,
        v1Branch: null,
        v2Branch: null,
      },
      supports: { v0: false, v1: false, v2: false },
      kind: undefined,
      registryKind: undefined,
      origin: undefined,
      source: undefined,
      support: undefined,
      builtIn: undefined,
      firstParty: undefined,
      thirdParty: undefined,
      status: undefined,
    });
  });

  it("maps supplied git, npm, and metadata fields through without inventing values", async () => {
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(
      guardedResult({
        registry: {
          "@scope/plug": {
            git: {
              repo: "elizaos/plug",
              v0: { branch: "v0" },
              v1: { branch: "v1" },
              v2: { branch: "v2" },
            },
            npm: {
              repo: "@elizaos/plug",
              v0: "0.1.0",
              v1: "1.2.3",
              v2: "2.0.0",
            },
            supports: { v0: true, v1: true, v2: false },
            directory: "packages/plug",
            description: "A plugin",
            homepage: "https://example.com",
            topics: ["ai"],
            stargazers_count: 7,
            language: "Go",
            kind: "plugin",
            registryKind: "community",
            origin: "third-party",
            source: "custom",
            support: "community",
            builtIn: false,
            firstParty: false,
            thirdParty: true,
            status: "active",
          },
        },
      }),
    );
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [endpoint(PUBLIC_IPV4_URL)]);
    expect(plugins.get("@scope/plug")).toEqual({
      name: "@scope/plug",
      gitRepo: "elizaos/plug",
      gitUrl: "https://github.com/elizaos/plug.git",
      directory: "packages/plug",
      description: "A plugin",
      homepage: "https://example.com",
      topics: ["ai"],
      stars: 7,
      language: "Go",
      npm: {
        package: "@elizaos/plug",
        v0Version: "0.1.0",
        v1Version: "1.2.3",
        v2Version: "2.0.0",
      },
      git: {
        v0Branch: "v0",
        v1Branch: "v1",
        v2Branch: "v2",
      },
      supports: { v0: true, v1: true, v2: false },
      kind: "plugin",
      registryKind: "community",
      origin: "third-party",
      source: "custom",
      support: "community",
      builtIn: false,
      firstParty: false,
      thirdParty: true,
      status: "active",
    });
  });

  it("never overrides a name already present in the seed map", async () => {
    const original = seededPlugin("plugin-a");
    const plugins = new Map<string, RegistryPluginInfo>([
      ["plugin-a", original],
    ]);
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(
      guardedResult({
        registry: {
          "plugin-a": { description: "from-custom" },
          "plugin-b": { description: "new" },
        },
      }),
    );
    await mergeCustomEndpoints(plugins, [endpoint(PUBLIC_IPV4_URL)]);
    expect(plugins.get("plugin-a")).toBe(original);
    expect(plugins.get("plugin-a")?.description).toBe("seeded");
    expect(plugins.get("plugin-b")?.description).toBe("new");
    expect(logger.warn).toHaveBeenCalledWith(
      "[registry-client] Ignoring custom endpoint override for plugin-a",
    );
  });

  it("does not remove a seed name that the custom payload omits", async () => {
    const plugins = new Map<string, RegistryPluginInfo>([
      ["keep-me", seededPlugin("keep-me")],
    ]);
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(
      guardedResult({ registry: { other: { description: "added" } } }),
    );
    await mergeCustomEndpoints(plugins, [endpoint(PUBLIC_IPV4_URL)]);
    expect(plugins.has("keep-me")).toBe(true);
    expect(plugins.has("other")).toBe(true);
  });

  it("lets the earlier endpoint win when two custom payloads share a new name", async () => {
    vi.mocked(fetchWithSsrfGuard)
      .mockResolvedValueOnce(
        guardedResult({
          registry: { shared: { description: "first" } },
        }),
      )
      .mockResolvedValueOnce(
        guardedResult({
          registry: {
            shared: { description: "second" },
            extra: { description: "from-second" },
          },
        }),
      );
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [
      endpoint(PUBLIC_IPV4_URL, "first"),
      endpoint(SECOND_IPV4_URL, "second"),
    ]);
    expect(plugins.get("shared")?.description).toBe("first");
    expect(plugins.get("extra")?.description).toBe("from-second");
  });

  it("skips a failing earlier endpoint so a later one can supply the name", async () => {
    vi.mocked(fetchWithSsrfGuard)
      .mockResolvedValueOnce(
        guardedResult(
          { error: "nope" },
          { ok: false, status: 500, statusText: "ERR" },
        ),
      )
      .mockResolvedValueOnce(
        guardedResult({
          registry: { recovered: { description: "from-second" } },
        }),
      );
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [
      endpoint(PUBLIC_IPV4_URL, "down"),
      endpoint(SECOND_IPV4_URL, "up"),
    ]);
    expect(plugins.get("recovered")?.description).toBe("from-second");
  });

  it("releases the guarded response on a non-OK status and adds nothing", async () => {
    const result = guardedResult(
      {},
      { ok: false, status: 404, statusText: "No" },
    );
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(result);
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [endpoint(PUBLIC_IPV4_URL, "missing")]);
    expect(plugins.size).toBe(0);
    expect(result.release).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      `[registry-client] Endpoint "missing" (${PUBLIC_IPV4_URL}): 404 No`,
    );
  });

  it("warns and skips a payload with no registry object", async () => {
    const result = guardedResult({ plugins: {} });
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(result);
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [endpoint(PUBLIC_IPV4_URL, "empty")]);
    expect(plugins.size).toBe(0);
    expect(result.release).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      `[registry-client] Endpoint "empty" (${PUBLIC_IPV4_URL}): missing registry field`,
    );
  });

  it("releases then degrades when json() throws", async () => {
    const release = vi.fn(async () => undefined);
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response,
      finalUrl: PUBLIC_IPV4_URL,
      release,
    });
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [
      endpoint(PUBLIC_IPV4_URL, "bad-json"),
    ]);
    expect(plugins.size).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      `[registry-client] Endpoint "bad-json" (${PUBLIC_IPV4_URL}) failed: Error: not json`,
    );
  });

  it("degrades a thrown fetch to a warning without adding plugins", async () => {
    vi.mocked(fetchWithSsrfGuard).mockRejectedValue(new Error("connect reset"));
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [endpoint(PUBLIC_IPV4_URL, "boom")]);
    expect(plugins.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      `[registry-client] Endpoint "boom" (${PUBLIC_IPV4_URL}) failed: Error: connect reset`,
    );
  });

  it("does not fetch a URL that fails parse-time SSRF screening", async () => {
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [
      endpoint("http://example.com/registry", "insecure"),
    ]);
    expect(fetchWithSsrfGuard).not.toHaveBeenCalled();
    expect(plugins.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '[registry-client] Endpoint "insecure" (http://example.com/registry) blocked: Error: Endpoint URL must use https://',
    );
  });

  it("does not fetch when DNS cannot resolve the hostname", async () => {
    vi.mocked(dnsLookup).mockRejectedValue(new Error("ENOTFOUND"));
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [endpoint(HOSTNAME_URL, "unresolved")]);
    expect(fetchWithSsrfGuard).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      `[registry-client] Endpoint "unresolved" (${HOSTNAME_URL}) blocked: Could not resolve endpoint host "plugins.example.test"`,
    );
  });

  it("does not fetch when DNS returns no addresses", async () => {
    vi.mocked(dnsLookup).mockResolvedValue([] as never);
    await mergeCustomEndpoints(new Map(), [
      endpoint(HOSTNAME_URL, "empty-dns"),
    ]);
    expect(fetchWithSsrfGuard).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      `[registry-client] Endpoint "empty-dns" (${HOSTNAME_URL}) blocked: Could not resolve endpoint host "plugins.example.test"`,
    );
  });

  it("does not fetch when any resolved address is private", async () => {
    vi.mocked(dnsLookup).mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.9", family: 4 },
    ] as never);
    await mergeCustomEndpoints(new Map(), [
      endpoint(HOSTNAME_URL, "rebinding"),
    ]);
    expect(fetchWithSsrfGuard).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      `[registry-client] Endpoint "rebinding" (${HOSTNAME_URL}) blocked: Endpoint host "plugins.example.test" resolves to blocked address 10.0.0.9`,
    );
  });

  it("fetches after a public DNS answer, including a non-array lookup result", async () => {
    vi.mocked(dnsLookup).mockResolvedValue({
      address: "1.1.1.1",
      family: 4,
    } as never);
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(
      guardedResult({ registry: { "from-dns": { description: "ok" } } }),
    );
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [endpoint(HOSTNAME_URL, "dns")]);
    expect(dnsLookup).toHaveBeenCalledWith("plugins.example.test", {
      all: true,
    });
    expect(fetchWithSsrfGuard).toHaveBeenCalledTimes(1);
    expect(plugins.get("from-dns")?.description).toBe("ok");
  });

  it("skips a disabled peer while still merging the enabled one", async () => {
    vi.mocked(fetchWithSsrfGuard).mockResolvedValue(
      guardedResult({ registry: { only: { description: "enabled" } } }),
    );
    const plugins = new Map<string, RegistryPluginInfo>();
    await mergeCustomEndpoints(plugins, [
      endpoint(PUBLIC_IPV4_URL, "off", false),
      endpoint(SECOND_IPV4_URL, "on", true),
    ]);
    expect(fetchWithSsrfGuard).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrfGuard).toHaveBeenCalledWith({
      url: SECOND_IPV4_URL,
      maxRedirects: 0,
      timeoutMs: 2500,
    });
    expect(plugins.get("only")?.description).toBe("enabled");
  });
});
