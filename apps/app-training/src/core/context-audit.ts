import type { AgentRuntime, Plugin } from "@elizaos/core";
import {
  ALL_CONTEXTS,
  type ContextResolutionSource,
  resolveActionContextResolution,
  resolveProviderContextResolution,
} from "./context-catalog.js";
import type { AgentContext } from "./context-types.js";

/** Eliza extends elizaOS plugins/actions/providers with optional context hints. */
type PluginWithContexts = Plugin & { contexts?: unknown };
type ActionWithContexts = NonNullable<Plugin["actions"]>[number] & {
  contexts?: unknown;
};
type ProviderWithContexts = NonNullable<Plugin["providers"]>[number] & {
  contexts?: unknown;
};

type AuditComponentType = "action" | "provider";

export interface ContextAuditEntry {
  pluginName: string;
  componentType: AuditComponentType;
  componentName: string;
  pluginContexts: AgentContext[];
  effectiveContexts: AgentContext[];
  source: ContextResolutionSource;
}

export interface ContextAuditGap {
  pluginName: string;
  componentType: AuditComponentType;
  componentName: string;
  fallbackContexts: AgentContext[];
  message: string;
}

export interface ContextAuditCoverageBreakdown {
  component: number;
  plugin: number;
  catalog: number;
  default: number;
}

export interface ContextAuditSummary {
  pluginCount: number;
  actionCount: number;
  providerCount: number;
  coverageBySource: {
    actions: ContextAuditCoverageBreakdown;
    providers: ContextAuditCoverageBreakdown;
    overall: ContextAuditCoverageBreakdown;
  };
  contextUsage: Record<
    AgentContext,
    {
      actions: number;
      providers: number;
    }
  >;
  gapCount: number;
}

export interface ContextAuditReport extends ContextAuditSummary {
  generatedAt: string;
  actions: ContextAuditEntry[];
  providers: ContextAuditEntry[];
  gaps: ContextAuditGap[];
}

function normalizeContexts(contexts?: unknown): AgentContext[] {
  if (!Array.isArray(contexts)) {
    return [];
  }

  return contexts.filter(
    (context): context is AgentContext =>
      typeof context === "string" && context.trim().length > 0,
  );
}

function createCoverageBreakdown(): ContextAuditCoverageBreakdown {
  return {
    component: 0,
    plugin: 0,
    catalog: 0,
    default: 0,
  };
}

function createContextUsage(): ContextAuditSummary["contextUsage"] {
  return Object.fromEntries(
    ALL_CONTEXTS.map((context) => [
      context,
      {
        actions: 0,
        providers: 0,
      },
    ]),
  ) as ContextAuditSummary["contextUsage"];
}

function countCoverage(
  breakdown: ContextAuditCoverageBreakdown,
  source: ContextResolutionSource,
): void {
  breakdown[source] += 1;
}

function recordContextUsage(
  usage: ContextAuditSummary["contextUsage"],
  componentType: AuditComponentType,
  contexts: AgentContext[],
): void {
  for (const context of contexts) {
    if (!usage[context]) {
      usage[context] = {
        actions: 0,
        providers: 0,
      };
    }

    if (componentType === "action") {
      usage[context].actions += 1;
    } else {
      usage[context].providers += 1;
    }
  }
}

function buildGapMessage(
  componentType: AuditComponentType,
  componentName: string,
): string {
  return `${componentType} ${componentName} resolved only through the default general-context fallback; add explicit contexts or extend the context catalog`;
}

function auditPluginEntries(
  plugins: Plugin[],
): Pick<ContextAuditReport, "actions" | "providers" | "gaps"> {
  const actions: ContextAuditEntry[] = [];
  const providers: ContextAuditEntry[] = [];
  const gaps: ContextAuditGap[] = [];

  for (const plugin of plugins) {
    const pluginName = plugin.name ?? "unknown-plugin";
    const pluginContexts = normalizeContexts(
      (plugin as PluginWithContexts).contexts,
    );

    for (const action of plugin.actions ?? []) {
      const resolution = resolveActionContextResolution(
        action.name,
        normalizeContexts((action as ActionWithContexts).contexts),
        pluginContexts,
      );
      const entry: ContextAuditEntry = {
        pluginName,
        componentType: "action",
        componentName: action.name,
        pluginContexts,
        effectiveContexts: resolution.contexts,
        source: resolution.source,
      };
      actions.push(entry);
      if (resolution.source === "default") {
        gaps.push({
          pluginName,
          componentType: "action",
          componentName: action.name,
          fallbackContexts: resolution.contexts,
          message: buildGapMessage("action", action.name),
        });
      }
    }

    for (const provider of plugin.providers ?? []) {
      const resolution = resolveProviderContextResolution(
        provider.name,
        normalizeContexts((provider as ProviderWithContexts).contexts),
        pluginContexts,
      );
      const entry: ContextAuditEntry = {
        pluginName,
        componentType: "provider",
        componentName: provider.name,
        pluginContexts,
        effectiveContexts: resolution.contexts,
        source: resolution.source,
      };
      providers.push(entry);
      if (resolution.source === "default") {
        gaps.push({
          pluginName,
          componentType: "provider",
          componentName: provider.name,
          fallbackContexts: resolution.contexts,
          message: buildGapMessage("provider", provider.name),
        });
      }
    }
  }

  return {
    actions,
    providers,
    gaps,
  };
}

export function auditPluginContextCoverage(
  plugins: Plugin[],
): ContextAuditReport {
  const { actions, providers, gaps } = auditPluginEntries(plugins);
  const actionCoverage = createCoverageBreakdown();
  const providerCoverage = createCoverageBreakdown();
  const overallCoverage = createCoverageBreakdown();
  const contextUsage = createContextUsage();

  for (const action of actions) {
    countCoverage(actionCoverage, action.source);
    countCoverage(overallCoverage, action.source);
    recordContextUsage(contextUsage, "action", action.effectiveContexts);
  }

  for (const provider of providers) {
    countCoverage(providerCoverage, provider.source);
    countCoverage(overallCoverage, provider.source);
    recordContextUsage(contextUsage, "provider", provider.effectiveContexts);
  }

  return {
    generatedAt: new Date().toISOString(),
    pluginCount: plugins.length,
    actionCount: actions.length,
    providerCount: providers.length,
    coverageBySource: {
      actions: actionCoverage,
      providers: providerCoverage,
      overall: overallCoverage,
    },
    contextUsage,
    gapCount: gaps.length,
    actions,
    providers,
    gaps,
  };
}

export function auditRuntimeContextCoverage(
  runtime: Pick<AgentRuntime, "plugins">,
): ContextAuditReport {
  return auditPluginContextCoverage(
    Array.isArray(runtime.plugins) ? runtime.plugins : [],
  );
}

export function hasContextAuditGaps(report: ContextAuditReport): boolean {
  return report.gapCount > 0;
}
