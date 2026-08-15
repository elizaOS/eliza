/**
 * CLOUD_ACCOUNT provider — a compact Eliza Cloud account summary (credit
 * balance + hosted-agent inventory) composed into the planner context only
 * when the turn's selected contexts touch cloud/settings/finance.
 *
 * `dynamic: true` keeps it out of the default composeState sweep; the plugin's
 * `cloud` context registration (src/index.ts init) is the Stage-1 routing
 * signal that pulls it in when the user talks about their cloud account,
 * credits, billing, or hosted agents. Signed out it renders `{ text: "" }` —
 * zero prompt tokens. Fetch failures serve the stale cache when warm and
 * otherwise stay empty (never fabricated zeros), per the repo error policy.
 *
 * Mirrors plugin-cloud-apps' CLOUD_APPS provider, including the cache
 * invalidation invariant: every mutating cloud action must call
 * `invalidateCloudAccountCache(runtime)` so the 60s TTL never serves a
 * just-changed account state within the same conversation.
 */

import type { AgentListItemDto } from "@elizaos/cloud-sdk";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import { createElizaCloudClient } from "../utils/sdk-client";

const TOP_UP_URL = "https://cloud.eliza.app/cloud/billing";
const TTL = 60_000;
const MAX_AGENTS_RENDERED = 8;

interface AccountSnapshot {
  balance: number;
  agents: AgentListItemDto[];
}

const accountCaches = new WeakMap<
  IAgentRuntime,
  { value: AccountSnapshot; at: number }
>();
const accountRefreshInFlight = new WeakSet<IAgentRuntime>();

/**
 * Drop the cached account snapshot so the next provider read re-fetches live.
 * Call from every mutating cloud action (top-up, agent create/delete, key
 * create) — otherwise the provider keeps narrating pre-mutation state for up
 * to 60s inside the same conversation.
 */
export function invalidateCloudAccountCache(runtime: IAgentRuntime): void {
  accountCaches.delete(runtime);
}

/**
 * Shared snapshot for sibling providers (elizacloud_credits) so one
 * /credits/balance window feeds every renderer instead of each provider
 * fetching the same number through its own client on the message hot path.
 */
export function getCachedAccountSnapshot(
  runtime: IAgentRuntime,
): AccountSnapshot | null {
  return accountCaches.get(runtime)?.value ?? null;
}

async function fetchAccountSnapshot(
  runtime: IAgentRuntime,
): Promise<AccountSnapshot> {
  const sdk = createElizaCloudClient(runtime);
  const [{ balance }, agentsResponse] = await Promise.all([
    sdk.getCreditsBalance(),
    sdk.listAgents(),
  ]);
  const snapshot: AccountSnapshot = { balance, agents: agentsResponse.data };
  accountCaches.set(runtime, { value: snapshot, at: Date.now() });
  return snapshot;
}

/** Refresh the snapshot out-of-band; used when a stale cache was just served. */
export function scheduleAccountSnapshotRefresh(runtime: IAgentRuntime): void {
  if (accountRefreshInFlight.has(runtime)) return;
  accountRefreshInFlight.add(runtime);
  void fetchAccountSnapshot(runtime)
    // error-policy:J6 background refresh is best-effort; the caller already
    // rendered the stale snapshot and the next turn retries.
    .catch(() => undefined)
    .finally(() => {
      accountRefreshInFlight.delete(runtime);
    });
}

const EMPTY: ProviderResult = { text: "" };

function render(snapshot: AccountSnapshot, organizationId?: string): ProviderResult {
  const low = snapshot.balance < 2.0;
  const critical = snapshot.balance < 0.5;

  const lines: string[] = [];
  const orgSuffix = organizationId ? ` (org ${organizationId})` : "";
  let creditsLine = `Eliza Cloud account${orgSuffix}: $${snapshot.balance.toFixed(2)} credits`;
  if (critical) creditsLine += ` (CRITICAL — top up at ${TOP_UP_URL})`;
  else if (low) creditsLine += ` (LOW — top up at ${TOP_UP_URL})`;
  lines.push(creditsLine);

  if (snapshot.agents.length === 0) {
    lines.push("Hosted agents: none yet.");
  } else {
    lines.push(
      snapshot.agents.length === 1
        ? "1 hosted agent:"
        : `${snapshot.agents.length} hosted agents:`,
    );
    for (const agent of snapshot.agents.slice(0, MAX_AGENTS_RENDERED)) {
      lines.push(`- ${agent.agentName ?? agent.id} (${agent.status})`);
    }
    if (snapshot.agents.length > MAX_AGENTS_RENDERED) {
      lines.push(`…and ${snapshot.agents.length - MAX_AGENTS_RENDERED} more`);
    }
  }

  return {
    text: lines.join("\n"),
    values: {
      cloudCredits: snapshot.balance,
      cloudCreditsLow: low,
      cloudCreditsCritical: critical,
      cloudAgentCount: snapshot.agents.length,
      cloudTopUpUrl: TOP_UP_URL,
    },
    data: {
      agents: snapshot.agents.slice(0, MAX_AGENTS_RENDERED).map((agent) => ({
        id: agent.id,
        name: agent.agentName,
        status: agent.status,
      })),
    },
  };
}

export const cloudAccountProvider: Provider = {
  name: "CLOUD_ACCOUNT",
  description:
    "The user's Eliza Cloud account state: credit balance and hosted agents.",
  descriptionCompressed: "Eliza Cloud account: credits + hosted agents.",
  dynamic: true,
  contexts: ["cloud", "settings", "finance"],
  contextGate: { anyOf: ["cloud", "settings", "finance"] },
  // Billing/operator context — admin+ only, same rationale as
  // elizacloud_credits (#12094 item 3).
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,
  cacheScope: "turn",
  position: 93,

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    if (!auth?.isAuthenticated()) return EMPTY;

    // Stale-while-revalidate: any snapshot renders immediately; expiry only
    // schedules a background refresh instead of blocking the turn on two WAN
    // round trips. Only the very first turn after boot blocks.
    const cached = accountCaches.get(runtime);
    if (cached) {
      if (Date.now() - cached.at >= TTL) {
        scheduleAccountSnapshotRefresh(runtime);
      }
      return render(cached.value, auth.getOrganizationId());
    }

    try {
      const snapshot = await fetchAccountSnapshot(runtime);
      return render(snapshot, auth.getOrganizationId());
    } catch (err) {
      logger.warn(
        `[CloudAccount] Failed to fetch account summary: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Cold fetch failed and there is no snapshot — stay empty; never
      // narrate fabricated zeros from a failed fetch.
      return { text: "", values: { cloudAccountUnavailable: true }, data: {} };
    }
  },
};

export default cloudAccountProvider;
