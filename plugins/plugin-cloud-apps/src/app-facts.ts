/**
 * Facts/knowledge cache for app deploys (the "completion saves to memory" idea).
 *
 * On a successful deploy we persist ONE durable fact keyed on `app.id` to the
 * runtime's real `facts` memory table, so the agent recalls "you built <name>
 * at <url>" later across surfaces. This is a derived convenience cache — it is
 * explicitly NOT the completion gate (the gate is READY + reachability in
 * deploy-gate.ts). The write is best-effort: a memory failure never fails the
 * deploy.
 *
 * Idempotency is keyed on `app.id`: re-deploying the same app updates the single
 * fact in place (status/url/timestamp refresh) rather than appending a duplicate.
 * Core IS importable in the agent runtime (unlike the Worker), so we use the real
 * `runtime.createMemory` / `getMemories` / `updateMemory` API.
 */

import type { AppDto } from "@elizaos/cloud-sdk";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { logger, MemoryType } from "@elizaos/core";

/** Marks facts written by this cache so we can find + dedupe them. */
export const APP_DEPLOY_FACT_SOURCE = "cloud_apps_deploy";

export interface RecordDeployFactResult {
  /** True when a fact was written (created or updated). */
  written: boolean;
  /** True when an existing fact for this app.id was updated in place. */
  updated: boolean;
  /** The memory id, when one was written/updated. */
  memoryId?: string;
}

function factText(app: AppDto, url: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `User deployed Eliza Cloud app "${app.name}" — live at ${url} (app ${app.id}) on ${date}.`;
}

async function findExistingDeployFact(
  runtime: IAgentRuntime,
  message: Memory,
  appId: string,
): Promise<Memory | null> {
  if (typeof runtime.getMemories !== "function") return null;
  try {
    const rows = await runtime.getMemories({
      tableName: "facts",
      // Dedup is keyed on app.id for the app owner across ALL rooms/connectors:
      // re-deploying the same app from a different surface must update the single
      // existing fact, not append a duplicate. Scope to the entity (owner), NOT
      // the room — a room-scoped query would miss the prior fact and defeat the
      // "exactly one fact per app.id" guarantee.
      entityId: message.entityId,
      count: 200,
      unique: false,
    });
    if (!Array.isArray(rows)) return null;
    return (
      rows.find((m) => {
        const md = m.metadata as Record<string, unknown> | undefined;
        return md?.source === APP_DEPLOY_FACT_SOURCE && md?.appId === appId;
      }) ?? null
    );
  } catch (err) {
    // A read failure disables dedup for this write; degrade to create (the worst
    // case is a duplicate fact, never a lost deploy) but surface the failure.
    logger.warn(
      `[CloudApps] deploy-fact dedup read failed for ${appId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Write (or idempotently update) the deploy fact for `app` at `url`. Returns
 * `{ written: false }` when the runtime has no memory API or the write fails —
 * the caller treats this as a non-fatal cache miss.
 */
export async function recordAppDeployFact(
  runtime: IAgentRuntime,
  message: Memory,
  app: AppDto,
  url: string,
): Promise<RecordDeployFactResult> {
  if (typeof runtime.createMemory !== "function") {
    return { written: false, updated: false };
  }

  const text = factText(app, url);
  const metadata = {
    type: MemoryType.CUSTOM,
    source: APP_DEPLOY_FACT_SOURCE,
    appId: app.id,
    appName: app.name,
    appSlug: app.slug,
    appUrl: url,
    tags: ["fact", "cloud_app", "deploy", app.id],
    // Confirmed live-deploy state is a durable identity fact, not a transient
    // single-message claim — keep it out of the time-decay path.
    kind: "durable" as const,
    confidence: 1,
    deployedAt: new Date().toISOString(),
  } satisfies Memory["metadata"];

  try {
    const existing = await findExistingDeployFact(runtime, message, app.id);
    if (existing?.id && typeof runtime.updateMemory === "function") {
      await runtime.updateMemory({
        id: existing.id,
        content: { text, type: "fact" },
        metadata,
      });
      return { written: true, updated: true, memoryId: existing.id };
    }

    const id = await runtime.createMemory(
      {
        entityId: message.entityId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        content: { text, type: "fact" },
        metadata,
      } as Memory,
      "facts",
      true,
    );
    return { written: true, updated: false, memoryId: id };
  } catch (err) {
    logger.warn(
      `[CloudApps] Failed to record deploy fact for ${app.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { written: false, updated: false };
  }
}

/**
 * Purge the durable "app is live" deploy fact for `appId` (if one exists) after
 * the app is deleted — otherwise the agent keeps recalling a deleted app as
 * live at its old URL forever (the fact is `kind:"durable"`, so it never
 * decays). Best-effort: returns `false` when there's nothing to remove or the
 * runtime has no delete API; a failure never blocks the delete.
 */
export async function removeAppDeployFact(
  runtime: IAgentRuntime,
  message: Memory,
  appId: string,
): Promise<boolean> {
  if (typeof runtime.deleteMemory !== "function") return false;
  try {
    const existing = await findExistingDeployFact(runtime, message, appId);
    if (!existing?.id) return false;
    await runtime.deleteMemory(existing.id);
    return true;
  } catch (err) {
    logger.warn(
      `[CloudApps] Failed to remove deploy fact for ${appId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
