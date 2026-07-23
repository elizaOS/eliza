/**
 * Routes the plugin-workflow HTTP surface (`/api/automations`, `/api/workflow/*`,
 * `/api/triggers*`) to a runtime that actually hosts it.
 *
 * The bundled mobile on-device agent never loads `@elizaos/plugin-workflow`
 * (see MOBILE_CORE_PLUGINS in `packages/agent/src/runtime/core-plugins.ts` —
 * phones cannot host the workflow runtime), so every workflow call against the
 * phone runtime 404s and the Automations view dead-ends even when the device is
 * signed into Eliza Cloud. When the active client points at that on-device
 * runtime AND a Cloud agent is linked in the agent-profile registry, the
 * workflow-surface client methods target the Cloud agent's API base instead:
 * a dedicated runtime serves the real data, and a shared-tier base answers with
 * the typed `workflow_requires_dedicated` gate the feed already renders as the
 * designed upgrade state. With no linked Cloud agent the calls stay on the
 * active base and the feed keeps its explicit unavailable state — this module
 * never fabricates a healthy response.
 *
 * Consumed by `client-automations.ts`, `client-workflow.ts`, and the trigger
 * methods in `client-agent.ts` (all of plugin-workflow's routes), plus
 * `AutomationsFeed` for cache-keying and upgrade-agent-id parsing. Scheduled
 * tasks (`plugin-scheduling`) run on-device and are intentionally NOT routed.
 */

import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { isMobileLocalAgentUrl } from "../first-run/mobile-runtime-mode";
import { getFrontendPlatform } from "../platform/platform-guards";
import { loadAgentProfileRegistry } from "../state/agent-profiles";
import {
  directCloudSharedAgentIdFromBase,
  isDedicatedCloudAgentBase,
  normalizeDirectCloudSharedAgentApiBase,
} from "../utils/cloud-agent-base";
import { ElizaClient } from "./client-base";

/** A Cloud runtime that should serve the workflow surface for this device. */
export interface WorkflowSurfaceTarget {
  /** Normalized API base of the linked Cloud agent (trailing slashes trimmed,
   *  shared bases reduced from `/bridge` to their REST adapter path). */
  baseUrl: string;
  /** Bearer for that base. A profile with no usable credential is never
   *  selected as a target, so this is always present. */
  token: string;
}

function normalizeBase(value: string): string {
  return normalizeDirectCloudSharedAgentApiBase(value).replace(/\/+$/, "");
}

/**
 * Pick the bearer for a Cloud workflow host. Cloud-hosted bases (dedicated
 * subdomain or the shared REST adapter) authenticate with the Cloud session
 * JWT — prefer the LIVE steward token over the profile's captured copy, which
 * can be stale after a refresh. A raw non-cloud bridge (`http://ip:port`)
 * authenticates with its own container bearer, so only the profile token is
 * valid there.
 */
function tokenForBase(
  baseUrl: string,
  profileToken: string | null,
): string | null {
  const isCloudHosted =
    isDedicatedCloudAgentBase(baseUrl) ||
    directCloudSharedAgentIdFromBase(baseUrl) !== null;
  if (isCloudHosted) {
    return readStoredStewardToken() ?? profileToken;
  }
  return profileToken;
}

function profileRecencyMs(profile: {
  lastConnectedAt?: string;
  createdAt: string;
}): number {
  const raw = profile.lastConnectedAt ?? profile.createdAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolve the Cloud runtime that should serve the workflow surface, or null
 * when the active base must keep serving it (which is every case except the
 * bundled mobile on-device runtime with a linked Cloud agent).
 *
 * Dedicated runtimes (agent subdomain or raw container bridge) are preferred
 * over shared REST-adapter bases: a dedicated base serves real workflow data
 * while a shared base can only answer with the upgrade gate. Ties break on the
 * most recently connected profile.
 */
export function resolveWorkflowSurfaceTarget(
  activeBaseUrl: string | null | undefined,
): WorkflowSurfaceTarget | null {
  const platform = getFrontendPlatform();
  if (platform !== "android" && platform !== "ios") return null;
  if (!isMobileLocalAgentUrl(activeBaseUrl ?? "")) return null;

  const registry = loadAgentProfileRegistry();
  const candidates = registry.profiles.flatMap((profile) => {
    if (profile.kind !== "cloud") return [];
    const base = profile.apiBase?.trim();
    if (!base || !/^https?:\/\//i.test(base)) return [];
    const baseUrl = normalizeBase(base);
    // A cloud profile without any usable credential (signed out, token
    // scrubbed) is not a live Cloud link — routing to it would trade the
    // honest unavailable state for a guaranteed 401.
    const token = tokenForBase(baseUrl, profile.accessToken ?? null);
    if (!token) return [];
    return [{ profile, baseUrl, token }];
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aShared = directCloudSharedAgentIdFromBase(a.baseUrl) !== null;
    const bShared = directCloudSharedAgentIdFromBase(b.baseUrl) !== null;
    if (aShared !== bShared) return aShared ? 1 : -1;
    return profileRecencyMs(b.profile) - profileRecencyMs(a.profile);
  });

  const chosen = candidates[0];
  return { baseUrl: chosen.baseUrl, token: chosen.token };
}

// One REST-only client per (base, token); never opens a WebSocket and never
// persists its base — the active singleton keeps owning session state.
let cachedRoutedClient: { key: string; client: ElizaClient } | null = null;

function routedClientFor(target: WorkflowSurfaceTarget): ElizaClient {
  const key = `${target.baseUrl}|${target.token}`;
  if (cachedRoutedClient?.key !== key) {
    cachedRoutedClient = {
      key,
      client: new ElizaClient(target.baseUrl, target.token),
    };
  }
  return cachedRoutedClient.client;
}

/**
 * The client a workflow-surface method must issue its request on: the active
 * client itself in the common case, or a Cloud-agent-bound client when the
 * active base is the bundled mobile runtime and a Cloud agent is linked.
 */
export function workflowSurfaceClient(active: ElizaClient): ElizaClient {
  const target = resolveWorkflowSurfaceTarget(active.baseUrl);
  if (!target) return active;
  return routedClientFor(target);
}

/**
 * The API base the workflow surface is effectively served from. AutomationsFeed
 * keys its row cache on this (so rerouted Cloud rows never masquerade as the
 * local agent's) and parses the upgrade agent id from it when the shared tier
 * answers with `workflow_requires_dedicated`.
 */
export function workflowSurfaceBaseUrl(
  activeBaseUrl: string | null | undefined,
): string {
  return (
    resolveWorkflowSurfaceTarget(activeBaseUrl)?.baseUrl ?? activeBaseUrl ?? ""
  );
}

/** Test-only: drop the memoized routed client between cases. */
export function __resetWorkflowSurfaceRoutingForTest(): void {
  cachedRoutedClient = null;
}
