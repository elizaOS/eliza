/**
 * Unit coverage for TEE trust enforcement on remote capability endpoints.
 * Asserts `connectRemoteCapabilityEndpointProvider` fails closed before plugin
 * sync when required TEE evidence is missing or its measurements do not match
 * the policy, and that a `dstack` provider collects evidence and only syncs the
 * remote plugin after the policy passes. Uses a stubbed fetch and in-memory
 * runtime; the TEE evidence is a fixture, not a real attestation.
 */
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectRemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointProvider,
  teeRemoteCapabilityEndpointProvider,
} from "./remote-capability-endpoint-provider.ts";

const runtime = {} as IAgentRuntime;
const originalFetch = globalThis.fetch;

describe("remote capability TEE policy", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fails closed before plugin sync when required endpoint TEE evidence is missing", async () => {
    await expect(
      connectRemoteCapabilityEndpointProvider(runtime, {
        provider: providerWithMetadata(undefined),
        provisionOptions: {},
        trustPolicy: { requireTeeEvidence: true },
      }),
    ).rejects.toThrow(/failed TEE trust policy/);
  });

  it("fails closed when endpoint TEE evidence does not match the required agent measurement", async () => {
    await expect(
      connectRemoteCapabilityEndpointProvider(runtime, {
        provider: providerWithMetadata({
          teeEvidence: {
            kind: "dstack",
            provider: "dstack",
            measurements: { agent: "sha256:abc" },
            claims: { debugDisabled: true },
          },
        }),
        provisionOptions: {},
        trustPolicy: {
          requireTeeEvidence: true,
          teePolicy: {
            allowedKinds: ["dstack"],
            requiredMeasurements: { agent: "sha256:def" },
            requiredClaims: { debugDisabled: true },
          },
        },
      }),
    ).rejects.toThrow(/measurement/);
  });

  it("collects TEE evidence during endpoint provisioning and syncs only after policy passes", async () => {
    const runtime = makeRuntime();
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { method?: string })
        : undefined;
      if (body?.method === "plugin.modules.list") {
        return jsonResponse({
          ok: true,
          result: {
            modules: [
              {
                id: "tee-plugin",
                name: "@remote/tee-plugin",
                actions: [
                  {
                    name: "TEE_ACTION",
                    description: "Run inside an attested TEE endpoint.",
                  },
                ],
              },
            ],
          },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    const result = await connectRemoteCapabilityEndpointProvider(runtime, {
      provider: teeRemoteCapabilityEndpointProvider(),
      provisionOptions: {
        endpoint: {
          id: "tee-runner",
          baseUrl: "https://tee-runner.example.test",
        },
        allowedModuleIds: ["tee-plugin"],
        evidenceProvider: {
          id: "fixture",
          collectEvidence: async () => ({
            kind: "dstack",
            provider: "dstack",
            measurements: { agent: "sha256:abc", policy: "sha256:def" },
            claims: { debugDisabled: true, secureBoot: true },
          }),
        },
      },
      trustPolicy: {
        requireTeeEvidence: true,
        teePolicy: {
          allowedKinds: ["dstack"],
          requiredMeasurements: { agent: "abc", policy: "def" },
          requiredClaims: { debugDisabled: true, secureBoot: true },
        },
      },
    });

    expect(result.teeTrustDecision).toMatchObject({
      trusted: true,
      reason: "allowed",
    });
    expect(result.sync.registered.map((plugin) => plugin.name)).toEqual([
      "@remote/tee-plugin",
    ]);
  });
});

function makeRuntime(): IAgentRuntime & {
  actions: NonNullable<Plugin["actions"]>;
  plugins: Plugin[];
} {
  const runtime = {
    agentId: "44444444-4444-4444-4444-444444444444" as UUID,
    character: { name: "TEE Endpoint Provider Test" },
    plugins: [] as Plugin[],
    actions: [] as NonNullable<Plugin["actions"]>,
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
    },
    reloadPlugin: async (plugin: Plugin) => {
      await runtime.registerPlugin(plugin);
    },
    unloadPlugin: async () => null,
    getAllPluginOwnership: () => [],
  } as unknown as IAgentRuntime & {
    actions: NonNullable<Plugin["actions"]>;
    plugins: Plugin[];
  };
  return runtime;
}

function providerWithMetadata(
  metadata: Record<string, unknown> | undefined,
): RemoteCapabilityEndpointProvider<Record<string, never>> {
  return {
    id: "dstack",
    provision: async () => ({
      providerId: "dstack",
      endpoint: {
        id: "tee-runner",
        baseUrl: "https://tee-runner.example.test",
      },
      metadata,
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
