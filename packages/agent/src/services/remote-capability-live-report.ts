import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { IAgentRuntime, Plugin } from "@elizaos/core";

export type RemoteCapabilityLiveSyncSummaryInput = {
  registered: Plugin[];
  unloaded: string[];
  skipped: string[];
  trustDecisions: Array<Record<string, unknown>>;
};

export type RemoteCapabilityLiveRuntimeSummaryInput = IAgentRuntime & {
  actions: NonNullable<Plugin["actions"]>;
  providers: NonNullable<Plugin["providers"]>;
  evaluators: NonNullable<Plugin["evaluators"]>;
  routes: NonNullable<Plugin["routes"]>;
};

export async function writeRemoteCapabilityLiveReport(
  name: string,
  report: Record<string, unknown>,
): Promise<void> {
  const outputDir = process.env.ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR?.trim();
  if (!outputDir) return;
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      "Remote capability live report name must use lowercase letters, numbers, or hyphens.",
    );
  }
  validateRemoteCapabilityLiveReportName(name, report);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, `${name}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function validateRemoteCapabilityLiveReportName(
  name: string,
  report: Record<string, unknown>,
): void {
  if (report.kind !== "cloud" && report.kind !== "provider") {
    throw new Error(
      'Remote capability live report kind must be either "cloud" or "provider".',
    );
  }
  if (report.kind === "cloud" && name !== "cloud") {
    throw new Error('Remote capability cloud live report name must be "cloud".');
  }
  if (report.kind === "cloud") {
    rejectRemoteCapabilityLiveReportFields(report, [
      "provider",
      "providerId",
      "endpointUrlSha256",
    ]);
  }
  if (report.kind === "provider" && report.provider !== name) {
    throw new Error(
      "Remote capability provider live report name must match provider.",
    );
  }
  if (report.kind === "provider" && report.providerId !== report.provider) {
    throw new Error(
      "Remote capability provider live report providerId must match provider.",
    );
  }
  if (report.kind === "provider") {
    rejectRemoteCapabilityLiveReportFields(report, ["agentId", "cloudApiBase"]);
  }
}

function rejectRemoteCapabilityLiveReportFields(
  report: Record<string, unknown>,
  fields: string[],
): void {
  const field = fields.find((candidate) => Object.hasOwn(report, candidate));
  if (field) {
    throw new Error(
      `Remote capability live report field "${field}" is not valid for ${report.kind} reports.`,
    );
  }
}

export function summarizeRemoteCapabilityLiveCi():
  | Record<string, string>
  | undefined {
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

export function summarizeRemoteCapabilityEndpointUrlFingerprint(
  baseUrl: string,
): string {
  return createHash("sha256")
    .update(normalizeRemoteCapabilityEndpointBaseUrl(baseUrl))
    .digest("hex");
}

export function summarizeRemoteCapabilityLiveSync(
  sync: RemoteCapabilityLiveSyncSummaryInput,
): Record<string, unknown> {
  return {
    registered: sync.registered.map((plugin) => plugin.name),
    registeredModules: sync.registered.map((plugin) => ({
      pluginName: plugin.name,
      moduleId: plugin.config?.remoteCapabilityModuleId,
      endpointId: plugin.config?.remoteCapabilityEndpointId,
      ...summarizeRemoteCapabilityPluginSurfaces(plugin),
    })),
    unloaded: sync.unloaded,
    skipped: sync.skipped,
    trustDecisions: sync.trustDecisions,
  };
}

export function summarizeRemoteCapabilityLiveRuntime(
  runtime: RemoteCapabilityLiveRuntimeSummaryInput,
): Record<string, unknown> {
  const plugins = runtime.plugins ?? [];
  return {
    pluginCount: runtime.plugins?.length ?? 0,
    remotePlugins: plugins
      .filter(
        (plugin) =>
          plugin.config?.remoteCapabilityModuleId &&
          plugin.config?.remoteCapabilityEndpointId,
      )
      .map((plugin) => ({
        pluginName: plugin.name,
        moduleId: plugin.config?.remoteCapabilityModuleId,
        endpointId: plugin.config?.remoteCapabilityEndpointId,
        ...summarizeRemoteCapabilityPluginSurfaces(plugin),
      })),
    actionCount: runtime.actions.length,
    providerCount: runtime.providers.length,
    evaluatorCount: runtime.evaluators.length,
    responseHandlerEvaluatorCount: sumPluginCounts(
      plugins,
      (plugin) => plugin.responseHandlerEvaluators?.length ?? 0,
    ),
    responseHandlerFieldEvaluatorCount: sumPluginCounts(
      plugins,
      (plugin) => plugin.responseHandlerFieldEvaluators?.length ?? 0,
    ),
    routeCount: runtime.routes.length,
    modelCount: sumPluginCounts(
      plugins,
      (plugin) => Object.keys(plugin.models ?? {}).length,
    ),
    eventCount: sumPluginCounts(plugins, countPluginEventHandlers),
    serviceCount: sumPluginCounts(
      plugins,
      (plugin) => plugin.services?.length ?? 0,
    ),
    appCount: sumPluginCounts(plugins, (plugin) => (plugin.app ? 1 : 0)),
    appBridgeCount: sumPluginCounts(plugins, (plugin) =>
      plugin.appBridge ? 1 : 0,
    ),
    lifecycleCount: sumPluginCounts(plugins, countPluginLifecycleHooks),
    widgetCount: sumPluginCounts(
      plugins,
      (plugin) => plugin.widgets?.length ?? 0,
    ),
    componentTypeCount: sumPluginCounts(
      plugins,
      (plugin) => plugin.componentTypes?.length ?? 0,
    ),
    viewCount: sumPluginCounts(plugins, (plugin) => plugin.views?.length ?? 0),
  };
}

function summarizeRemoteCapabilityPluginSurfaces(
  plugin: Plugin,
): Record<string, number> {
  return {
    actionCount: plugin.actions?.length ?? 0,
    providerCount: plugin.providers?.length ?? 0,
    evaluatorCount: plugin.evaluators?.length ?? 0,
    responseHandlerEvaluatorCount:
      plugin.responseHandlerEvaluators?.length ?? 0,
    responseHandlerFieldEvaluatorCount:
      plugin.responseHandlerFieldEvaluators?.length ?? 0,
    routeCount: plugin.routes?.length ?? 0,
    modelCount: Object.keys(plugin.models ?? {}).length,
    eventCount: countPluginEventHandlers(plugin),
    serviceCount: plugin.services?.length ?? 0,
    appCount: plugin.app ? 1 : 0,
    appBridgeCount: plugin.appBridge ? 1 : 0,
    lifecycleCount: countPluginLifecycleHooks(plugin),
    widgetCount: plugin.widgets?.length ?? 0,
    componentTypeCount: plugin.componentTypes?.length ?? 0,
    viewCount: plugin.views?.length ?? 0,
  };
}

function countPluginEventHandlers(plugin: Plugin): number {
  return Object.values(plugin.events ?? {}).reduce(
    (count, handlers) => count + handlers.length,
    0,
  );
}

function countPluginLifecycleHooks(plugin: Plugin): number {
  return (
    (plugin.init ? 1 : 0) +
    (plugin.dispose ? 1 : 0) +
    (plugin.applyConfig ? 1 : 0)
  );
}

function sumPluginCounts(
  plugins: Plugin[],
  count: (plugin: Plugin) => number,
): number {
  return plugins.reduce((total, plugin) => total + count(plugin), 0);
}

function normalizeRemoteCapabilityEndpointBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (url.username || url.password) {
    throw new Error(
      "Remote capability endpoint baseUrl must not include embedded credentials.",
    );
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
