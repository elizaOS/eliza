import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import {
  installRemoteCapabilityEndpoint,
  provisionCloudCapabilitySandbox,
} from "./remote-capability-cloud-sandbox.ts";
import { assertRemoteCapabilityEndpointConformance } from "./remote-capability-endpoint-conformance.ts";
import {
  summarizeRemoteCapabilityLiveCi,
  summarizeRemoteCapabilityLiveRuntime,
  summarizeRemoteCapabilityLiveSync,
  writeRemoteCapabilityLiveReport,
} from "./remote-capability-live-report.ts";
import { syncRemoteCapabilityPlugins } from "./remote-plugin-adapter.ts";

const cloudLive =
  process.env.ELIZA_REMOTE_CAPABILITY_CLOUD_LIVE === "1" &&
  typeof process.env.ELIZAOS_CLOUD_API_KEY === "string" &&
  process.env.ELIZAOS_CLOUD_API_KEY.trim()
    ? it
    : it.skip;
const registeredPluginNames: string[] = [];

describe("cloud capability sandbox live smoke", () => {
  afterEach(() => {
    for (const pluginName of registeredPluginNames.splice(0)) {
      unregisterPluginViews(pluginName);
    }
  });

  cloudLive(
    "provisions a cloud sandbox endpoint and treats its remote plugin as local runtime surface",
    async () => {
      const authToken = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
      if (!authToken) throw new Error("ELIZAOS_CLOUD_API_KEY is required.");

      const cloudApiBase =
        process.env.ELIZAOS_CLOUD_BASE_URL?.trim() ||
        process.env.ELIZA_CLOUD_BASE_URL?.trim() ||
        "https://api.elizacloud.ai";
      const endpointId = "cloud-live-capability";
      const runtime = makeRuntime();
      let agentId: string | undefined;

      try {
        const provisioned = await provisionCloudCapabilitySandbox({
          cloudApiBase,
          authToken,
          name: `Remote Capability Live ${Date.now()}`,
          bio: [
            "Live CI smoke for capability-router remote plugin modules.",
            "Expose at least one action, provider, route, JSON model handler, lifecycle hook, event handler, service method, app bridge hook, evaluator, response-handler evaluator, response-handler field evaluator, and compiled view.",
          ],
          endpointId,
          timeoutMs: 180_000,
          pollIntervalMs: 5_000,
          onProgress: (status, detail) => {
            console.log(`[cloud-capability-live] ${status}: ${detail ?? ""}`);
          },
        });
        agentId = provisioned.agentId;

        installRemoteCapabilityEndpoint(runtime, {
          enabled: true,
          endpoints: [provisioned.endpoint],
          environment: "server",
          requestTimeoutMs: 60_000,
        });

        const conformance = await assertRemoteCapabilityEndpointConformance({
          endpoint: provisioned.endpoint,
          requestTimeoutMs: 60_000,
          actionContent: { text: "remote capability cloud live conformance" },
          routeBody: { live: true, provider: "cloud" },
        });
        expect(conformance).toMatchObject({
          endpointId,
          moduleCount: expect.any(Number),
          exercised: {
            action: expect.any(String),
            provider: expect.any(String),
            route: expect.any(String),
            viewAsset: expect.any(String),
            model: expect.any(String),
            lifecycle: expect.any(String),
            event: expect.any(String),
            service: expect.any(String),
            appBridge: expect.any(String),
            evaluator: expect.any(String),
            responseHandlerEvaluator: expect.any(String),
            responseHandlerFieldEvaluator: expect.any(String),
          },
        });
        const sync = await syncRemoteCapabilityPlugins(runtime, {
          trustPolicy: {
            allowedEndpointIds: [endpointId],
            requireEndpointId: true,
          },
        });
        expect(sync.registered.length).toBeGreaterThan(0);
        expect(sync.trustDecisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              endpointId,
              trusted: true,
              reason: "allowed",
            }),
          ]),
        );

        expect(runtime.actions.length).toBeGreaterThan(0);
        expect(runtime.providers.length).toBeGreaterThan(0);
        expect(runtime.routes.length).toBeGreaterThan(0);
        await writeRemoteCapabilityLiveReport("cloud", {
          schemaVersion: 1,
          kind: "cloud",
          cloudApiBase,
          endpointId,
          agentId,
          observedAt: new Date().toISOString(),
          conformance,
          sync: summarizeRemoteCapabilityLiveSync(sync),
          runtime: summarizeRemoteCapabilityLiveRuntime(runtime),
          ci: summarizeRemoteCapabilityLiveCi(),
        });
      } finally {
        if (agentId) {
          await deleteCloudAgent(cloudApiBase, authToken, agentId).catch(
            (error) => {
              console.warn(
                `[cloud-capability-live] failed to enqueue cleanup for ${agentId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            },
          );
        }
      }
    },
    240_000,
  );
});

function makeRuntime(): IAgentRuntime {
  const runtime = {
    agentId: "22222222-2222-2222-2222-222222222222" as UUID,
    character: { name: "Cloud Capability Live Test" },
    plugins: [] as Plugin[],
    actions: [] as NonNullable<Plugin["actions"]>,
    providers: [] as NonNullable<Plugin["providers"]>,
    evaluators: [] as NonNullable<Plugin["evaluators"]>,
    routes: [] as NonNullable<Plugin["routes"]>,
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
      registeredPluginNames.push(plugin.name);
      await registerPluginViews(plugin);
    },
    reloadPlugin: async (plugin: Plugin) => {
      await runtime.registerPlugin(plugin);
    },
    unloadPlugin: async () => null,
    getAllPluginOwnership: () => [],
  } as Partial<IAgentRuntime> as IAgentRuntime & {
    actions: NonNullable<Plugin["actions"]>;
    providers: NonNullable<Plugin["providers"]>;
    evaluators: NonNullable<Plugin["evaluators"]>;
    routes: NonNullable<Plugin["routes"]>;
  };
  return runtime;
}

async function deleteCloudAgent(
  cloudApiBase: string,
  authToken: string,
  agentId: string,
): Promise<void> {
  const baseUrl = normalizeCloudApiBase(cloudApiBase);
  const response = await fetch(
    `${baseUrl}/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${authToken}` },
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `DELETE returned ${response.status}: ${await response.text()}`,
    );
  }
}

function normalizeCloudApiBase(value: string): string {
  const url = new URL(value.trim().replace(/\/+$/, ""));
  if (
    url.hostname === "www.elizacloud.ai" ||
    url.hostname === "elizacloud.ai"
  ) {
    url.hostname = "api.elizacloud.ai";
  }
  return url.toString().replace(/\/+$/, "");
}
