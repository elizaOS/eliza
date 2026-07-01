/**
 * Durable memory of an INTERRUPTED domain purchase (the buy route's 502
 * `persist_failed_recoverable`: the org was charged and the domain registered,
 * but the attach to the app never completed).
 *
 * The server finishes such a purchase for free on a retried buy
 * (`hasUnrefundedDomainPurchase` → free assign), but ONLY a buy request
 * reaches that branch — the availability check reports the org's own
 * registered-but-unattached domain as plain unavailable. Without a durable
 * marker, an agent that loses the in-flight recovery confirmation (user
 * canceled, session ended) would later tell the owner their own paid domain
 * "isn't available to register" and never issue the recovering buy. This fact
 * is that marker: written when the 502 lands, consulted by the fresh-ask
 * unavailable branch, and removed once a buy for the domain succeeds.
 *
 * Same conventions as app-facts.ts: keyed per (appId, domain), entity-scoped
 * across rooms, best-effort (a memory failure never fails the action).
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { logger, MemoryType } from "@elizaos/core";

/** Marks facts written by this module so we can find + dedupe them. */
export const INTERRUPTED_DOMAIN_PURCHASE_SOURCE =
  "cloud_apps_domain_purchase_interrupted";

async function findInterruptedFactRow(
  runtime: IAgentRuntime,
  message: Memory,
  appId: string,
  domain: string,
): Promise<Memory | null> {
  if (typeof runtime.getMemories !== "function") return null;
  if (!message.entityId) return null;
  try {
    const rows = await runtime.getMemories({
      tableName: "facts",
      // Entity-scoped across ALL rooms: the owner may cancel the recovery in
      // one connector and finish it from another.
      entityId: message.entityId,
      count: 200,
      unique: false,
    });
    if (!Array.isArray(rows)) return null;
    return (
      rows.find((m) => {
        const md = m.metadata as Record<string, unknown> | undefined;
        return (
          md?.source === INTERRUPTED_DOMAIN_PURCHASE_SOURCE &&
          md?.appId === appId &&
          md?.domain === domain
        );
      }) ?? null
    );
  } catch (err) {
    logger.warn(
      `[CloudApps] interrupted-purchase fact read failed for ${domain}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * True when an interrupted (charged + registered, unattached) purchase of
 * `domain` for `appId` is on record for this user.
 */
export async function hasInterruptedDomainPurchase(
  runtime: IAgentRuntime,
  message: Memory,
  appId: string,
  domain: string,
): Promise<boolean> {
  return (
    (await findInterruptedFactRow(runtime, message, appId, domain)) !== null
  );
}

/**
 * Record that a purchase of `domain` charged + registered but failed to
 * attach. Idempotent per (appId, domain); best-effort.
 */
export async function recordInterruptedDomainPurchase(
  runtime: IAgentRuntime,
  message: Memory,
  app: { id: string; name: string },
  domain: string,
): Promise<boolean> {
  if (typeof runtime.createMemory !== "function") return false;
  if (!message.entityId) return false;
  try {
    const existing = await findInterruptedFactRow(
      runtime,
      message,
      app.id,
      domain,
    );
    if (existing) return true;
    await runtime.createMemory(
      {
        entityId: message.entityId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: `User's purchase of the domain ${domain} for Eliza Cloud app "${app.name}" (app ${app.id}) was charged and registered but not yet attached — a retried buy finishes it without a new charge.`,
          type: "fact",
        },
        metadata: {
          type: MemoryType.CUSTOM,
          source: INTERRUPTED_DOMAIN_PURCHASE_SOURCE,
          appId: app.id,
          appName: app.name,
          domain,
          tags: ["fact", "cloud_app", "domain_purchase", app.id, domain],
          // A standing money fact must not decay before it is resolved.
          kind: "durable" as const,
          confidence: 1,
          interruptedAt: new Date().toISOString(),
        },
      } as Memory,
      "facts",
      true,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[CloudApps] Failed to record interrupted purchase of ${domain}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Clear the interrupted-purchase marker once a buy for `domain` succeeded
 * (fresh, replayed, or recovered). Best-effort.
 */
export async function removeInterruptedDomainPurchase(
  runtime: IAgentRuntime,
  message: Memory,
  appId: string,
  domain: string,
): Promise<boolean> {
  if (typeof runtime.deleteMemory !== "function") return false;
  try {
    const existing = await findInterruptedFactRow(
      runtime,
      message,
      appId,
      domain,
    );
    if (!existing?.id) return false;
    await runtime.deleteMemory(existing.id);
    return true;
  } catch (err) {
    logger.warn(
      `[CloudApps] Failed to remove interrupted-purchase fact for ${domain}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
