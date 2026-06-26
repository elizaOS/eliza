/**
 * PA-specific dev registry-introspection route.
 *
 *   GET    /api/lifeops/dev/registries                               registry health (loopback)
 *
 * The generic `ScheduledTask` REST surface (list / schedule / verbs / history /
 * dev-log / spine-registry introspection) moved to
 * `@elizaos/plugin-scheduling`, which serves it on every platform. What stays
 * here is the composite `/api/lifeops/dev/registries` view, which fans out over
 * the PA-only registries (connectors, channels, send-policies, event-kinds, bus
 * families, blockers, workflow-steps, feature-flags) and merges them with the
 * runner-internal registries. The agent introspects this surface to learn what
 * behaviour is composable at runtime without source-code edits.
 */

import type { ScheduledTaskRunnerHandle } from "@elizaos/plugin-scheduling";
import { getChannelRegistry } from "../lifeops/channels/registry.js";
import { getConnectorRegistry } from "../lifeops/connectors/registry.js";
import {
  getBlockerRegistry,
  getEventKindRegistry,
  getFamilyRegistry,
  getFeatureFlagRegistry,
  getWorkflowStepRegistry,
} from "../lifeops/registries/index.js";
import { getSendPolicyRegistry } from "../lifeops/send-policy/registry.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

/**
 * Loopback-only check — the dev endpoints only respond when the request
 * arrives on a loopback interface.
 */
function isLoopback(ctx: LifeOpsRouteContext): boolean {
  const remote = ctx.req.socket.remoteAddress ?? "";
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote === ""
  );
}

interface ScheduledTaskRouteDeps {
  /** Resolves the runner for the current agent. */
  resolveRunner: (
    ctx: LifeOpsRouteContext,
  ) => Promise<ScheduledTaskRunnerHandle | null>;
}

const DEV_REGISTRIES_PATH = "/api/lifeops/dev/registries";

/**
 * Composite registry-introspection view returned by `GET /api/lifeops/dev/registries`.
 *
 * Combines runner-internal registries (gates, completion-checks, ladders, anchors,
 * consolidation policies) with the runtime-bound registries that govern outbound
 * dispatch and signal flow (connectors, channels, send-policies, event-kinds, bus
 * families, blockers). The agent introspects this surface to learn what behaviour
 * is composable at runtime without source-code edits.
 */
export interface DevRegistriesView {
  gates: string[];
  completionChecks: string[];
  ladders: string[];
  anchors: string[];
  consolidationPolicies: string[];
  connectors: Array<{
    kind: string;
    label: string;
    capabilities: readonly string[];
    modes: readonly string[];
    requiresApproval: boolean;
  }>;
  channels: Array<{
    kind: string;
    label: string;
    capabilities: {
      send: boolean;
      read: boolean;
      reminders: boolean;
      voice: boolean;
      attachments: boolean;
      quietHoursAware: boolean;
    };
  }>;
  sendPolicies: Array<{ kind: string; label: string; priority: number | null }>;
  eventKinds: Array<{ eventKind: string; label: string; provider: string }>;
  busFamilies: Array<{
    family: string;
    description: string;
    source: string;
    namespace: string | null;
  }>;
  blockers: Array<{ kind: string; label: string }>;
  workflowSteps: Array<{
    kind: string;
    label: string;
    description: string;
    provider: string;
  }>;
  featureFlags: Array<{
    key: string;
    label: string;
    description: string;
    defaultEnabled: boolean;
    namespace: string | null;
    builtin: boolean;
  }>;
}

function composeDevRegistriesView(
  ctx: LifeOpsRouteContext,
  runner: ScheduledTaskRunnerHandle,
): DevRegistriesView {
  const runnerView = runner.inspectRegistries();
  const runtime = ctx.state.runtime;

  const connectorRegistry = runtime ? getConnectorRegistry(runtime) : null;
  const channelRegistry = runtime ? getChannelRegistry(runtime) : null;
  const sendPolicyRegistry = runtime ? getSendPolicyRegistry(runtime) : null;
  const eventKindRegistry = runtime ? getEventKindRegistry(runtime) : null;
  const familyRegistry = runtime ? getFamilyRegistry(runtime) : null;
  const blockerRegistry = runtime ? getBlockerRegistry(runtime) : null;
  const workflowStepRegistry = runtime
    ? getWorkflowStepRegistry(runtime)
    : null;
  const featureFlagRegistry = runtime ? getFeatureFlagRegistry(runtime) : null;

  return {
    gates: runnerView.gates,
    completionChecks: runnerView.completionChecks,
    ladders: runnerView.ladders,
    anchors: runnerView.anchors,
    consolidationPolicies: runnerView.consolidationPolicies,
    connectors: connectorRegistry
      ? connectorRegistry.list().map((c) => ({
          kind: c.kind,
          label: c.describe.label,
          capabilities: c.capabilities,
          modes: c.modes,
          requiresApproval: c.requiresApproval === true,
        }))
      : [],
    channels: channelRegistry
      ? channelRegistry.list().map((c) => ({
          kind: c.kind,
          label: c.describe.label,
          capabilities: { ...c.capabilities },
        }))
      : [],
    sendPolicies: sendPolicyRegistry
      ? sendPolicyRegistry.list().map((p) => ({
          kind: p.kind,
          label: p.describe.label,
          priority: p.priority ?? null,
        }))
      : [],
    eventKinds: eventKindRegistry
      ? eventKindRegistry.list().map((e) => ({
          eventKind: e.eventKind,
          label: e.describe.label,
          provider: e.describe.provider,
        }))
      : [],
    busFamilies: familyRegistry
      ? familyRegistry.list().map((f) => ({
          family: f.family,
          description: f.description,
          source: f.source,
          namespace: f.namespace ?? null,
        }))
      : [],
    blockers: blockerRegistry
      ? blockerRegistry.list().map((b) => ({
          kind: b.kind,
          label: b.describe.label,
        }))
      : [],
    workflowSteps: workflowStepRegistry
      ? workflowStepRegistry.list().map((s) => ({
          kind: s.kind,
          label: s.describe.label,
          description: s.describe.description,
          provider: s.describe.provider,
        }))
      : [],
    featureFlags: featureFlagRegistry
      ? featureFlagRegistry.list().map((f) => ({
          key: f.key,
          label: f.label,
          description: f.description,
          defaultEnabled: f.defaultEnabled,
          namespace: f.namespace ?? null,
          builtin: featureFlagRegistry.isBuiltin(f.key),
        }))
      : [],
  };
}

export function makeScheduledTasksRouteHandler(
  deps: ScheduledTaskRouteDeps,
): (ctx: LifeOpsRouteContext) => Promise<boolean> {
  return async (ctx) => {
    const { method, pathname, json, error, res } = ctx;

    if (method === "GET" && pathname === DEV_REGISTRIES_PATH) {
      if (!isLoopback(ctx)) {
        error(res, "dev endpoints are loopback-only", 403);
        return true;
      }
      const runner = await deps.resolveRunner(ctx);
      if (!runner) return true;
      json(res, composeDevRegistriesView(ctx, runner));
      return true;
    }

    return false;
  };
}

export const DEV_REGISTRIES_ROUTE_PATHS = [
  { type: "GET" as const, path: DEV_REGISTRIES_PATH },
];
