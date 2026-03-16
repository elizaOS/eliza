/**
 * Sandbox Snapshots Service
 *
 * Manages Vercel Sandbox snapshots for faster sandbox creation.
 * Instead of cloning from git and reinstalling dependencies each time,
 * sandboxes can be created from a pre-built snapshot.
 *
 * Features:
 * - Create snapshots after initial sandbox setup
 * - Retrieve valid snapshots for templates
 * - Auto-refresh expired snapshots
 * - Track snapshot usage statistics
 *
 * @see https://vercel.com/docs/vercel-sandbox#snapshotting
 */

import { logger } from "@/lib/utils/logger";
import { dbRead, dbWrite } from "@/db/client";
import {
  sandboxTemplateSnapshots,
  type SandboxTemplateSnapshot,
} from "@/db/schemas/app-sandboxes";
import { eq, and, gt, lt, desc, sql } from "drizzle-orm";

// Snapshot expiration: 7 days (Vercel's limit)
const SNAPSHOT_EXPIRY_DAYS = 7;
// Buffer for expiration check (create new snapshot 1 day before expiry)
const SNAPSHOT_EXPIRY_BUFFER_DAYS = 1;

// Default template key
export const DEFAULT_TEMPLATE_KEY = "default";

export interface SnapshotInfo {
  snapshotId: string;
  templateKey: string;
  githubRepo: string | null;
  createdAt: Date;
  expiresAt: Date;
  usageCount: number;
}

export interface CreateSnapshotOptions {
  templateKey: string;
  githubRepo?: string;
  githubCommitSha?: string;
  nodeModulesSizeMb?: number;
  totalFiles?: number;
}

/**
 * Get credentials for Vercel Sandbox API
 */
function getSandboxCredentials() {
  const hasOIDC = !!process.env.VERCEL_OIDC_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const token = process.env.VERCEL_TOKEN;
  const hasAccessToken = !!(teamId && projectId && token);
  return { hasOIDC, hasAccessToken, teamId, projectId, token };
}

/**
 * Check if snapshots feature is enabled
 */
export function isSnapshotsEnabled(): boolean {
  return process.env.SANDBOX_SNAPSHOTS_ENABLED !== "false";
}

/**
 * Get a valid snapshot for a template, if one exists.
 * Returns null if no valid snapshot exists or snapshots are disabled.
 */
export async function getValidSnapshot(
  templateKey: string = DEFAULT_TEMPLATE_KEY,
): Promise<SnapshotInfo | null> {
  if (!isSnapshotsEnabled()) {
    logger.debug("Snapshots disabled, skipping lookup", { templateKey });
    return null;
  }

  try {
    const now = new Date();
    // Add buffer to ensure snapshot won't expire during use
    const minExpiresAt = new Date(
      now.getTime() + SNAPSHOT_EXPIRY_BUFFER_DAYS * 24 * 60 * 60 * 1000,
    );

    const snapshot = await dbRead.query.sandboxTemplateSnapshots.findFirst({
      where: and(
        eq(sandboxTemplateSnapshots.template_key, templateKey),
        eq(sandboxTemplateSnapshots.status, "ready"),
        gt(sandboxTemplateSnapshots.expires_at, minExpiresAt),
      ),
      orderBy: [desc(sandboxTemplateSnapshots.created_at)],
    });

    if (!snapshot) {
      logger.debug("No valid snapshot found", { templateKey });
      return null;
    }

    logger.info("Found valid snapshot", {
      templateKey,
      snapshotId: snapshot.snapshot_id,
      expiresAt: snapshot.expires_at,
    });

    return {
      snapshotId: snapshot.snapshot_id,
      templateKey: snapshot.template_key,
      githubRepo: snapshot.github_repo,
      createdAt: snapshot.created_at,
      expiresAt: snapshot.expires_at,
      usageCount: snapshot.usage_count,
    };
  } catch (error) {
    // This is expected if the table doesn't exist yet (migration not run)
    // or if there are no snapshots - just continue without snapshot
    logger.debug("Snapshot lookup failed (this is normal if no snapshots exist)", {
      templateKey,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return null;
  }
}

/**
 * Record that a snapshot was used (for tracking/analytics).
 */
export async function recordSnapshotUsage(snapshotId: string): Promise<void> {
  try {
    await dbWrite
      .update(sandboxTemplateSnapshots)
      .set({
        usage_count: sql`${sandboxTemplateSnapshots.usage_count} + 1`,
        last_used_at: new Date(),
      })
      .where(eq(sandboxTemplateSnapshots.snapshot_id, snapshotId));
  } catch (error) {
    // Non-critical, just log and continue
    logger.warn("Failed to record snapshot usage", {
      snapshotId,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }
}

/**
 * Create a snapshot from a running sandbox.
 * This will stop the sandbox and save its state.
 *
 * IMPORTANT: The sandbox must be in a clean state (dependencies installed,
 * no dev server running) before calling this.
 */
export async function createSnapshotFromSandbox(
  sandbox: {
    sandboxId: string;
    snapshot: () => Promise<{ snapshotId: string }>;
  },
  options: CreateSnapshotOptions,
): Promise<SandboxTemplateSnapshot | null> {
  if (!isSnapshotsEnabled()) {
    logger.info("Snapshots disabled, skipping creation");
    return null;
  }

  const { templateKey, githubRepo, githubCommitSha, nodeModulesSizeMb, totalFiles } =
    options;

  logger.info("Creating snapshot from sandbox", {
    sandboxId: sandbox.sandboxId,
    templateKey,
    githubRepo,
  });

  try {
    // Create the Vercel Sandbox snapshot
    // This will stop the sandbox!
    const snapshotResult = await sandbox.snapshot();
    const snapshotId = snapshotResult.snapshotId;

    // Calculate expiration date (7 days from now)
    const expiresAt = new Date(
      Date.now() + SNAPSHOT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    // Store in database
    const [newSnapshot] = await dbWrite
      .insert(sandboxTemplateSnapshots)
      .values({
        snapshot_id: snapshotId,
        template_key: templateKey,
        github_repo: githubRepo || null,
        github_commit_sha: githubCommitSha || null,
        node_modules_size_mb: nodeModulesSizeMb || null,
        total_files: totalFiles || null,
        status: "ready",
        expires_at: expiresAt,
      })
      .returning();

    logger.info("Snapshot created successfully", {
      snapshotId,
      templateKey,
      expiresAt,
    });

    return newSnapshot;
  } catch (error) {
    logger.error("Failed to create snapshot", {
      sandboxId: sandbox.sandboxId,
      templateKey,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return null;
  }
}

/**
 * Verify a snapshot still exists in Vercel (it may have expired).
 */
export async function verifySnapshot(snapshotId: string): Promise<boolean> {
  const creds = getSandboxCredentials();

  if (!creds.hasOIDC && !creds.hasAccessToken) {
    logger.warn("Cannot verify snapshot: Vercel credentials not configured");
    return false;
  }

  try {
    const { Snapshot } = await import("@vercel/sandbox");

    // Build options based on available credentials
    const getOptions = creds.hasAccessToken
      ? {
          snapshotId,
          teamId: creds.teamId!,
          projectId: creds.projectId!,
          token: creds.token!,
        }
      : { snapshotId };

    const snapshot = await Snapshot.get(getOptions as Parameters<typeof Snapshot.get>[0]);
    // Snapshot status could be 'created', 'deleted', or 'failed' - we only consider it valid if created
    return snapshot?.status === "created";
  } catch (error) {
    logger.warn("Snapshot verification failed", {
      snapshotId,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return false;
  }
}

/**
 * Mark a snapshot as expired in the database.
 */
export async function markSnapshotExpired(snapshotId: string): Promise<void> {
  try {
    await dbWrite
      .update(sandboxTemplateSnapshots)
      .set({ status: "expired" })
      .where(eq(sandboxTemplateSnapshots.snapshot_id, snapshotId));

    logger.info("Marked snapshot as expired", { snapshotId });
  } catch (error) {
    logger.error("Failed to mark snapshot as expired", {
      snapshotId,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }
}

/**
 * Delete a snapshot from Vercel and the database.
 */
export async function deleteSnapshot(snapshotId: string): Promise<boolean> {
  const creds = getSandboxCredentials();

  try {
    // Try to delete from Vercel first
    if (creds.hasOIDC || creds.hasAccessToken) {
      try {
        const { Snapshot } = await import("@vercel/sandbox");

        // Build options based on available credentials
        const getOptions = creds.hasAccessToken
          ? {
              snapshotId,
              teamId: creds.teamId!,
              projectId: creds.projectId!,
              token: creds.token!,
            }
          : { snapshotId };

        const snapshot = await Snapshot.get(getOptions as Parameters<typeof Snapshot.get>[0]);
        if (snapshot) {
          await snapshot.delete();
        }
      } catch (error) {
        // Snapshot may already be deleted, continue to remove from DB
        logger.debug("Snapshot may already be deleted from Vercel", {
          snapshotId,
          error: error instanceof Error ? error.message : "Unknown",
        });
      }
    }

    // Remove from database
    await dbWrite
      .delete(sandboxTemplateSnapshots)
      .where(eq(sandboxTemplateSnapshots.snapshot_id, snapshotId));

    logger.info("Deleted snapshot", { snapshotId });
    return true;
  } catch (error) {
    logger.error("Failed to delete snapshot", {
      snapshotId,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return false;
  }
}

/**
 * Clean up expired snapshots from the database.
 * Called by a scheduled job.
 */
export async function cleanupExpiredSnapshots(): Promise<number> {
  try {
    const now = new Date();

    // Find all expired snapshots
    const expiredSnapshots = await dbRead.query.sandboxTemplateSnapshots.findMany(
      {
        where: and(
          eq(sandboxTemplateSnapshots.status, "ready"),
          lt(sandboxTemplateSnapshots.expires_at, now),
        ),
      },
    );

    if (expiredSnapshots.length === 0) {
      return 0;
    }

    logger.info("Cleaning up expired snapshots", {
      count: expiredSnapshots.length,
    });

    // Mark all as expired
    let deletedCount = 0;
    for (const snapshot of expiredSnapshots) {
      const deleted = await deleteSnapshot(snapshot.snapshot_id);
      if (deleted) deletedCount++;
    }

    return deletedCount;
  } catch (error) {
    logger.error("Failed to cleanup expired snapshots", {
      error: error instanceof Error ? error.message : "Unknown",
    });
    return 0;
  }
}

/**
 * Get statistics about snapshots.
 */
export async function getSnapshotStats(): Promise<{
  total: number;
  ready: number;
  expired: number;
  totalUsage: number;
}> {
  try {
    const allSnapshots = await dbRead.query.sandboxTemplateSnapshots.findMany();

    const stats = {
      total: allSnapshots.length,
      ready: allSnapshots.filter((s) => s.status === "ready").length,
      expired: allSnapshots.filter((s) => s.status === "expired").length,
      totalUsage: allSnapshots.reduce((sum, s) => sum + s.usage_count, 0),
    };

    return stats;
  } catch (error) {
    logger.error("Failed to get snapshot stats", {
      error: error instanceof Error ? error.message : "Unknown",
    });
    return { total: 0, ready: 0, expired: 0, totalUsage: 0 };
  }
}

/**
 * List all snapshots for a template.
 */
export async function listSnapshots(
  templateKey?: string,
): Promise<SandboxTemplateSnapshot[]> {
  try {
    if (templateKey) {
      return await dbRead.query.sandboxTemplateSnapshots.findMany({
        where: eq(sandboxTemplateSnapshots.template_key, templateKey),
        orderBy: [desc(sandboxTemplateSnapshots.created_at)],
      });
    }

    return await dbRead.query.sandboxTemplateSnapshots.findMany({
      orderBy: [desc(sandboxTemplateSnapshots.created_at)],
    });
  } catch (error) {
    logger.error("Failed to list snapshots", {
      templateKey,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return [];
  }
}

export const sandboxSnapshotsService = {
  isEnabled: isSnapshotsEnabled,
  getValidSnapshot,
  recordSnapshotUsage,
  createSnapshotFromSandbox,
  verifySnapshot,
  markSnapshotExpired,
  deleteSnapshot,
  cleanupExpiredSnapshots,
  getSnapshotStats,
  listSnapshots,
  DEFAULT_TEMPLATE_KEY,
};

export default sandboxSnapshotsService;
