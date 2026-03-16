/**
 * Vercel Deployments Service
 *
 * Handles deploying apps to Vercel from GitHub repositories.
 * Each app gets its own Vercel project under the team.
 *
 * Architecture:
 * - Each app = its own Vercel project
 * - Projects are created under VERCEL_TEAM_ID
 * - GitHub repos are linked to their respective projects
 * - Each project gets a subdomain under apps.elizacloud.ai
 *
 * Flow:
 * 1. App created → GitHub repo created
 * 2. First deploy → Vercel project created → GitHub linked → Domain assigned
 * 3. Subsequent deploys → Deploy to existing project
 */

import { dbRead, dbWrite } from "@/db/client";
import { apps } from "@/db/schemas/apps";
import { appDomains, type NewAppDomain } from "@/db/schemas/app-domains";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";
import { vercelApiRequest } from "@/lib/utils/vercel-api";
import { validateSubdomain, isReservedSubdomain } from "./vercel-domains";

// Vercel API configuration
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const APP_DOMAIN = process.env.APP_DOMAIN || "apps.elizacloud.ai";

// GitHub configuration
const GITHUB_ORG = process.env.GITHUB_ORG_NAME || "eliza-cloud-apps";

interface VercelDeploymentResponse {
  id: string;
  url: string;
  name: string;
  state: "QUEUED" | "BUILDING" | "ERROR" | "READY" | "CANCELED";
  readyState: "QUEUED" | "BUILDING" | "ERROR" | "READY" | "CANCELED";
  createdAt: number;
  buildingAt?: number;
  ready?: number;
  target?: "production" | "preview";
  alias?: string[];
  meta?: Record<string, string>;
}

interface VercelProjectResponse {
  id: string;
  name: string;
  link?: {
    type: "github";
    repo: string;
    repoId: number;
    org: string;
    gitCredentialId: string;
  };
}

interface DeploymentResult {
  success: boolean;
  deploymentId?: string;
  deploymentUrl?: string;
  productionUrl?: string;
  error?: string;
}

interface SubdomainResult {
  success: boolean;
  subdomain?: string;
  fullDomain?: string;
  error?: string;
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
 * Generate a unique subdomain for an app
 */
function generateSubdomain(appSlug: string, appId: string): string {
  // Use slug if valid, otherwise use shortened app ID
  const base = appSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  if (base.length >= 3 && !isReservedSubdomain(base)) {
    return base;
  }

  // Fallback to app-{short-id}
  return `app-${appId.slice(0, 8)}`;
}

/**
 * Generate a Vercel project name for an app
 */
function generateProjectName(appSlug: string, appId: string): string {
  const base = appSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  // Add short ID suffix to ensure uniqueness
  const shortId = appId.slice(0, 8);
  return base.length >= 3 ? `${base}-${shortId}` : `app-${shortId}`;
}

/**
 * Check if a subdomain is available in the local database
 */
async function isSubdomainAvailableInDb(subdomain: string): Promise<boolean> {
  const existing = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.subdomain, subdomain),
  });
  return !existing;
}

/**
 * Check if a subdomain is available
 *
 * We only check the local database because:
 * 1. We own the parent domain (apps.elizacloud.ai) - subdomains are managed internally
 * 2. Vercel's /v6/domains/ API checks domain registration, not project assignments
 * 3. Subdomain assignment to Vercel projects happens later via addDomainToProject
 * 4. The database is the source of truth for our subdomain allocations
 */
async function isSubdomainAvailable(subdomain: string): Promise<boolean> {
  // Only check local database - that's our source of truth for subdomain assignments
  return await isSubdomainAvailableInDb(subdomain);
}

/**
 * Get or create a Vercel project for an app
 */
async function getOrCreateVercelProject(
  appId: string,
  app: { slug: string; github_repo: string | null },
): Promise<{ projectId: string; projectName: string } | null> {
  // Check if app already has a Vercel project
  const existingDomain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  if (existingDomain?.vercel_project_id) {
    logger.info("[Vercel Deployments] Using existing Vercel project", {
      appId,
      projectId: existingDomain.vercel_project_id,
    });
    return {
      projectId: existingDomain.vercel_project_id,
      projectName: existingDomain.subdomain,
    };
  }

  // Create new Vercel project for this app
  const projectName = generateProjectName(app.slug, appId);

  logger.info("[Vercel Deployments] Creating new Vercel project", {
    appId,
    projectName,
  });

  try {
    // Parse GitHub repo
    const [org, repo] = app.github_repo?.includes("/")
      ? app.github_repo.split("/")
      : [GITHUB_ORG, app.github_repo || projectName];

    // Create project with GitHub repo linked
    const project = await vercelFetch<VercelProjectResponse>("/v10/projects", {
      method: "POST",
      body: JSON.stringify({
        name: projectName,
        framework: "nextjs",
        gitRepository: {
          type: "github",
          repo: `${org}/${repo}`,
        },
        // Set environment variables for the app
        environmentVariables: [
          {
            key: "NEXT_PUBLIC_ELIZA_APP_ID",
            value: appId,
            target: ["production", "preview", "development"],
            type: "plain",
          },
          {
            key: "NEXT_PUBLIC_ELIZA_API_URL",
            value:
              process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai",
            target: ["production", "preview", "development"],
            type: "plain",
          },
        ],
      }),
    });

    logger.info("[Vercel Deployments] Created Vercel project", {
      appId,
      projectId: project.id,
      projectName: project.name,
    });

    // Update domain record with project ID
    if (existingDomain) {
      await dbWrite
        .update(appDomains)
        .set({
          vercel_project_id: project.id,
          updated_at: new Date(),
        })
        .where(eq(appDomains.id, existingDomain.id));
    }

    return {
      projectId: project.id,
      projectName: project.name,
    };
  } catch (error) {
    logger.error("[Vercel Deployments] Failed to create Vercel project", {
      appId,
      projectName,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

/**
 * Assign a unique subdomain to an app and create its Vercel project
 */
export async function assignSubdomain(
  appId: string,
  preferredSubdomain?: string,
): Promise<SubdomainResult> {
  const app = await dbRead.query.apps.findFirst({
    where: eq(apps.id, appId),
  });

  if (!app) {
    return { success: false, error: "App not found" };
  }

  // Check if app already has a subdomain
  const existingDomain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  if (existingDomain) {
    return {
      success: true,
      subdomain: existingDomain.subdomain,
      fullDomain: `${existingDomain.subdomain}.${APP_DOMAIN}`,
    };
  }

  // Generate subdomain
  let subdomain = preferredSubdomain || generateSubdomain(app.slug, app.id);

  // Validate subdomain
  const validation = validateSubdomain(subdomain);
  if (!validation.valid) {
    subdomain = generateSubdomain(app.slug, app.id);
  }

  // Check availability, add suffix if needed
  let attempts = 0;
  let candidateSubdomain = subdomain;

  while (!(await isSubdomainAvailable(candidateSubdomain)) && attempts < 10) {
    attempts++;
    candidateSubdomain = `${subdomain}-${Math.random().toString(36).slice(2, 6)}`;
  }

  if (attempts >= 10) {
    return { success: false, error: "Could not find available subdomain" };
  }

  subdomain = candidateSubdomain;
  const fullDomain = `${subdomain}.${APP_DOMAIN}`;

  // Create domain record
  const [domainRecord] = await dbWrite
    .insert(appDomains)
    .values({
      app_id: appId,
      subdomain,
      is_primary: true,
      ssl_status: "pending",
    } satisfies NewAppDomain)
    .returning();

  logger.info("[Vercel Deployments] Subdomain assigned", {
    appId,
    subdomain,
    fullDomain,
  });

  return {
    success: true,
    subdomain,
    fullDomain,
  };
}

/**
 * Add domain to Vercel project
 */
async function addDomainToProject(
  projectId: string,
  domain: string,
): Promise<boolean> {
  try {
    await vercelFetch(`/v10/projects/${projectId}/domains`, {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    });
    logger.info("[Vercel Deployments] Domain added to project", {
      projectId,
      domain,
    });
    return true;
  } catch (error) {
    logger.warn("[Vercel Deployments] Failed to add domain to project", {
      projectId,
      domain,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return false;
  }
}

/**
 * Create a new Vercel deployment from a GitHub repo
 */
export async function createDeployment(
  appId: string,
  options?: {
    branch?: string;
    target?: "production" | "preview";
    commitSha?: string;
  },
): Promise<DeploymentResult> {
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID) {
    return {
      success: false,
      error:
        "Vercel deployment is not configured. Set VERCEL_TOKEN and VERCEL_TEAM_ID.",
    };
  }

  const { branch = "main", target = "production", commitSha } = options || {};

  const app = await dbRead.query.apps.findFirst({
    where: eq(apps.id, appId),
  });

  if (!app) {
    return { success: false, error: "App not found" };
  }

  if (!app.github_repo) {
    return {
      success: false,
      error: "App does not have a GitHub repository. Create one first.",
    };
  }

  // Ensure subdomain exists
  const subdomainResult = await assignSubdomain(appId);
  if (!subdomainResult.success) {
    return {
      success: false,
      error: subdomainResult.error || "Failed to assign subdomain",
    };
  }

  // Get or create Vercel project for this app
  const project = await getOrCreateVercelProject(appId, app);
  if (!project) {
    return {
      success: false,
      error: "Failed to create or get Vercel project for this app",
    };
  }

  // Get domain info
  const domain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  const fullDomain = domain ? `${domain.subdomain}.${APP_DOMAIN}` : undefined;
  const productionUrl = fullDomain ? `https://${fullDomain}` : undefined;

  // Add domain to project if not already added
  if (fullDomain && domain && !domain.vercel_domain_id) {
    const domainAdded = await addDomainToProject(project.projectId, fullDomain);
    if (domainAdded) {
      await dbWrite
        .update(appDomains)
        .set({
          vercel_project_id: project.projectId,
          ssl_status: "provisioning",
          updated_at: new Date(),
        })
        .where(eq(appDomains.id, domain.id));
    }
  }

  logger.info("[Vercel Deployments] Creating deployment", {
    appId,
    projectId: project.projectId,
    githubRepo: app.github_repo,
    branch,
    target,
    commitSha,
  });

  try {
    // Parse GitHub repo
    const [org, repo] = app.github_repo.includes("/")
      ? app.github_repo.split("/")
      : [GITHUB_ORG, app.github_repo];

    // Create deployment via Vercel API
    const deploymentResponse = await vercelFetch<VercelDeploymentResponse>(
      "/v13/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          name: project.projectName,
          project: project.projectId,
          gitSource: {
            type: "github",
            org,
            repo,
            ref: commitSha || branch,
          },
          target,
        }),
      },
    );

    logger.info("[Vercel Deployments] Deployment created", {
      appId,
      projectId: project.projectId,
      deploymentId: deploymentResponse.id,
      url: deploymentResponse.url,
      state: deploymentResponse.state,
    });

    return {
      success: true,
      deploymentId: deploymentResponse.id,
      deploymentUrl: `https://${deploymentResponse.url}`,
      productionUrl,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error("[Vercel Deployments] Failed to create deployment", {
      appId,
      projectId: project.projectId,
      error: errorMessage,
    });

    return {
      success: false,
      error: `Deployment failed: ${errorMessage}`,
    };
  }
}

/**
 * Get deployment status
 */
export async function getDeploymentStatus(deploymentId: string): Promise<{
  id: string;
  state: string;
  url?: string;
  ready?: boolean;
  error?: string;
}> {
  if (!VERCEL_TOKEN) {
    throw new Error("VERCEL_TOKEN is not configured");
  }

  try {
    const deployment = await vercelFetch<VercelDeploymentResponse>(
      `/v13/deployments/${deploymentId}`,
    );

    return {
      id: deployment.id,
      state: deployment.state,
      url: deployment.url ? `https://${deployment.url}` : undefined,
      ready: deployment.state === "READY",
    };
  } catch (error) {
    return {
      id: deploymentId,
      state: "ERROR",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * List recent deployments for an app
 */
export async function listDeployments(
  appId: string,
  limit: number = 10,
): Promise<
  Array<{
    id: string;
    state: string;
    url?: string;
    createdAt: Date;
    target?: string;
  }>
> {
  if (!VERCEL_TOKEN) {
    return [];
  }

  // Get the app's Vercel project ID
  const domain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  if (!domain?.vercel_project_id) {
    return [];
  }

  try {
    const response = await vercelFetch<{
      deployments: VercelDeploymentResponse[];
    }>(`/v6/deployments?projectId=${domain.vercel_project_id}&limit=${limit}`);

    return response.deployments.map((d) => ({
      id: d.id,
      state: d.state,
      url: d.url ? `https://${d.url}` : undefined,
      createdAt: new Date(d.createdAt),
      target: d.target,
    }));
  } catch (error) {
    logger.warn("[Vercel Deployments] Failed to list deployments", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return [];
  }
}

/**
 * Trigger a redeploy of the latest deployment
 */
export async function redeploy(appId: string): Promise<DeploymentResult> {
  return createDeployment(appId, { target: "production" });
}

/**
 * Check if Vercel deployment is configured
 */
export function isDeploymentConfigured(): boolean {
  return !!(VERCEL_TOKEN && VERCEL_TEAM_ID);
}

/**
 * Get the production URL for an app
 */
export async function getProductionUrl(appId: string): Promise<string | null> {
  const domain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  if (!domain) {
    return null;
  }

  if (domain.custom_domain && domain.custom_domain_verified) {
    return `https://${domain.custom_domain}`;
  }

  return `https://${domain.subdomain}.${APP_DOMAIN}`;
}

/**
 * Get the Vercel project ID for an app
 */
export async function getVercelProjectId(
  appId: string,
): Promise<string | null> {
  const domain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  return domain?.vercel_project_id || null;
}

export const vercelDeploymentsService = {
  assignSubdomain,
  createDeployment,
  getDeploymentStatus,
  listDeployments,
  redeploy,
  isDeploymentConfigured,
  getProductionUrl,
  getVercelProjectId,
};
