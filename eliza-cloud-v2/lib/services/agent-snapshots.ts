/**
 * Agent Snapshot Service
 *
 * Manages agent state snapshots: creation (calling the agent's internal
 * /snapshot endpoint), storage (Vercel Blob), listing, restoration
 * (calling the agent's /restore endpoint), and deletion.
 */

import { put, del } from "@vercel/blob";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  agentSnapshots,
  type AgentSnapshot,
} from "@/db/schemas/agent-snapshots";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";

// ─── Types ──────────────────────────────────────────────────────────────

export interface CreateSnapshotParams {
  containerId: string;
  organizationId: string;
  snapshotType: "manual" | "auto" | "pre-eviction";
  containerUrl: string | null;
  metadata?: Record<string, unknown>;
}

export interface RestoreSnapshotParams {
  containerId: string;
  snapshotId: string;
  organizationId: string;
  containerUrl: string | null;
}

interface AgentSnapshotData {
  memories: Record<string, unknown>[];
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
  timestamp: string;
}

// ─── Service ────────────────────────────────────────────────────────────

class AgentSnapshotServiceImpl {
  /**
   * Create a snapshot by calling the agent's internal /snapshot endpoint,
   * then uploading the result to Vercel Blob storage.
   */
  async createSnapshot(params: CreateSnapshotParams): Promise<{
    id: string;
    sizeBytes: number;
    storageUrl: string;
    snapshotType: string;
    created_at: Date;
  }> {
    const { containerId, organizationId, snapshotType, containerUrl, metadata } = params;

    let snapshotData: AgentSnapshotData;

    if (containerUrl) {
      // Fetch snapshot from the running agent
      const agentUrl = `${containerUrl}/api/snapshot`;
      logger.info(`[AgentSnapshot] Fetching snapshot from ${agentUrl}`);

      const response = await fetch(agentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: snapshotType }),
      });

      if (!response.ok) {
        throw new Error(
          `Agent snapshot endpoint returned ${response.status}: ${await response.text()}`,
        );
      }

      snapshotData = (await response.json()) as AgentSnapshotData;
    } else {
      // Container not running or no URL — create a minimal snapshot
      snapshotData = {
        memories: [],
        config: {},
        workspaceFiles: {},
        timestamp: new Date().toISOString(),
      };
    }

    // Upload to Vercel Blob
    const blobPayload = JSON.stringify(snapshotData);
    const sizeBytes = Buffer.byteLength(blobPayload, "utf-8");
    const blobPath = `agent-snapshots/${organizationId}/${containerId}/${Date.now()}.json`;

    const blob = await put(blobPath, blobPayload, {
      access: "public",
      contentType: "application/json",
    });

    // Store metadata in database
    const [snapshot] = await dbWrite
      .insert(agentSnapshots)
      .values({
        container_id: containerId,
        organization_id: organizationId,
        snapshot_type: snapshotType,
        storage_url: blob.url,
        size_bytes: sizeBytes,
        agent_config: snapshotData.config,
        metadata: metadata ?? {},
      })
      .returning();

    return {
      id: snapshot.id,
      sizeBytes,
      storageUrl: blob.url,
      snapshotType: snapshot.snapshot_type,
      created_at: snapshot.created_at,
    };
  }

  /**
   * List snapshots for a container, ordered by creation date descending.
   */
  async listSnapshots(containerId: string): Promise<AgentSnapshot[]> {
    return dbRead
      .select()
      .from(agentSnapshots)
      .where(eq(agentSnapshots.container_id, containerId))
      .orderBy(desc(agentSnapshots.created_at));
  }

  /**
   * Get a specific snapshot by ID.
   */
  async getSnapshot(
    snapshotId: string,
    organizationId: string,
  ): Promise<AgentSnapshot | null> {
    const results = await dbRead
      .select()
      .from(agentSnapshots)
      .where(
        and(
          eq(agentSnapshots.id, snapshotId),
          eq(agentSnapshots.organization_id, organizationId),
        ),
      )
      .limit(1);

    return results[0] ?? null;
  }

  /**
   * Restore a snapshot by downloading it from blob storage and sending
   * it to the agent's /restore endpoint.
   */
  async restoreSnapshot(params: RestoreSnapshotParams): Promise<void> {
    const { containerId, snapshotId, organizationId, containerUrl } = params;

    const snapshot = await this.getSnapshot(snapshotId, organizationId);
    if (!snapshot) {
      throw new Error(`Snapshot ${snapshotId} not found`);
    }

    // Download snapshot data from blob storage
    const blobResponse = await fetch(snapshot.storage_url);
    if (!blobResponse.ok) {
      throw new Error(
        `Failed to download snapshot from storage: ${blobResponse.status}`,
      );
    }
    const snapshotData = await blobResponse.json();

    if (!containerUrl) {
      throw new Error("Container URL not available — cannot restore to a stopped container");
    }

    // Send to agent's restore endpoint
    const agentUrl = `${containerUrl}/api/restore`;
    logger.info(`[AgentSnapshot] Restoring snapshot to ${agentUrl}`);

    const response = await fetch(agentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshotData),
    });

    if (!response.ok) {
      throw new Error(
        `Agent restore endpoint returned ${response.status}: ${await response.text()}`,
      );
    }

    logger.info("[AgentSnapshot] Snapshot restored successfully", {
      containerId,
      snapshotId,
      sizeBytes: snapshot.size_bytes,
    });
  }

  /**
   * Delete a snapshot (both blob storage and database record).
   */
  async deleteSnapshot(
    snapshotId: string,
    organizationId: string,
  ): Promise<void> {
    const snapshot = await this.getSnapshot(snapshotId, organizationId);
    if (!snapshot) {
      throw new Error(`Snapshot ${snapshotId} not found`);
    }

    // Delete from blob storage
    await del(snapshot.storage_url);

    // Delete from database
    await dbWrite
      .delete(agentSnapshots)
      .where(
        and(
          eq(agentSnapshots.id, snapshotId),
          eq(agentSnapshots.organization_id, organizationId),
        ),
      );
  }

  /**
   * Delete all snapshots for a container (called when container is permanently removed).
   */
  async deleteAllForContainer(containerId: string): Promise<number> {
    const snapshots = await this.listSnapshots(containerId);

    // Delete blobs
    for (const snapshot of snapshots) {
      await del(snapshot.storage_url);
    }

    // Delete DB records
    const result = await dbWrite
      .delete(agentSnapshots)
      .where(eq(agentSnapshots.container_id, containerId));

    return snapshots.length;
  }
}

export const agentSnapshotService = new AgentSnapshotServiceImpl();
