/**
 * App Cleanup Service
 *
 * Handles comprehensive cleanup of all resources when an app is deleted.
 * This ensures no orphaned resources are left behind in:
 * - GitHub Repositories
 * - Secret Bindings
 * - Managed Domains
 */

import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import type { App } from "@/db/repositories/apps";
import { appDomains } from "@/db/schemas/app-domains";
import { managedDomains } from "@/db/schemas/managed-domains";
import { secretBindings } from "@/db/schemas/secrets";
import { logger } from "@/lib/utils/logger";
import { appsService } from "./apps";
import { githubReposService } from "./github-repos";

interface CleanupResult {
  success: boolean;
  errors: string[];
  cleaned: {
    domainsRemoved: number;
    githubRepoDeleted: boolean;
    secretBindingsRemoved: number;
    managedDomainsUnlinked: number;
  };
}

interface CleanupOptions {
  /** Delete the GitHub repository (default: true) */
  deleteGitHubRepo?: boolean;
  /** Force cleanup even if some steps fail (default: true) */
  continueOnError?: boolean;
}

/**
 * Remove app domain records before the app row CASCADE-deletes them.
 * No external API calls — internal DB cleanup only.
 */
async function removeAppDomains(appId: string): Promise<{
  removed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let removed = 0;

  try {
    const result = await dbWrite.delete(appDomains).where(eq(appDomains.app_id, appId)).returning();

    removed = result.length;

    if (removed > 0) {
      logger.info("[AppCleanup] Removed app domain records", {
        appId,
        count: removed,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to remove app domains: ${errorMessage}`);
    logger.error("[AppCleanup] Failed to remove app domains", {
      appId,
      error: errorMessage,
    });
  }

  return { removed, errors };
}

/**
 * Delete the GitHub repository for an app
 */
async function deleteGitHubRepo(app: App): Promise<{ deleted: boolean; error?: string }> {
  if (!app.github_repo) {
    logger.info("[AppCleanup] No GitHub repo to delete", { appId: app.id });
    return { deleted: false };
  }

  try {
    const repoName = app.github_repo.includes("/")
      ? app.github_repo.split("/").pop()!
      : app.github_repo;

    logger.info("[AppCleanup] Deleting GitHub repo", {
      appId: app.id,
      repoName,
    });

    await githubReposService.deleteAppRepo(repoName);

    logger.info("[AppCleanup] Deleted GitHub repo", {
      appId: app.id,
      repoName,
    });

    return { deleted: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("[AppCleanup] Failed to delete GitHub repo", {
      appId: app.id,
      githubRepo: app.github_repo,
      error: errorMessage,
    });
    return { deleted: false, error: errorMessage };
  }
}

/**
 * Clean up secret bindings that reference this app
 */
async function cleanupSecretBindings(appId: string): Promise<{
  removed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let removed = 0;

  try {
    // Delete secret bindings where project_id matches this app
    const result = await dbWrite
      .delete(secretBindings)
      .where(and(eq(secretBindings.project_id, appId), eq(secretBindings.project_type, "app")))
      .returning();

    removed = result.length;

    if (removed > 0) {
      logger.info("[AppCleanup] Removed secret bindings", {
        appId,
        count: removed,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to cleanup secret bindings: ${errorMessage}`);
    logger.error("[AppCleanup] Failed to cleanup secret bindings", {
      appId,
      error: errorMessage,
    });
  }

  return { removed, errors };
}

/**
 * Unlink managed domains from the app (they use SET NULL, but we can be explicit)
 */
async function unlinkManagedDomains(appId: string): Promise<{
  unlinked: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let unlinked = 0;

  try {
    // Find managed domains linked to this app
    const domains = await dbRead.query.managedDomains.findMany({
      where: eq(managedDomains.appId, appId),
    });

    if (domains.length > 0) {
      // Explicitly unlink (even though CASCADE would SET NULL)
      await dbWrite
        .update(managedDomains)
        .set({
          appId: null,
          resourceType: null,
          updatedAt: new Date(),
        })
        .where(eq(managedDomains.appId, appId));

      unlinked = domains.length;

      logger.info("[AppCleanup] Unlinked managed domains", {
        appId,
        count: unlinked,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to unlink managed domains: ${errorMessage}`);
    logger.error("[AppCleanup] Failed to unlink managed domains", {
      appId,
      error: errorMessage,
    });
  }

  return { unlinked, errors };
}

/**
 * Perform comprehensive cleanup of all app resources.
 * Call this BEFORE deleting the app record.
 */
export async function cleanupAppResources(
  appId: string,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const { deleteGitHubRepo: shouldDeleteGitHub = true, continueOnError = true } = options;

  const errors: string[] = [];
  const cleaned = {
    domainsRemoved: 0,
    githubRepoDeleted: false,
    secretBindingsRemoved: 0,
    managedDomainsUnlinked: 0,
  };

  logger.info("[AppCleanup] Starting comprehensive app cleanup", {
    appId,
    options: { shouldDeleteGitHub },
  });

  // Get app details first
  const app = await appsService.getById(appId);
  if (!app) {
    return {
      success: false,
      errors: ["App not found"],
      cleaned,
    };
  }

  // Step 1: Remove app domain records (before CASCADE deletes them)
  const domainResult = await removeAppDomains(appId);
  cleaned.domainsRemoved = domainResult.removed;
  errors.push(...domainResult.errors);

  if (domainResult.errors.length > 0 && !continueOnError) {
    return { success: false, errors, cleaned };
  }

  // Step 2: Delete GitHub repository
  if (shouldDeleteGitHub) {
    const githubResult = await deleteGitHubRepo(app);
    cleaned.githubRepoDeleted = githubResult.deleted;
    if (githubResult.error) {
      errors.push(`GitHub repo deletion failed: ${githubResult.error}`);
      if (!continueOnError) {
        return { success: false, errors, cleaned };
      }
    }
  }

  // Step 3: Clean up secret bindings
  const secretResult = await cleanupSecretBindings(appId);
  cleaned.secretBindingsRemoved = secretResult.removed;
  errors.push(...secretResult.errors);

  // Step 4: Unlink managed domains
  const managedDomainsResult = await unlinkManagedDomains(appId);
  cleaned.managedDomainsUnlinked = managedDomainsResult.unlinked;
  errors.push(...managedDomainsResult.errors);

  logger.info("[AppCleanup] Completed app cleanup", {
    appId,
    cleaned,
    errorCount: errors.length,
  });

  return {
    success: errors.length === 0,
    errors,
    cleaned,
  };
}

/**
 * Delete an app with full resource cleanup.
 * This is the recommended way to delete an app.
 */
export async function deleteAppWithCleanup(
  appId: string,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  // First, perform cleanup of external resources
  const cleanupResult = await cleanupAppResources(appId, options);

  // Then delete the app record (which triggers CASCADE deletes for DB records)
  try {
    await appsService.delete(appId);
    logger.info("[AppCleanup] App deleted successfully", { appId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    cleanupResult.errors.push(`Failed to delete app record: ${errorMessage}`);
    cleanupResult.success = false;
    logger.error("[AppCleanup] Failed to delete app record", {
      appId,
      error: errorMessage,
    });
  }

  return cleanupResult;
}

export const appCleanupService = {
  cleanupAppResources,
  deleteAppWithCleanup,
  removeAppDomains,
  deleteGitHubRepo,
  cleanupSecretBindings,
  unlinkManagedDomains,
};
