/**
 * Live smoke test for the URL-backed endpoint providers (home-machine,
 * mobile-companion, desktop-companion). Skipped unless
 * ELIZA_REMOTE_CAPABILITY_PROVIDER_LIVE=1. Explicit runs require home and mobile
 * endpoints; desktop is optional, matching CI certification. Connects a real
 * endpoint, treats its remote plugin as local
 * runtime surface, runs the full endpoint conformance sweep, and writes a
 * provider live report. The runtime is an in-memory stub but the endpoint and
 * its remote plugin are real.
 */
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import type {
  HttpPlugin as Plugin,
  Route,
} from "@elizaos/shared/api/http-plugin";
import {
  getHttpRuntime,
  registerHttpPluginRoutes,
} from "@elizaos/shared/api/http-plugin-runtime";
import { describe, expect, it } from "vitest";
import { assertRemoteCapabilityEndpointConformance } from "./remote-capability-endpoint-conformance.ts";
import {
  connectRemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointProvider,
} from "./remote-capability-endpoint-provider.ts";
import {
  summarizeRemoteCapabilityEndpointUrlFingerprint,
  summarizeRemoteCapabilityLiveCi,
  summarizeRemoteCapabilityLiveRuntime,
  summarizeRemoteCapabilityLiveSync,
  writeRemoteCapabilityLiveReport,
} from "./remote-capability-live-report.ts";
import {
  desktopCompanionCapabilityEndpointProvider,
  homeMachineCapabilityEndpointProvider,
  mobileCompanionCapabilityEndpointProvider,
  type UrlRemoteCapabilityEndpointProviderOptions,
} from "./remote-capability-url-endpoint-providers.ts";

type ProviderLiveTarget = {
  label: string;
  provider: RemoteCapabilityEndpointProvider<UrlRemoteCapabilityEndpointProviderOptions>;
  envPrefix: string;
  defaultEndpointId: string;
  endpointRuntime: string;
};

const providerTargets: ProviderLiveTarget[] = [
  {
    label: "home-machine",
    provider: homeMachineCapabilityEndpointProvider,
    envPrefix: "HOME_MACHINE",
    defaultEndpointId: "home-machine-live-capability",
    endpointRuntime: "home-machine",
  },
  {
    label: "mobile-companion",
    provider: mobileCompanionCapabilityEndpointProvider,
    envPrefix: "MOBILE_COMPANION",
    defaultEndpointId: "mobile-companion-live-capability",
    endpointRuntime: "mobile-companion",
  },
  {
    label: "desktop-companion",
    provider: desktopCompanionCapabilityEndpointProvider,
    envPrefix: "DESKTOP_COMPANION",
    defaultEndpointId: "desktop-companion-live-capability",
    endpointRuntime: "desktop-companion",
  },
];

describe("URL-backed remote capability endpoint providers live smoke", () => {
  for (const target of providerTargets) {
    const options = readProviderOptions(target);
    const live =
      process.env.ELIZA_REMOTE_CAPABILITY_PROVIDER_LIVE === "1" &&
      (options !== null || target.label !== "desktop-companion")
        ? it
        : it.skip;

    live(
      `connects a real ${target.label} endpoint and treats its remote plugin as local runtime surface`,
      async () => {
        if (!options) {
          throw new Error(`${target.envPrefix} live endpoint is required.`);
        }
        const runtime = makeRuntime(target.label);
        const result = await connectRemoteCapabilityEndpointProvider(runtime, {
          provider: target.provider,
          provisionOptions: options,
          unloadMissing: true,
          requestTimeoutMs: 60_000,
        });
        expect(result.providerId).toBe(target.provider.id);
        expect(result.sync.registered.length).toBeGreaterThan(0);
        expect(result.sync.trustDecisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              endpointId: options.endpointId,
              trusted: true,
              reason: "allowed",
            }),
          ]),
        );

        expect(runtime.actions.length).toBeGreaterThan(0);
        expect(runtime.providers.length).toBeGreaterThan(0);
        expect(getHttpRuntime(runtime).routes.length).toBeGreaterThan(0);
        const moduleWithView = runtime.plugins.find(
          (plugin) => (plugin.views ?? []).length > 0,
        );
        expect(moduleWithView?.views?.length ?? 0).toBeGreaterThan(0);

        const conformance = await assertRemoteCapabilityEndpointConformance({
          endpoint: result.endpoint,
          requestTimeoutMs: 60_000,
          actionContent: {
            text: `${target.label} live capability conformance`,
          },
          routeBody: { live: true, provider: target.label },
        });
        expect(conformance).toMatchObject({
          endpointId: options.endpointId,
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
        await writeRemoteCapabilityLiveReport(target.label, {
          schemaVersion: 1,
          kind: "provider",
          provider: target.label,
          providerId: result.providerId,
          providerEvidence: {
            provider: target.label,
            endpointRuntime: target.endpointRuntime,
            agentRuntime: "github-actions",
            connection: "url-backed-provider",
          },
          endpointUrlSha256: summarizeRemoteCapabilityEndpointUrlFingerprint(
            options.baseUrl,
          ),
          endpointId: options.endpointId,
          observedAt: new Date().toISOString(),
          conformance,
          sync: summarizeRemoteCapabilityLiveSync(result.sync),
          runtime: summarizeRemoteCapabilityLiveRuntime(runtime),
          ci: summarizeRemoteCapabilityLiveCi(),
        });
      },
      120_000,
    );
  }
});

function readProviderOptions(
  target: ProviderLiveTarget,
): UrlRemoteCapabilityEndpointProviderOptions | null {
  const baseUrl = process.env[`ELIZA_REMOTE_CAPABILITY_${target.envPrefix}_URL`]
    ?.trim()
    .replace(/\/+$/, "");
  if (!baseUrl) return null;
  const endpointId =
    process.env[
      `ELIZA_REMOTE_CAPABILITY_${target.envPrefix}_ENDPOINT_ID`
    ]?.trim() || target.defaultEndpointId;
  const token =
    process.env[`ELIZA_REMOTE_CAPABILITY_${target.envPrefix}_TOKEN`]?.trim();
  const allowedModuleIds = parseCsv(
    process.env[`ELIZA_REMOTE_CAPABILITY_${target.envPrefix}_MODULES`],
  );
  return {
    baseUrl,
    endpointId,
    ...(token ? { token } : {}),
    ...(allowedModuleIds.length === 0 ? {} : { allowedModuleIds }),
  };
}

function parseCsv(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function makeRuntime(label: string): IAgentRuntime {
  const runtime = {
    agentId: "55555555-5555-5555-5555-555555555555" as UUID,
    character: { name: `${label} Capability Live Test` },
    plugins: [] as Plugin[],
    actions: [] as NonNullable<Plugin["actions"]>,
    providers: [] as NonNullable<Plugin["providers"]>,
    evaluators: [] as NonNullable<Plugin["evaluators"]>,

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
      registerHttpPluginRoutes(runtime, plugin);
    },
    reloadPlugin: async (plugin: Plugin) => {
      await runtime.registerPlugin(plugin);
    },
    unloadPlugin: async () => null,
    getAllPluginOwnership: () =>
      runtime.plugins.map((plugin: Plugin) => ({
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
  };
  getHttpRuntime(runtime).routes = [] as NonNullable<
    Plugin["routes"]
  > as Route[];
  return runtime;
}
