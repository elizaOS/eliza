/**
 * Behavioural coverage for the marketplace registry network-fetch layer:
 * `RegistryNetworkFallbackError`, `isExpectedRegistryNetworkFallback`, and
 * `fetchFromNetwork`. The real module is driven with a stubbed `fetch` and a
 * hoisted cloud-reachability probe so generated-vs-index preference, HTTP
 * fallbacks, overlay ordering, and entry normalisation are asserted without a
 * live cloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFromNetwork,
  isExpectedRegistryNetworkFallback,
  RegistryNetworkFallbackError,
} from "./registry-client-network.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const isCloudReachable = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@elizaos/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@elizaos/shared")>("@elizaos/shared");
  return {
    ...actual,
    isCloudReachable,
  };
});

const GENERATED_URL = "https://registry.example/generated.json";
const INDEX_URL = "https://registry.example/index.json";

const originalFetch = globalThis.fetch;

type FetchFromNetworkParams = Parameters<typeof fetchFromNetwork>[0];

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const recordedUrls: string[] = [];
const recordedInits: Array<RequestInit | undefined> = [];

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = "OK",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function httpResponse(status: number, statusText: string): Response {
  return new Response("", { status, statusText });
}

function generatedEntry(
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    git: {
      repo: "elizaos/plugin-example",
      v0: { branch: null },
      v1: { branch: null },
      v2: { branch: "main" },
    },
    npm: {
      repo: "@elizaos/plugin-example",
      v0: null,
      v1: null,
      v2: "1.2.3",
    },
    supports: { v0: false, v1: false, v2: true },
    description: "Example plugin",
    homepage: "https://example.test",
    topics: ["agent"],
    stargazers_count: 12,
    language: "TypeScript",
    ...extras,
  };
}

function params(
  overrides: Partial<FetchFromNetworkParams> = {},
): FetchFromNetworkParams {
  return {
    generatedRegistryUrl: GENERATED_URL,
    indexRegistryUrl: INDEX_URL,
    applyLocalWorkspaceApps: async () => {},
    applyNodeModulePlugins: async () => {},
    sanitizeSandbox: (value?: string) => `safe:${value ?? "none"}`,
    ...overrides,
  };
}

function namedPlugin(name: string): RegistryPluginInfo {
  return {
    name,
    gitRepo: name,
    gitUrl: `https://github.com/${name}.git`,
    directory: null,
    description: "",
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: { package: name, v0Version: null, v1Version: null, v2Version: null },
    git: { v0Branch: null, v1Branch: null, v2Branch: "next" },
    supports: { v0: false, v1: false, v2: false },
  };
}

beforeEach(() => {
  recordedUrls.length = 0;
  recordedInits.length = 0;
  isCloudReachable.mockReset();
  isCloudReachable.mockResolvedValue(true);
  fetchImpl = async () => httpResponse(404, "Not Found");
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    recordedUrls.push(url);
    recordedInits.push(init);
    return fetchImpl(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("RegistryNetworkFallbackError", () => {
  it("names itself and marks an expected local fallback", () => {
    const error = new RegistryNetworkFallbackError("use local snapshot");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RegistryNetworkFallbackError");
    expect(error.message).toBe("use local snapshot");
    expect(error.expectedLocalFallback).toBe(true);
  });
});

describe("isExpectedRegistryNetworkFallback", () => {
  it("accepts a RegistryNetworkFallbackError instance", () => {
    expect(
      isExpectedRegistryNetworkFallback(
        new RegistryNetworkFallbackError("offline"),
      ),
    ).toBe(true);
  });

  it("accepts AbortError and TimeoutError names on Error values", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeout = new Error("deadline");
    timeout.name = "TimeoutError";
    expect(isExpectedRegistryNetworkFallback(abort)).toBe(true);
    expect(isExpectedRegistryNetworkFallback(timeout)).toBe(true);
  });

  it("accepts timeout phrasing case-insensitively", () => {
    expect(
      isExpectedRegistryNetworkFallback(new Error("Connection TIMEOUT")),
    ).toBe(true);
    expect(
      isExpectedRegistryNetworkFallback(new Error("request timed out")),
    ).toBe(true);
  });

  it("accepts a duck-typed expectedLocalFallback flag", () => {
    expect(
      isExpectedRegistryNetworkFallback({ expectedLocalFallback: true }),
    ).toBe(true);
    const flagged = new Error("network down");
    Object.assign(flagged, { expectedLocalFallback: true });
    expect(isExpectedRegistryNetworkFallback(flagged)).toBe(true);
  });

  it("rejects unrelated values and a false fallback flag", () => {
    expect(isExpectedRegistryNetworkFallback(null)).toBe(false);
    expect(isExpectedRegistryNetworkFallback(undefined)).toBe(false);
    expect(isExpectedRegistryNetworkFallback("timeout")).toBe(false);
    expect(isExpectedRegistryNetworkFallback(new Error("ECONNREFUSED"))).toBe(
      false,
    );
    expect(
      isExpectedRegistryNetworkFallback({ expectedLocalFallback: false }),
    ).toBe(false);
    expect(
      isExpectedRegistryNetworkFallback({ expectedLocalFallback: "true" }),
    ).toBe(false);
  });
});

describe("fetchFromNetwork", () => {
  it("throws a local-fallback error and does not fetch when the cloud is unreachable", async () => {
    isCloudReachable.mockResolvedValue(false);

    await expect(fetchFromNetwork(params())).rejects.toEqual(
      expect.objectContaining({
        name: "RegistryNetworkFallbackError",
        message: "cloud unreachable at boot — using local registry snapshot",
        expectedLocalFallback: true,
      }),
    );
    expect(recordedUrls).toEqual([]);
  });

  it("prefers a generated registry over a concurrent successful index", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({
          registry: { "@elizaos/plugin-generated": generatedEntry() },
        });
      }
      if (url === INDEX_URL) {
        return jsonResponse({
          "@elizaos/plugin-index": "github:elizaos/plugin-index",
        });
      }
      return httpResponse(404, "Not Found");
    };

    const plugins = await fetchFromNetwork(params());

    expect([...plugins.keys()]).toEqual(["@elizaos/plugin-generated"]);
    expect(plugins.get("@elizaos/plugin-generated")?.gitRepo).toBe(
      "elizaos/plugin-example",
    );
    expect(plugins.get("@elizaos/plugin-generated")?.gitUrl).toBe(
      "https://github.com/elizaos/plugin-example.git",
    );
    expect(recordedUrls).toEqual(
      expect.arrayContaining([GENERATED_URL, INDEX_URL]),
    );
  });

  it("issues generated and index fetches concurrently", async () => {
    let releaseGenerated!: () => void;
    const generatedGate = new Promise<void>((resolve) => {
      releaseGenerated = resolve;
    });
    let generatedStarted!: () => void;
    let indexStarted!: () => void;
    const bothStarted = Promise.all([
      new Promise<void>((resolve) => {
        generatedStarted = resolve;
      }),
      new Promise<void>((resolve) => {
        indexStarted = resolve;
      }),
    ]);

    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        generatedStarted();
        await generatedGate;
        return jsonResponse({
          registry: { "@elizaos/plugin-generated": generatedEntry() },
        });
      }
      if (url === INDEX_URL) {
        indexStarted();
        return jsonResponse({
          "@elizaos/plugin-index": "github:elizaos/plugin-index",
        });
      }
      return httpResponse(404, "Not Found");
    };

    const pending = fetchFromNetwork(params());
    await bothStarted;
    releaseGenerated();
    const plugins = await pending;
    expect([...plugins.keys()]).toEqual(["@elizaos/plugin-generated"]);
  });

  it("does not surface an index failure when the generated registry loads", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({
          registry: { "@elizaos/plugin-generated": generatedEntry() },
        });
      }
      throw new Error("index unreachable");
    };

    const plugins = await fetchFromNetwork(params());
    expect([...plugins.keys()]).toEqual(["@elizaos/plugin-generated"]);
  });

  it("falls through to the index registry when generated returns 404", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return httpResponse(404, "Not Found");
      }
      return jsonResponse({
        "@elizaos/plugin-sql": "github:elizaos/plugin-sql",
        "community-plugin": "org/community-plugin",
      });
    };

    const plugins = await fetchFromNetwork(params());

    expect([...plugins.keys()]).toEqual([
      "@elizaos/plugin-sql",
      "community-plugin",
    ]);
    const builtin = plugins.get("@elizaos/plugin-sql");
    expect(builtin?.gitRepo).toBe("elizaos/plugin-sql");
    expect(builtin?.gitUrl).toBe("https://github.com/elizaos/plugin-sql.git");
    expect(builtin?.origin).toBe("builtin");
    expect(builtin?.source).toBe("builtin");
    expect(builtin?.support).toBe("first-party");
    expect(builtin?.builtIn).toBe(true);
    expect(builtin?.firstParty).toBe(true);
    expect(builtin?.thirdParty).toBe(false);
    expect(builtin?.git.v2Branch).toBe("next");
    expect(builtin?.npm.package).toBe("@elizaos/plugin-sql");
    expect(builtin?.supports).toEqual({ v0: false, v1: false, v2: false });

    const community = plugins.get("community-plugin");
    expect(community?.gitRepo).toBe("org/community-plugin");
    expect(community?.origin).toBe("third-party");
    expect(community?.source).toBe("third-party");
    expect(community?.support).toBe("community");
    expect(community?.builtIn).toBe(false);
    expect(community?.firstParty).toBe(false);
    expect(community?.thirdParty).toBe(true);
  });

  it("falls through to the index registry on a generated HTTP error", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return httpResponse(503, "Service Unavailable");
      }
      return jsonResponse({
        "fallback-plugin": "github:org/fallback-plugin",
      });
    };

    const plugins = await fetchFromNetwork(params());
    expect([...plugins.keys()]).toEqual(["fallback-plugin"]);
  });

  it("falls through to the index registry when generated fetch throws", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        throw new Error("socket hang up");
      }
      return jsonResponse({ "index-only": "github:org/index-only" });
    };

    const plugins = await fetchFromNetwork(params());
    expect([...plugins.keys()]).toEqual(["index-only"]);
  });

  it("falls through to the index registry when generated JSON is malformed", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return new Response("{not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return jsonResponse({ recovered: "github:org/recovered" });
    };

    const plugins = await fetchFromNetwork(params());
    expect([...plugins.keys()]).toEqual(["recovered"]);
  });

  it("falls through when generated JSON has no registry object", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({ plugins: {} });
      }
      return jsonResponse({ recovered: "github:org/recovered" });
    };

    const plugins = await fetchFromNetwork(params());
    expect([...plugins.keys()]).toEqual(["recovered"]);
  });

  it("throws RegistryNetworkFallbackError when index HTTP fails after a generated miss", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return httpResponse(404, "Not Found");
      }
      return httpResponse(404, "Not Found");
    };

    await expect(fetchFromNetwork(params())).rejects.toEqual(
      expect.objectContaining({
        name: "RegistryNetworkFallbackError",
        message: "index.json: 404 Not Found",
        expectedLocalFallback: true,
      }),
    );
  });

  it("rethrows the raw index network error after a generated miss", async () => {
    const raw = new Error("ECONNRESET");
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return httpResponse(404, "Not Found");
      }
      throw raw;
    };

    await expect(fetchFromNetwork(params())).rejects.toBe(raw);
    expect(isExpectedRegistryNetworkFallback(raw)).toBe(false);
  });

  it("applies local then node-module overlays on an empty generated registry", async () => {
    const order: string[] = [];
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({ registry: {} });
      }
      return jsonResponse({ "should-not-win": "github:org/nope" });
    };

    const plugins = await fetchFromNetwork(
      params({
        applyLocalWorkspaceApps: async (map) => {
          // Both fetches run concurrently against the same hooks. Only mutate
          // the generated map so the assertion records that winner's order.
          if (map.has("should-not-win")) return;
          order.push("local");
          map.set("local-app", namedPlugin("local-app"));
        },
        applyNodeModulePlugins: async (map) => {
          if (map.has("should-not-win")) return;
          order.push("node");
          map.set("node-plugin", namedPlugin("node-plugin"));
        },
      }),
    );

    expect(order).toEqual(["local", "node"]);
    expect([...plugins.keys()]).toEqual(["local-app", "node-plugin"]);
    expect(plugins.has("should-not-win")).toBe(false);
  });

  it("normalises generated defaults for missing optional fields", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({
          registry: {
            "sparse-plugin": generatedEntry({
              description: "",
              homepage: null,
              topics: undefined,
              stargazers_count: 0,
              language: "",
              directory: undefined,
              git: {
                repo: "org/sparse",
                v0: { branch: undefined },
                v1: { branch: undefined },
                v2: { branch: undefined },
              },
            }),
          },
        });
      }
      return httpResponse(404, "Not Found");
    };

    const plugins = await fetchFromNetwork(params());
    const sparse = plugins.get("sparse-plugin");
    expect(sparse?.description).toBe("");
    expect(sparse?.homepage).toBeNull();
    expect(sparse?.topics).toEqual([]);
    expect(sparse?.stars).toBe(0);
    expect(sparse?.language).toBe("TypeScript");
    expect(sparse?.directory).toBeNull();
    expect(sparse?.git).toEqual({
      v0Branch: null,
      v1Branch: null,
      v2Branch: null,
    });
  });

  it("maps app metadata, forces kind=app, and sanitizes viewer sandbox", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({
          registry: {
            "chess-app": generatedEntry({
              kind: "plugin",
              app: {
                displayName: "Chess",
                category: "games",
                launchType: "iframe",
                launchUrl: "https://chess.example",
                icon: "/icon.png",
                capabilities: ["moves"],
                minPlayers: 1,
                maxPlayers: 2,
                runtimePlugin: "@elizaos/plugin-chess",
                viewer: {
                  url: "https://chess.example/view",
                  sandbox: "allow-scripts",
                },
                session: { mode: "viewer" },
                featured: true,
              },
            }),
          },
        });
      }
      return httpResponse(404, "Not Found");
    };

    const plugins = await fetchFromNetwork(params());
    const chess = plugins.get("chess-app");
    expect(chess?.kind).toBe("app");
    expect(chess?.appMeta).toEqual(
      expect.objectContaining({
        displayName: "Chess",
        category: "games",
        launchType: "iframe",
        launchUrl: "https://chess.example",
        icon: "/icon.png",
        heroImage: null,
        capabilities: ["moves"],
        minPlayers: 1,
        maxPlayers: 2,
        runtimePlugin: "@elizaos/plugin-chess",
        featured: true,
        viewer: expect.objectContaining({
          url: "https://chess.example/view",
          sandbox: "safe:allow-scripts",
        }),
        session: { mode: "viewer" },
      }),
    );
  });

  it("keeps a non-app kind when no app payload is present", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({
          registry: {
            "plain-plugin": generatedEntry({ kind: "plugin" }),
          },
        });
      }
      return httpResponse(404, "Not Found");
    };

    const plugins = await fetchFromNetwork(params());
    expect(plugins.get("plain-plugin")?.kind).toBe("plugin");
    expect(plugins.get("plain-plugin")?.appMeta).toBeUndefined();
  });

  it("omits viewer when the app payload has none and defaults empty capabilities", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({
          registry: {
            "bare-app": generatedEntry({
              app: {
                displayName: "Bare",
                category: "other",
                launchType: "native",
                launchUrl: null,
                icon: null,
              },
            }),
          },
        });
      }
      return httpResponse(404, "Not Found");
    };

    const plugins = await fetchFromNetwork(params());
    const bare = plugins.get("bare-app");
    expect(bare?.kind).toBe("app");
    expect(bare?.appMeta?.viewer).toBeUndefined();
    expect(bare?.appMeta?.capabilities).toEqual([]);
    expect(bare?.appMeta?.minPlayers).toBeNull();
    expect(bare?.appMeta?.maxPlayers).toBeNull();
    expect(bare?.appMeta?.heroImage).toBeNull();
  });

  it("yields an empty map for an empty index registry", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return httpResponse(404, "Not Found");
      }
      return jsonResponse({});
    };

    const plugins = await fetchFromNetwork(params());
    expect(plugins.size).toBe(0);
  });

  it("does not treat @elizaos without a slash as builtin on the index path", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return httpResponse(404, "Not Found");
      }
      return jsonResponse({ "@elizaos": "github:elizaos/elizaos" });
    };

    const plugins = await fetchFromNetwork(params());
    const entry = plugins.get("@elizaos");
    expect(entry?.builtIn).toBe(false);
    expect(entry?.origin).toBe("third-party");
    expect(entry?.gitRepo).toBe("elizaos/elizaos");
  });

  it("falls through to index when a generated overlay throws", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({
          registry: { "@elizaos/plugin-generated": generatedEntry() },
        });
      }
      return jsonResponse({ recovered: "github:org/recovered" });
    };

    const plugins = await fetchFromNetwork(
      params({
        applyLocalWorkspaceApps: async (map) => {
          // The same overlay is invoked on the concurrent index attempt. Throw
          // only on the generated map so the index path can still win.
          if (!map.has("recovered")) {
            throw new Error("local overlay failed");
          }
        },
      }),
    );

    expect([...plugins.keys()]).toEqual(["recovered"]);
  });

  it("propagates an overlay throw on the index path", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return httpResponse(404, "Not Found");
      }
      return jsonResponse({ recovered: "github:org/recovered" });
    };
    const overlayError = new Error("index overlay failed");

    await expect(
      fetchFromNetwork(
        params({
          applyNodeModulePlugins: async () => {
            throw overlayError;
          },
        }),
      ),
    ).rejects.toBe(overlayError);
  });

  it("fetches with redirect=error and a timeout abort signal", async () => {
    fetchImpl = async (url) => {
      if (url === GENERATED_URL) {
        return jsonResponse({ registry: {} });
      }
      return httpResponse(404, "Not Found");
    };

    await fetchFromNetwork(params());

    expect(recordedInits.length).toBeGreaterThan(0);
    for (const init of recordedInits) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    }
  });
});
