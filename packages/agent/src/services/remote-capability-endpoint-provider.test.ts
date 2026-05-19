import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteCapabilityEndpointTrustPolicy,
  connectRemoteCapabilityEndpointProvider,
  directRemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointProvider,
} from "./remote-capability-endpoint-provider.ts";
import {
  e2bCapabilityEndpointProvider,
  homeMachineCapabilityEndpointProvider,
  mobileCompanionCapabilityEndpointProvider,
} from "./remote-capability-url-endpoint-providers.ts";

const originalFetch = globalThis.fetch;

describe("remote capability endpoint providers", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the same endpoint/module trust policy for every provider kind", () => {
    expect(
      buildRemoteCapabilityEndpointTrustPolicy("home-runner", ["home-plugin"]),
    ).toEqual({
      allowedEndpointIds: ["home-runner"],
      allowedModuleIds: ["home-plugin"],
      requireEndpointId: true,
    });
  });

  it("adapts a provider-specific provisioner into the canonical router and plugin sync path", async () => {
    const runtime = makeRuntime();
    const calls: Array<{
      url: string;
      body?: unknown;
      authorization?: string;
    }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { method?: string })
        : undefined;
      calls.push({
        url: String(url),
        body,
        authorization:
          init?.headers && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>).authorization
            : undefined,
      });
      if (
        String(url) ===
          "https://home-runner.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.modules.list"
      ) {
        return jsonResponse({
          ok: true,
          result: {
            modules: [
              {
                id: "home-plugin",
                name: "@remote/home-plugin",
                actions: [
                  {
                    name: "HOME_ACTION",
                    description: "Run on a home-machine endpoint.",
                  },
                ],
                providers: [
                  {
                    name: "HOME_CONTEXT",
                    description: "Read home-machine context.",
                  },
                ],
              },
            ],
          },
        });
      }
      if (
        String(url) ===
          "https://home-runner.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.action.invoke"
      ) {
        return jsonResponse({
          ok: true,
          result: { text: "home action", values: { provider: "home" } },
        });
      }
      if (
        String(url) ===
          "https://home-runner.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.provider.get"
      ) {
        return jsonResponse({
          ok: true,
          result: { text: "home provider", values: { provider: "home" } },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    const homeProvider: RemoteCapabilityEndpointProvider<{
      endpointId: string;
    }> = {
      id: "home-machine",
      provision: async ({ endpointId }) => ({
        providerId: "home-machine",
        endpoint: {
          id: endpointId,
          baseUrl: "https://home-runner.example.test",
          token: "home-token",
        },
        allowedModuleIds: ["home-plugin"],
      }),
    };

    const result = await connectRemoteCapabilityEndpointProvider(runtime, {
      provider: homeProvider,
      provisionOptions: { endpointId: "home-runner" },
    });

    expect(result.providerId).toBe("home-machine");
    expect(result.sync.registered.map((plugin) => plugin.name)).toEqual([
      "@remote/home-plugin",
    ]);
    expect(result.sync.trustDecisions).toEqual([
      expect.objectContaining({
        endpointId: "home-runner",
        moduleId: "home-plugin",
        trusted: true,
        reason: "allowed",
      }),
    ]);
    await expect(
      runtime.actions[0]?.handler(runtime, {
        content: { text: "run home action" },
      } as never),
    ).resolves.toMatchObject({ text: "home action" });
    await expect(
      runtime.providers[0]?.get(runtime, {} as never, {} as never),
    ).resolves.toMatchObject({ text: "home provider" });
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer home-token",
      "Bearer home-token",
      "Bearer home-token",
    ]);
  });

  it("preserves existing runtime endpoints and plugins across sequential provider connects", async () => {
    const runtime = makeRuntime();
    const calls: Array<{ url: string; method?: string; moduleId?: string }> =
      [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            method?: string;
            params?: { moduleId?: string };
          })
        : undefined;
      calls.push({
        url: String(url),
        method: body?.method,
        moduleId: body?.params?.moduleId,
      });
      if (body?.method === "plugin.modules.list") {
        if (String(url).startsWith("https://home-a.example.test/")) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "home-a-plugin",
                  name: "@remote/home-a",
                  actions: [
                    {
                      name: "HOME_A_ACTION",
                      description: "Run on home machine A.",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (String(url).startsWith("https://home-b.example.test/")) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "home-b-plugin",
                  name: "@remote/home-b",
                  actions: [
                    {
                      name: "HOME_B_ACTION",
                      description: "Run on home machine B.",
                    },
                  ],
                },
              ],
            },
          });
        }
      }
      if (body?.method === "plugin.action.invoke") {
        return jsonResponse({
          ok: true,
          result: {
            text:
              body.params?.moduleId === "home-a-plugin"
                ? "home a action"
                : "home b action",
          },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    await connectRemoteCapabilityEndpointProvider(runtime, {
      provider: endpointProvider("home-a", "https://home-a.example.test"),
      provisionOptions: {},
      unloadMissing: true,
    });
    await connectRemoteCapabilityEndpointProvider(runtime, {
      provider: endpointProvider("home-b", "https://home-b.example.test"),
      provisionOptions: {},
      unloadMissing: true,
    });

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/home-a",
      "@remote/home-b",
    ]);
    expect(runtime.unloaded).toEqual([]);
    await expect(
      runtime.actions
        .find((action) => action.name === "HOME_A_ACTION")
        ?.handler(runtime, {} as never),
    ).resolves.toMatchObject({ text: "home a action" });
    await expect(
      runtime.actions
        .find((action) => action.name === "HOME_B_ACTION")
        ?.handler(runtime, {} as never),
    ).resolves.toMatchObject({ text: "home b action" });
    expect(
      calls
        .filter((call) => call.method === "plugin.modules.list")
        .map((call) => call.url),
    ).toEqual([
      "https://home-a.example.test/v1/capabilities/invoke",
      "https://home-b.example.test/v1/capabilities/invoke",
    ]);
  });

  it("materializes only allowed modules from a shared endpoint and records the rest as skipped", async () => {
    const runtime = makeRuntime();
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            method?: string;
            params?: { moduleId?: string };
          })
        : undefined;
      if (
        String(url) === "https://shared.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.modules.list"
      ) {
        return jsonResponse({
          ok: true,
          result: {
            modules: [
              {
                id: "allowed-plugin",
                name: "@remote/allowed",
                actions: [
                  {
                    name: "ALLOWED_ACTION",
                    description: "Run the allowed module.",
                  },
                ],
              },
              {
                id: "foreign-plugin",
                name: "@remote/foreign",
                actions: [
                  {
                    name: "FOREIGN_ACTION",
                    description: "Run the foreign module.",
                  },
                ],
              },
            ],
          },
        });
      }
      if (
        String(url) === "https://shared.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.action.invoke"
      ) {
        return jsonResponse({
          ok: true,
          result: { text: `${body.params?.moduleId} action` },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    const result = await connectRemoteCapabilityEndpointProvider(runtime, {
      provider: {
        id: "home-machine",
        provision: async () => ({
          providerId: "home-machine",
          endpoint: {
            id: "shared-home",
            baseUrl: "https://shared.example.test",
          },
          allowedModuleIds: ["allowed-plugin"],
        }),
      },
      provisionOptions: {},
      unloadMissing: true,
    });

    expect(result.sync.registered.map((plugin) => plugin.name)).toEqual([
      "@remote/allowed",
    ]);
    expect(result.sync.skipped).toEqual(["@remote/foreign"]);
    expect(result.sync.trustDecisions).toEqual([
      expect.objectContaining({
        endpointId: "shared-home",
        moduleId: "allowed-plugin",
        trusted: true,
        reason: "allowed",
      }),
      expect.objectContaining({
        endpointId: "shared-home",
        moduleId: "foreign-plugin",
        pluginName: "@remote/foreign",
        trusted: false,
        reason: "module-not-allowed",
      }),
    ]);
    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/allowed",
    ]);
    expect(runtime.actions.map((action) => action.name)).toEqual([
      "ALLOWED_ACTION",
    ]);
    await expect(
      runtime.actions[0]?.handler(runtime, {} as never),
    ).resolves.toMatchObject({ text: "allowed-plugin action" });
  });

  it("unloads a previously trusted shared-endpoint module when the allowlist shrinks", async () => {
    const runtime = makeRuntime();
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            method?: string;
            params?: { moduleId?: string };
          })
        : undefined;
      if (
        String(url) === "https://shared.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.modules.list"
      ) {
        return jsonResponse({
          ok: true,
          result: {
            modules: [
              {
                id: "allowed-plugin",
                name: "@remote/allowed",
                actions: [
                  {
                    name: "ALLOWED_ACTION",
                    description: "Run the allowed module.",
                  },
                ],
              },
              {
                id: "retired-plugin",
                name: "@remote/retired",
                actions: [
                  {
                    name: "RETIRED_ACTION",
                    description: "Run the retired module.",
                  },
                ],
              },
            ],
          },
        });
      }
      if (
        String(url) === "https://shared.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.action.invoke"
      ) {
        return jsonResponse({
          ok: true,
          result: { text: `${body.params?.moduleId} action` },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    await connectRemoteCapabilityEndpointProvider(runtime, {
      provider: sharedEndpointProvider([
        "allowed-plugin",
        "retired-plugin",
      ]),
      provisionOptions: {},
      unloadMissing: true,
    });
    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/allowed",
      "@remote/retired",
    ]);
    expect(runtime.actions.map((action) => action.name)).toEqual([
      "ALLOWED_ACTION",
      "RETIRED_ACTION",
    ]);

    const result = await connectRemoteCapabilityEndpointProvider(runtime, {
      provider: sharedEndpointProvider(["allowed-plugin"]),
      provisionOptions: {},
      unloadMissing: true,
    });

    expect(result.sync.registered).toEqual([]);
    expect(result.sync.skipped).toEqual(["@remote/allowed"]);
    expect(result.sync.unloaded).toEqual(["@remote/retired"]);
    expect(result.sync.trustDecisions).toEqual([
      expect.objectContaining({
        endpointId: "shared-home",
        moduleId: "allowed-plugin",
        pluginName: "@remote/allowed",
        trusted: true,
        reason: "allowed",
      }),
      expect.objectContaining({
        endpointId: "shared-home",
        moduleId: "retired-plugin",
        pluginName: "@remote/retired",
        trusted: false,
        reason: "module-not-allowed",
      }),
    ]);
    expect(runtime.unloaded).toEqual(["@remote/retired"]);
    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/allowed",
    ]);
    expect(runtime.actions.map((action) => action.name)).toEqual([
      "ALLOWED_ACTION",
    ]);
  });

  it("treats E2B, home-machine, and mobile companion providers as the same plugin endpoint contract", async () => {
    const runtime = makeRuntime();
    const families = [
      { id: "e2b", provider: e2bCapabilityEndpointProvider },
      { id: "home", provider: homeMachineCapabilityEndpointProvider },
      { id: "mobile", provider: mobileCompanionCapabilityEndpointProvider },
    ] as const;
    const calls: Array<{ method?: string; endpointId: string }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const endpointId = href.includes("e2b")
        ? "e2b"
        : href.includes("home")
          ? "home"
          : "mobile";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            method?: string;
            params?: { moduleId?: string; path?: string };
          })
        : undefined;
      calls.push({ method: body?.method, endpointId });
      const label = endpointId.toUpperCase();
      if (body?.method === "plugin.modules.list") {
        return jsonResponse({
          ok: true,
          result: {
            modules: [
              {
                id: `${endpointId}-plugin`,
                name: `@remote/${endpointId}`,
                actions: [
                  {
                    name: `${label}_ACTION`,
                    description: `Run on ${endpointId}.`,
                  },
                ],
                providers: [
                  {
                    name: `${label}_CONTEXT`,
                    description: `Read ${endpointId} context.`,
                  },
                ],
                routes: [
                  {
                    method: "POST",
                    path: `/remote/${endpointId}`,
                  },
                ],
                views: [
                  {
                    id: `${endpointId}-view`,
                    label: `${label} View`,
                    viewType: "gui",
                    bundlePath: `/assets/${endpointId}.js`,
                  },
                ],
              },
            ],
          },
        });
      }
      if (body?.method === "plugin.action.invoke") {
        return jsonResponse({
          ok: true,
          result: { text: `${endpointId} action` },
        });
      }
      if (body?.method === "plugin.provider.get") {
        return jsonResponse({
          ok: true,
          result: { text: `${endpointId} provider` },
        });
      }
      if (body?.method === "plugin.route.call") {
        return jsonResponse({
          ok: true,
          result: {
            status: 200,
            body: { endpointId, route: true },
          },
        });
      }
      if (body?.method === "plugin.asset.get") {
        return jsonResponse({
          ok: true,
          result: {
            path: body.params?.path ?? `/assets/${endpointId}.js`,
            contentType: "text/javascript",
            bodyBase64: Buffer.from(
              `export const id = "${endpointId}";`,
            ).toString("base64"),
          },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    for (const family of families) {
      await connectRemoteCapabilityEndpointProvider(runtime, {
        provider: family.provider,
        provisionOptions: {
          endpointId: family.id,
          baseUrl: `https://${family.id}.example.test/`,
        },
        unloadMissing: true,
      });
    }

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/e2b",
      "@remote/home",
      "@remote/mobile",
    ]);
    expect(runtime.unloaded).toEqual([]);
    for (const family of families) {
      await expect(
        runtime.actions
          .find((action) => action.name === `${family.id.toUpperCase()}_ACTION`)
          ?.handler(runtime, {} as never),
      ).resolves.toMatchObject({ text: `${family.id} action` });
      await expect(
        runtime.providers
          .find(
            (provider) =>
              provider.name === `${family.id.toUpperCase()}_CONTEXT`,
          )
          ?.get(runtime, {} as never, {} as never),
      ).resolves.toMatchObject({ text: `${family.id} provider` });
      await expect(
        runtime.routes
          .find((route) => route.path === `/remote/${family.id}`)
          ?.routeHandler?.({
            runtime,
            method: "POST",
            path: `/remote/${family.id}`,
            body: {},
            params: {},
            query: {},
            headers: {},
            inProcess: false,
          }),
      ).resolves.toMatchObject({
        status: 200,
        body: { endpointId: family.id, route: true },
      });
      const router = runtime.getService?.(
        CAPABILITY_ROUTER_SERVICE_TYPE,
      ) as unknown as {
        plugin: { getAsset: (params: unknown) => Promise<unknown> };
      };
      await expect(
        router.plugin.getAsset({
          endpointId: family.id,
          moduleId: `${family.id}-plugin`,
          path: `/assets/${family.id}.js`,
        }),
      ).resolves.toMatchObject({
        contentType: "text/javascript",
      });
    }
    expect(
      calls
        .filter((call) => call.method === "plugin.modules.list")
        .map((call) => call.endpointId),
    ).toEqual(["e2b", "home", "mobile"]);
  });

  it("keeps direct endpoints as one provider implementation, not a special runtime path", async () => {
    await expect(
      directRemoteCapabilityEndpointProvider().provision({
        endpoint: {
          id: "mobile-companion",
          baseUrl: "https://mobile.example.test",
          token: "mobile-token",
        },
        allowedModuleIds: ["mobile-plugin"],
      }),
    ).resolves.toEqual({
      providerId: "direct",
      endpoint: {
        id: "mobile-companion",
        baseUrl: "https://mobile.example.test",
        token: "mobile-token",
      },
      allowedModuleIds: ["mobile-plugin"],
    });
  });

  it("normalizes and validates URL-backed provider endpoints before sync", async () => {
    await expect(
      e2bCapabilityEndpointProvider.provision({
        baseUrl: " https://runner.example.test/root?token=leak#frag ",
        endpointId: " e2b-runner ",
        token: "secret",
        allowedModuleIds: ["runner-plugin"],
      }),
    ).resolves.toEqual({
      providerId: "e2b",
      endpoint: {
        id: "e2b-runner",
        baseUrl: "https://runner.example.test/root",
        token: "secret",
      },
      allowedModuleIds: ["runner-plugin"],
    });

    await expect(
      homeMachineCapabilityEndpointProvider.provision({
        baseUrl: "file:///tmp/capability",
      }),
    ).rejects.toThrow("must use http or https");
    await expect(
      mobileCompanionCapabilityEndpointProvider.provision({
        baseUrl: "https://user:pass@mobile.example.test",
      }),
    ).rejects.toThrow("must not include embedded credentials");
    await expect(
      mobileCompanionCapabilityEndpointProvider.provision({
        baseUrl: "https://mobile.example.test",
        endpointId: "../mobile",
      }),
    ).rejects.toThrow("must not contain path or query separators");
  });
});

function makeRuntime(): IAgentRuntime & {
  actions: NonNullable<Plugin["actions"]>;
  providers: NonNullable<Plugin["providers"]>;
  evaluators: NonNullable<Plugin["evaluators"]>;
  routes: NonNullable<Plugin["routes"]>;
  unloaded: string[];
} {
  const runtime = {
    agentId: "33333333-3333-3333-3333-333333333333" as UUID,
    character: { name: "Endpoint Provider Test" },
    plugins: [] as Plugin[],
    actions: [] as NonNullable<Plugin["actions"]>,
    providers: [] as NonNullable<Plugin["providers"]>,
    evaluators: [] as NonNullable<Plugin["evaluators"]>,
    routes: [] as NonNullable<Plugin["routes"]>,
    unloaded: [] as string[],
    services: new Map() as IAgentRuntime["services"],
    getService: (serviceType: string) =>
      runtime.services.get(serviceType as never)?.[0] ?? null,
    getServicesByType: (serviceType: string) =>
      runtime.services.get(serviceType as never) ?? [],
    hasService: (serviceType: string) =>
      runtime.services.has(serviceType as never) ||
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE,
    registerPlugin: async (plugin: Plugin) => {
      runtime.plugins.push(plugin);
      runtime.actions.push(...(plugin.actions ?? []));
      runtime.providers.push(...(plugin.providers ?? []));
      runtime.evaluators.push(...(plugin.evaluators ?? []));
      runtime.routes.push(...(plugin.routes ?? []));
    },
    reloadPlugin: async (plugin: Plugin) => {
      await runtime.registerPlugin(plugin);
    },
    unloadPlugin: async (pluginName: string) => {
      const pluginIndex = runtime.plugins.findIndex(
        (plugin) => plugin.name === pluginName,
      );
      if (pluginIndex < 0) return null;
      const [plugin] = runtime.plugins.splice(pluginIndex, 1);
      runtime.actions = runtime.actions.filter(
        (action) => !(plugin.actions ?? []).includes(action),
      );
      runtime.providers = runtime.providers.filter(
        (provider) => !(plugin.providers ?? []).includes(provider),
      );
      runtime.evaluators = runtime.evaluators.filter(
        (evaluator) => !(plugin.evaluators ?? []).includes(evaluator),
      );
      runtime.routes = runtime.routes.filter(
        (route) => !(plugin.routes ?? []).includes(route),
      );
      runtime.unloaded.push(pluginName);
      return {
        pluginName,
        plugin,
        actions: plugin.actions ?? [],
        providers: plugin.providers ?? [],
        evaluators: plugin.evaluators ?? [],
        services: [],
        routes: plugin.routes ?? [],
      };
    },
    getAllPluginOwnership: () =>
      runtime.plugins.map((plugin) => ({
        pluginName: plugin.name,
        plugin,
        actions: plugin.actions ?? [],
        providers: plugin.providers ?? [],
        evaluators: plugin.evaluators ?? [],
        services: [],
        routes: plugin.routes ?? [],
      })),
  } as unknown as IAgentRuntime & {
    actions: NonNullable<Plugin["actions"]>;
    providers: NonNullable<Plugin["providers"]>;
    evaluators: NonNullable<Plugin["evaluators"]>;
    routes: NonNullable<Plugin["routes"]>;
    unloaded: string[];
  };
  return runtime;
}

function endpointProvider(
  id: string,
  baseUrl: string,
  providerId: RemoteCapabilityEndpointProvider<
    Record<string, never>
  >["id"] = "home-machine",
): RemoteCapabilityEndpointProvider<Record<string, never>> {
  return {
    id: providerId,
    provision: async () => ({
      providerId,
      endpoint: {
        id,
        baseUrl,
        token: `${id}-token`,
      },
    }),
  };
}

function sharedEndpointProvider(
  allowedModuleIds: string[],
): RemoteCapabilityEndpointProvider<Record<string, never>> {
  return {
    id: "home-machine",
    provision: async () => ({
      providerId: "home-machine",
      endpoint: {
        id: "shared-home",
        baseUrl: "https://shared.example.test",
      },
      allowedModuleIds,
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
