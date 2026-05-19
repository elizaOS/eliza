import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { assertRemoteCapabilityEndpointConformance } from "./remote-capability-endpoint-conformance.ts";
import {
  connectRemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointProvider,
} from "./remote-capability-endpoint-provider.ts";
import {
  desktopCompanionCapabilityEndpointProvider,
  e2bCapabilityEndpointProvider,
  homeMachineCapabilityEndpointProvider,
  mobileCompanionCapabilityEndpointProvider,
  type UrlRemoteCapabilityEndpointProviderOptions,
} from "./remote-capability-url-endpoint-providers.ts";

type ProviderLiveTarget = {
  label: string;
  provider: RemoteCapabilityEndpointProvider<UrlRemoteCapabilityEndpointProviderOptions>;
  envPrefix: string;
  defaultEndpointId: string;
};

const providerTargets: ProviderLiveTarget[] = [
  {
    label: "e2b",
    provider: e2bCapabilityEndpointProvider,
    envPrefix: "E2B",
    defaultEndpointId: "e2b-live-capability",
  },
  {
    label: "home-machine",
    provider: homeMachineCapabilityEndpointProvider,
    envPrefix: "HOME_MACHINE",
    defaultEndpointId: "home-machine-live-capability",
  },
  {
    label: "mobile-companion",
    provider: mobileCompanionCapabilityEndpointProvider,
    envPrefix: "MOBILE_COMPANION",
    defaultEndpointId: "mobile-companion-live-capability",
  },
  {
    label: "desktop-companion",
    provider: desktopCompanionCapabilityEndpointProvider,
    envPrefix: "DESKTOP_COMPANION",
    defaultEndpointId: "desktop-companion-live-capability",
  },
];

const registeredPluginNames: string[] = [];

describe("URL-backed remote capability endpoint providers live smoke", () => {
  afterEach(() => {
    registeredPluginNames.length = 0;
  });

  for (const target of providerTargets) {
    const options = readProviderOptions(target);
    const live =
      process.env.ELIZA_REMOTE_CAPABILITY_PROVIDER_LIVE === "1" &&
      options !== null
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
        expect(runtime.routes.length).toBeGreaterThan(0);
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
        await writeLiveReport(target.label, {
          schemaVersion: 1,
          kind: "provider",
          provider: target.label,
          endpointId: options.endpointId,
          observedAt: new Date().toISOString(),
          conformance,
          sync: summarizeSync(result.sync),
          runtime: summarizeRuntime(runtime),
          ci: summarizeCi(),
        });
      },
      120_000,
    );
  }
});

async function writeLiveReport(
  name: string,
  report: Record<string, unknown>,
): Promise<void> {
  const outputDir = process.env.ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR?.trim();
  if (!outputDir) return;
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, `${name}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

function summarizeCi(): Record<string, string> | undefined {
  const runId = process.env.GITHUB_RUN_ID?.trim();
  if (!runId) return undefined;
  return {
    runId,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim() ?? "",
    workflow: process.env.GITHUB_WORKFLOW?.trim() ?? "",
    eventName: process.env.GITHUB_EVENT_NAME?.trim() ?? "",
    repository: process.env.GITHUB_REPOSITORY?.trim() ?? "",
    sha: process.env.GITHUB_SHA?.trim() ?? "",
    ref: process.env.GITHUB_REF?.trim() ?? "",
  };
}

function summarizeSync(sync: {
  registered: Plugin[];
  unloaded: string[];
  skipped: string[];
  trustDecisions: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    registered: sync.registered.map((plugin) => plugin.name),
    registeredModules: sync.registered.map((plugin) => ({
      pluginName: plugin.name,
      moduleId: plugin.config?.remoteCapabilityModuleId,
      endpointId: plugin.config?.remoteCapabilityEndpointId,
      actionCount: plugin.actions?.length ?? 0,
      providerCount: plugin.providers?.length ?? 0,
      evaluatorCount: plugin.evaluators?.length ?? 0,
      responseHandlerEvaluatorCount:
        plugin.responseHandlerEvaluators?.length ?? 0,
      responseHandlerFieldEvaluatorCount:
        plugin.responseHandlerFieldEvaluators?.length ?? 0,
      routeCount: plugin.routes?.length ?? 0,
      modelCount: Object.keys(plugin.models ?? {}).length,
      serviceCount: plugin.services?.length ?? 0,
      appBridgeCount: plugin.appBridge ? 1 : 0,
      lifecycleCount:
        (plugin.init ? 1 : 0) +
        (plugin.dispose ? 1 : 0) +
        (plugin.applyConfig ? 1 : 0),
      widgetCount: plugin.widgets?.length ?? 0,
      componentTypeCount: plugin.componentTypes?.length ?? 0,
      viewCount: plugin.views?.length ?? 0,
    })),
    unloaded: sync.unloaded,
    skipped: sync.skipped,
    trustDecisions: sync.trustDecisions,
  };
}

function summarizeRuntime(
  runtime: IAgentRuntime & {
    actions: NonNullable<Plugin["actions"]>;
    providers: NonNullable<Plugin["providers"]>;
    evaluators: NonNullable<Plugin["evaluators"]>;
    routes: NonNullable<Plugin["routes"]>;
  },
): Record<string, unknown> {
  return {
    pluginCount: runtime.plugins?.length ?? 0,
    actionCount: runtime.actions.length,
    providerCount: runtime.providers.length,
    evaluatorCount: runtime.evaluators.length,
    responseHandlerEvaluatorCount:
      runtime.plugins?.reduce(
        (count, plugin) =>
          count + (plugin.responseHandlerEvaluators?.length ?? 0),
        0,
      ) ?? 0,
    responseHandlerFieldEvaluatorCount:
      runtime.plugins?.reduce(
        (count, plugin) =>
          count + (plugin.responseHandlerFieldEvaluators?.length ?? 0),
        0,
      ) ?? 0,
    routeCount: runtime.routes.length,
    modelCount:
      runtime.plugins?.reduce(
        (count, plugin) => count + Object.keys(plugin.models ?? {}).length,
        0,
      ) ?? 0,
    serviceCount:
      runtime.plugins?.reduce(
        (count, plugin) => count + (plugin.services?.length ?? 0),
        0,
      ) ?? 0,
    appBridgeCount:
      runtime.plugins?.reduce(
        (count, plugin) => count + (plugin.appBridge ? 1 : 0),
        0,
      ) ?? 0,
    lifecycleCount:
      runtime.plugins?.reduce(
        (count, plugin) =>
          count +
          (plugin.init ? 1 : 0) +
          (plugin.dispose ? 1 : 0) +
          (plugin.applyConfig ? 1 : 0),
        0,
      ) ?? 0,
    widgetCount:
      runtime.plugins?.reduce(
        (count, plugin) => count + (plugin.widgets?.length ?? 0),
        0,
      ) ?? 0,
    componentTypeCount:
      runtime.plugins?.reduce(
        (count, plugin) => count + (plugin.componentTypes?.length ?? 0),
        0,
      ) ?? 0,
    viewCount:
      runtime.plugins?.reduce(
        (count, plugin) => count + (plugin.views?.length ?? 0),
        0,
      ) ?? 0,
  };
}

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
    },
    reloadPlugin: async (plugin: Plugin) => {
      await runtime.registerPlugin(plugin);
    },
    unloadPlugin: async () => null,
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
  };
  return runtime;
}
