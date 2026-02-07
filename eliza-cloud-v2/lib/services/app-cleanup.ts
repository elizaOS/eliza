/**
 * App Cleanup Service
 *
 * Handles comprehensive cleanup of all resources when an app is deleted.
 * This ensures no orphaned resources are left behind in:
 * - E2B/Vercel Sandboxes
 * - Vercel Projects and Domains
 * - GitHub Repositories
 * - Secret Bindings
 * - Managed Domains
 */

import { dbRead, dbWrite } from "@/db/client";
import { appSandboxSessions } from "@/db/schemas/app-sandboxes";
import { appDomains } from "@/db/schemas/app-domains";
import { secretBindings } from "@/db/schemas/secrets";
import { managedDomains } from "@/db/schemas/managed-domains";
import { eq, and, notInArray } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";
import { sandboxService } from "./sandbox";
import { githubReposService } from "./github-repos";
import { vercelDomainsService } from "./vercel-domains";
import { vercelApiRequest } from "@/lib/utils/vercel-api";
import { appsService } from "./apps";
import type { App } from "@/db/repositories/apps";

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;

interface CleanupResult {
  success: boolean;
  errors: string[];
  cleaned: {
    sandboxesStopped: number;
    domainsRemoved: number;
    vercelProjectDeleted: boolean;
    githubRepoDeleted: boolean;
    secretBindingsRemoved: number;
    managedDomainsUnlinked: number;
  };
}

interface CleanupOptions {
  /** Delete the GitHub repository (default: true) */
  deleteGitHubRepo?: boolean;
  /** Delete the Vercel project (default: true) */
  deleteVercelProject?: boolean;
  /** Force cleanup even if some steps fail (default: true) */
  continueOnError?: boolean;
}

/**
 * Make authenticated request to Vercel API
 */
async function vercelFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!VERCEL_TOKEN) {
    throw new Error("VERCEL_TOKEN is not configured");
  }

  return vercelApiRequest<T>(path, VERCEL_TOKEN, options, VERCEL_TEAM_ID);
}

/**
 * Stop all active sandboxes for an app
 */
async function stopAppSandboxes(appId: string): Promise<{
  stopped: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let stopped = 0;

  try {
    // Get all active sandbox sessions for this app
    const activeSessions = await dbRead.query.appSandboxSessions.findMany({
      where: and(
        eq(appSandboxSessions.app_id, appId),
        notInArray(appSandboxSessions.status, ["stopped", "timeout"]),
      ),
    });

    logger.info("[AppCleanup] Found active sandbox sessions", {
      appId,
      count: activeSessions.length,
    });

    for (const session of activeSessions) {
      try {
        if (session.sandbox_id) {
          await sandboxService.stop(session.sandbox_id);
          stopped++;
          logger.info("[AppCleanup] Stopped sandbox", {
            appId,
            sessionId: session.id,
            sandboxId: session.sandbox_id,
          });
        }

        // Mark session as stopped in DB
        await dbWrite
          .update(appSandboxSessions)
          .set({
            status: "stopped",
            stopped_at: new Date(),
            updated_at: new Date(),
          })
          .where(eq(appSandboxSessions.id, session.id));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(
          `Failed to stop sandbox ${session.sandbox_id}: ${errorMessage}`,
        );
        logger.warn("[AppCleanup] Failed to stop sandbox", {
          appId,
          sessionId: session.id,
          sandboxId: session.sandbox_id,
          error: errorMessage,
        });
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to query sandbox sessions: ${errorMessage}`);
    logger.error("[AppCleanup] Failed to query sandbox sessions", {
      appId,
      error: errorMessage,
    });
  }

  return { stopped, errors };
}

/**
 * Remove custom domains from Vercel before the DB records are deleted
 */
async function removeAppDomains(appId: string): Promise<{
  removed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let removed = 0;

  try {
    const domains = await dbRead.query.appDomains.findMany({
      where: eq(appDomains.app_id, appId),
    });

    logger.info("[AppCleanup] Found app domains to remove", {
      appId,
      count: domains.length,
    });

    for (const domain of domains) {
      const fullSubdomain = domain.subdomain
        ? `${domain.subdomain}.${process.env.APP_DOMAIN || "apps.elizacloud.ai"}`
        : null;

      // Remove custom domain from Vercel if it exists
      if (domain.custom_domain && domain.vercel_project_id) {
        try {
          await vercelDomainsService.removeDomain(appId, domain.custom_domain);
          removed++;
          logger.info("[AppCleanup] Removed custom domain from Vercel", {
            appId,
            domain: domain.custom_domain,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          errors.push(
            `Failed to remove domain ${domain.custom_domain}: ${errorMessage}`,
          );
          logger.warn("[AppCleanup] Failed to remove custom domain", {
            appId,
            domain: domain.custom_domain,
            error: errorMessage,
          });
        }
      }

      // Remove subdomain from Vercel project if it exists
      if (fullSubdomain && domain.vercel_project_id) {
        try {
          await vercelFetch(
            `/v9/projects/${domain.vercel_project_id}/domains/${fullSubdomain}`,
            { method: "DELETE" },
          );
          removed++;
          logger.info("[AppCleanup] Removed subdomain from Vercel project", {
            appId,
            subdomain: fullSubdomain,
            projectId: domain.vercel_project_id,
          });
        } catch (error) {
          // Ignore 404 errors - domain may not exist
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          if (!errorMessage.includes("404")) {
            errors.push(
              `Failed to remove subdomain from project: ${errorMessage}`,
            );
            logger.warn(
              "[AppCleanup] Failed to remove subdomain from project",
              {
                appId,
                subdomain: domain.subdomain,
                error: errorMessage,
              },
            );
          }
        }

        // Also try to remove the subdomain from Vercel's global domain registry
        // This ensures the domain is fully released and can be reused
        try {
          await vercelFetch(`/v6/domains/${fullSubdomain}`, {
            method: "DELETE",
          });
          logger.info(
            "[AppCleanup] Removed subdomain from Vercel domain registry",
            {
              appId,
              subdomain: fullSubdomain,
            },
          );
        } catch (error) {
          // Ignore 404 and 403 errors - domain may not exist in registry or may not be owned
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          if (
            !errorMessage.includes("404") &&
            !errorMessage.includes("403") &&
            !errorMessage.includes("not_found") &&
            !errorMessage.includes("forbidden")
          ) {
            logger.warn(
              "[AppCleanup] Failed to remove subdomain from Vercel registry",
              {
                appId,
                subdomain: fullSubdomain,
                error: errorMessage,
              },
            );
          }
        }
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to query app domains: ${errorMessage}`);
    logger.error("[AppCleanup] Failed to query app domains", {
      appId,
      error: errorMessage,
    });
  }

  return { removed, errors };
}

/**
 * Delete the Vercel project for an app
 */
async function deleteVercelProject(appId: string): Promise<{
  deleted: boolean;
  error?: string;
}> {
  try {
    const domain = await dbRead.query.appDomains.findFirst({
      where: eq(appDomains.app_id, appId),
    });

    if (!domain?.vercel_project_id) {
      logger.info("[AppCleanup] No Vercel project to delete", { appId });
      return { deleted: false };
    }

    const projectId = domain.vercel_project_id;

    logger.info("[AppCleanup] Deleting Vercel project", {
      appId,
      projectId,
    });

    await vercelFetch(`/v9/projects/${projectId}`, {
      method: "DELETE",
    });

    logger.info("[AppCleanup] Deleted Vercel project", {
      appId,
      projectId,
    });

    return { deleted: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    // Ignore 404 errors - project may not exist
    if (errorMessage.includes("404")) {
      logger.info("[AppCleanup] Vercel project not found (already deleted)", {
        appId,
      });
      return { deleted: false };
    }
    logger.error("[AppCleanup] Failed to delete Vercel project", {
      appId,
      error: errorMessage,
    });
    return { deleted: false, error: errorMessage };
  }
}

/**
 * Delete the GitHub repository for an app
 */
async function deleteGitHubRepo(
  app: App,
): Promise<{ deleted: boolean; error?: string }> {
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
      .where(
        and(
          eq(secretBindings.project_id, appId),
          eq(secretBindings.project_type, "app"),
        ),
      )
      .returning();

    removed = result.length;

    if (removed > 0) {
      logger.info("[AppCleanup] Removed secret bindings", {
        appId,
        count: removed,
      });
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
  const {
    deleteGitHubRepo: shouldDeleteGitHub = true,
    deleteVercelProject: shouldDeleteVercel = true,
    continueOnError = true,
  } = options;

  const errors: string[] = [];
  const cleaned = {
    sandboxesStopped: 0,
    domainsRemoved: 0,
    vercelProjectDeleted: false,
    githubRepoDeleted: false,
    secretBindingsRemoved: 0,
    managedDomainsUnlinked: 0,
  };

  logger.info("[AppCleanup] Starting comprehensive app cleanup", {
    appId,
    options: { shouldDeleteGitHub, shouldDeleteVercel },
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

  // Step 1: Stop all active sandboxes
  const sandboxResult = await stopAppSandboxes(appId);
  cleaned.sandboxesStopped = sandboxResult.stopped;
  errors.push(...sandboxResult.errors);

  if (sandboxResult.errors.length > 0 && !continueOnError) {
    return { success: false, errors, cleaned };
  }

  // Step 2: Remove domains from Vercel (before CASCADE deletes the records)
  const domainResult = await removeAppDomains(appId);
  cleaned.domainsRemoved = domainResult.removed;
  errors.push(...domainResult.errors);

  if (domainResult.errors.length > 0 && !continueOnError) {
    return { success: false, errors, cleaned };
  }

  // Step 3: Delete Vercel project
  if (shouldDeleteVercel) {
    const vercelResult = await deleteVercelProject(appId);
    cleaned.vercelProjectDeleted = vercelResult.deleted;
    if (vercelResult.error) {
      errors.push(`Vercel project deletion failed: ${vercelResult.error}`);
      if (!continueOnError) {
        return { success: false, errors, cleaned };
      }
    }
  }

  // Step 4: Delete GitHub repository
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

  // Step 5: Clean up secret bindings
  const secretResult = await cleanupSecretBindings(appId);
  cleaned.secretBindingsRemoved = secretResult.removed;
  errors.push(...secretResult.errors);

  // Step 6: Unlink managed domains
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
  stopAppSandboxes,
  removeAppDomains,
  deleteVercelProject,
  deleteGitHubRepo,
  cleanupSecretBindings,
  unlinkManagedDomains,
};
