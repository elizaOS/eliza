/**
 * CLOUD_APPS provider — injects the user's Eliza Cloud app inventory into the
 * planner context so the agent can reason about "my apps" without first calling
 * an action. Modeled on plugin-elizacloud's `creditBalanceProvider`: 60s
 * in-memory cache keyed by runtime, context-gated to apps/finance/settings, and
 * EMPTY when no Cloud API key is configured.
 */

import type { AppDto } from "@elizaos/cloud-sdk";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  appStatus,
  appUrl,
  getCloudClient,
  resolveCloudApiKey,
} from "../client.js";

const TTL = 60_000;
const MAX_APPS_RENDERED = 10;
const appsCaches = new WeakMap<IAgentRuntime, { apps: AppDto[]; at: number }>();

/**
 * Drop the cached app list for a runtime so the next provider read re-fetches
 * live. Call after a mutating action (create/delete/deploy) so the CLOUD_APPS
 * provider never keeps serving a just-deleted app (or hiding a just-created one)
 * inside the 60s TTL window of the same conversation.
 */
export function invalidateAppsCache(runtime: IAgentRuntime): void {
  appsCaches.delete(runtime);
}

const EMPTY: ProviderResult = { text: "" };

function render(apps: AppDto[]): ProviderResult {
  if (apps.length === 0) {
    return {
      text: "Eliza Cloud apps: none yet.",
      values: { cloudAppCount: 0 },
      data: { apps: [] },
    };
  }

  const shown = apps.slice(0, MAX_APPS_RENDERED);
  const lines = shown.map((a) => {
    const url = appUrl(a);
    return `- ${a.name}${url ? ` (${url})` : ""} — ${appStatus(a)}`;
  });
  if (apps.length > shown.length) {
    lines.push(`…and ${apps.length - shown.length} more`);
  }

  const header =
    apps.length === 1
      ? "The user has 1 Eliza Cloud app:"
      : `The user has ${apps.length} Eliza Cloud apps:`;

  return {
    text: `${header}\n${lines.join("\n")}`,
    values: { cloudAppCount: apps.length },
    data: {
      apps: shown.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        status: a.deployment_status,
      })),
    },
  };
}

export const cloudAppsProvider: Provider = {
  name: "CLOUD_APPS",
  description: "The user's Eliza Cloud apps (name, URL, deployment status).",
  descriptionCompressed: "User's Eliza Cloud apps.",
  dynamic: true,
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  cacheStable: false,
  cacheScope: "turn",
  position: 92,

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (resolveCloudApiKey(runtime) === null) return EMPTY;

    const cached = appsCaches.get(runtime);
    if (cached && Date.now() - cached.at < TTL) {
      return render(cached.apps);
    }

    const client = getCloudClient(runtime);
    if (!client) return EMPTY;

    try {
      const { apps } = await client.listApps();
      const list = apps ?? [];
      appsCaches.set(runtime, { apps: list, at: Date.now() });
      return render(list);
    } catch (err) {
      logger.warn(
        `[CloudApps] Failed to fetch apps: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Serve a stale cache if we have one; otherwise stay EMPTY (no prompt bloat).
      if (cached) return render(cached.apps);
      return EMPTY;
    }
  },
};

export default cloudAppsProvider;
