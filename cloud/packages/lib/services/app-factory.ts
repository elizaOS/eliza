import type { App } from "@/db/repositories/apps";
import { logger } from "@/lib/utils/logger";
import { AppNameConflictError, appsService } from "./apps";
import { discordService } from "./discord";
import { githubReposService } from "./github-repos";
import { usersService } from "./users";

/**
 * App Factory Service
 *
 * Provides an interface for creating apps with all associated resources.
 * This orchestration layer ensures consistency between app creation flows
 * (manual API creation vs AI builder creation).
 *
 * Key responsibilities:
 * - Create app record via appsService
 * - Create GitHub repository for the app
 * - Link app to its GitHub repo
 * - Handle failures gracefully
 */

export interface CreateAppInput {
  name: string;
  description?: string;
  organization_id: string;
  created_by_user_id: string;
  app_url: string;
  allowed_origins?: string[];
  logo_url?: string;
  website_url?: string;
  contact_email?: string;
}

export interface CreateAppOptions {
  /** Whether to create a GitHub repository for this app (default: true) */
  createGitHubRepo?: boolean;
  /** Custom repo name (default: auto-generated from app slug) */
  repoName?: string;
  /** Whether the repo should be private (default: true) */
  repoPrivate?: boolean;
  /** Whether to assign a subdomain (default: true) */
  assignSubdomain?: boolean;
  /** Preferred subdomain (optional, will auto-generate if not available) */
  preferredSubdomain?: string;
}

export interface CreateAppResult {
  app: App;
  apiKey: string;
  githubRepo?: string;
  githubRepoCreated: boolean;
  subdomain?: string;
  productionUrl?: string;
  subdomainAssigned: boolean;
  errors: string[];
}

export class AppFactoryService {
  /**
   * Create a new app with all associated resources.
   *
   * This is the primary method for app creation that should be used
   * throughout the application to ensure consistency.
   */
  async createApp(data: CreateAppInput, options: CreateAppOptions = {}): Promise<CreateAppResult> {
    const { createGitHubRepo = true, repoPrivate = true, assignSubdomain = true } = options;

    const errors: string[] = [];
    let githubRepo: string | undefined;
    let githubRepoCreated = false;
    let subdomain: string | undefined;
    let productionUrl: string | undefined;
    let subdomainAssigned = false;

    logger.info("AppFactory: Creating app", {
      name: data.name,
      organizationId: data.organization_id,
      createGitHubRepo,
      assignSubdomain,
    });

    // Step 0: Validate name availability before creating anything
    const nameCheck = await appsService.isNameAvailable(data.name);
    if (!nameCheck.available) {
      const errorMessage =
        nameCheck.conflictType === "subdomain"
          ? `The name "${data.name}" would create a subdomain that is already in use. Please choose a different name.`
          : `An app with the name "${data.name}" already exists. Please choose a different name.`;

      logger.warn("AppFactory: Name conflict detected", {
        name: data.name,
        slug: nameCheck.slug,
        conflictType: nameCheck.conflictType,
        suggestedName: nameCheck.suggestedName,
      });

      throw new AppNameConflictError(
        errorMessage,
        nameCheck.conflictType!,
        nameCheck.suggestedName,
      );
    }

    // Step 1: Create the app record
    const { app, apiKey } = await appsService.create(data);

    logger.info("AppFactory: App record created", {
      appId: app.id,
      slug: app.slug,
    });

    // Step 2: Run GitHub repo creation and subdomain assignment in PARALLEL
    // This can save 3-10 seconds compared to sequential execution
    const parallelTasks: Promise<void>[] = [];

    // GitHub repo creation task
    if (createGitHubRepo) {
      const repoTask = (async () => {
        try {
          const repoName =
            options.repoName || githubReposService.generateRepoName(app.id, app.slug);

          logger.info("AppFactory: Creating GitHub repo", {
            appId: app.id,
            repoName,
          });

          const repoInfo = await githubReposService.createAppRepo({
            name: repoName,
            description: `ElizaCloud App: ${app.name}`,
            isPrivate: repoPrivate,
          });

          githubRepo = repoInfo.fullName;
          githubRepoCreated = true;
          app.github_repo = repoInfo.fullName;

          logger.info("AppFactory: GitHub repo created", {
            appId: app.id,
            githubRepo: repoInfo.fullName,
          });
        } catch (repoError) {
          const errorMessage =
            repoError instanceof Error ? repoError.message : "Unknown error creating GitHub repo";

          errors.push(`GitHub repo creation failed: ${errorMessage}`);

          logger.warn("AppFactory: Failed to create GitHub repo", {
            appId: app.id,
            error: errorMessage,
          });
        }
      })();
      parallelTasks.push(repoTask);
    }

    // TODO(cloudflare): wire subdomain assignment against Cloudflare Workers / Pages.
    // For now creation proceeds without a hosted subdomain.

    // Wait for parallel tasks to complete
    await Promise.all(parallelTasks);

    // Step 3: Batch update app record with all results (single DB call)
    const updates: Record<string, string | null> = {};
    if (githubRepo) {
      updates.github_repo = githubRepo;
    }
    if (productionUrl) {
      updates.app_url = productionUrl;
    }

    if (Object.keys(updates).length > 0) {
      await appsService.update(app.id, updates);
      logger.info("AppFactory: App record updated with parallel results", {
        appId: app.id,
        updates: Object.keys(updates),
      });
    }

    // Only send Discord notification if app has a real production URL (not draft/placeholder)
    // This prevents alerts for undeployed apps with placeholder URLs
    const finalAppUrl = productionUrl || data.app_url;
    const isPlaceholderUrl =
      !finalAppUrl ||
      finalAppUrl.includes("placeholder.local") ||
      finalAppUrl === "https://placeholder.local";

    if (!isPlaceholderUrl && productionUrl) {
      const appUrl = productionUrl;
      // Fetch user info to get their name (non-blocking)
      usersService
        .getById(data.created_by_user_id)
        .then((user) => {
          const userName = user?.name || user?.nickname || user?.email || null;
          return discordService.logAppCreated({
            appId: app.id,
            appName: app.name,
            slug: app.slug,
            userName,
            userId: data.created_by_user_id,
            organizationId: data.organization_id,
            appUrl,
            description: data.description,
            githubRepo,
            subdomain,
          });
        })
        .catch((err) => {
          logger.warn("AppFactory: Failed to send Discord notification", {
            appId: app.id,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        });
    } else {
      logger.info("AppFactory: Skipping Discord notification for draft app (no production URL)", {
        appId: app.id,
        appUrl: finalAppUrl,
      });
    }

    return {
      app,
      apiKey,
      githubRepo,
      githubRepoCreated,
      subdomain,
      productionUrl,
      subdomainAssigned,
      errors,
    };
  }

  /**
   * Create an app without GitHub repository.
   * Use this for apps that don't need version control.
   */
  async createAppWithoutRepo(data: CreateAppInput): Promise<{ app: App; apiKey: string }> {
    return appsService.create(data);
  }

  /**
   * Ensure an existing app has a GitHub repository.
   * Creates one if it doesn't exist.
   */
  async ensureGitHubRepo(
    appId: string,
    options?: { repoPrivate?: boolean },
  ): Promise<{ githubRepo: string | null; created: boolean; error?: string }> {
    const { repoPrivate = true } = options || {};

    const app = await appsService.getById(appId);
    if (!app) {
      return { githubRepo: null, created: false, error: "App not found" };
    }

    // If app already has a repo, return it
    if (app.github_repo) {
      logger.info("AppFactory: App already has GitHub repo", {
        appId,
        githubRepo: app.github_repo,
      });
      return { githubRepo: app.github_repo, created: false };
    }

    // Create new repo
    try {
      const repoName = githubReposService.generateRepoName(app.id, app.slug);

      logger.info("AppFactory: Creating GitHub repo for existing app", {
        appId,
        repoName,
      });

      const repoInfo = await githubReposService.createAppRepo({
        name: repoName,
        description: `ElizaCloud App: ${app.name}`,
        isPrivate: repoPrivate,
      });

      await appsService.update(app.id, {
        github_repo: repoInfo.fullName,
      });

      logger.info("AppFactory: GitHub repo created for existing app", {
        appId,
        githubRepo: repoInfo.fullName,
      });

      return { githubRepo: repoInfo.fullName, created: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("AppFactory: Failed to create GitHub repo for existing app", {
        appId,
        error: errorMessage,
      });
      return { githubRepo: null, created: false, error: errorMessage };
    }
  }

  /**
   * Delete an app and its associated resources.
   * Optionally deletes the GitHub repository as well.
   */
  async deleteApp(
    appId: string,
    options?: { deleteGitHubRepo?: boolean },
  ): Promise<{ success: boolean; errors: string[] }> {
    const { deleteGitHubRepo = false } = options || {};
    const errors: string[] = [];

    const app = await appsService.getById(appId);
    if (!app) {
      return { success: false, errors: ["App not found"] };
    }

    // Delete GitHub repo if requested
    if (deleteGitHubRepo && app.github_repo) {
      try {
        const repoName = app.github_repo.includes("/")
          ? app.github_repo.split("/").pop()!
          : app.github_repo;

        await githubReposService.deleteAppRepo(repoName);

        logger.info("AppFactory: Deleted GitHub repo", {
          appId,
          githubRepo: app.github_repo,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Failed to delete GitHub repo: ${errorMessage}`);
        logger.warn("AppFactory: Failed to delete GitHub repo", {
          appId,
          error: errorMessage,
        });
      }
    }

    // Delete the app record
    await appsService.delete(appId);

    logger.info("AppFactory: Deleted app", { appId });

    return { success: true, errors };
  }

  /**
   * Check if GitHub integration is properly configured.
   */
  async checkGitHubConfig(): Promise<{
    configured: boolean;
    org: string;
    template: string;
    error?: string;
  }> {
    return githubReposService.checkGitHubConfig();
  }
}

export const appFactoryService = new AppFactoryService();
