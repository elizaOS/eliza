/**
 * Transaction-shaped project publication workflow shared by the Projects UI.
 *
 * A new Cloud record is bound to the local project immediately after creation,
 * before deployment can fail, so retries always reuse one durable identity.
 * Cloud and local storage cannot commit atomically; delete therefore clears the
 * binding only after Cloud confirms deletion, and stale bindings remain visible
 * as errors rather than silently minting duplicates.
 */

import { client } from "../../../api/client";
import type { ProjectSummary } from "../../../api/client-types-cloud";
import {
  type App,
  createApp,
  type DeployAppInput,
  deleteApp,
  deployApp,
  getApp,
  getLatestAppDeployment,
  updateApp,
} from "./apps";
import {
  type FrontendBundleFile,
  publishFrontendBundle,
} from "./frontend-hosting";

const PENDING_PUBLICATION_URL = "https://pending.invalid";
const DEFAULT_CONTAINER_POLL_ATTEMPTS = 90;
const DEFAULT_CONTAINER_POLL_INTERVAL_MS = 2_000;

export type ProjectPublishMode = "managed-frontend" | "container";

export interface PublishProjectInput {
  project: ProjectSummary;
  existingApp?: App;
  /**
   * Receives the durable binding before deployment begins. Callers must retain
   * it so a failed first deploy retries the same Cloud identity and one-time key.
   */
  onBound?: (binding: {
    project: ProjectSummary;
    app: App;
    apiKey?: string;
  }) => void | Promise<void>;
  name: string;
  description: string;
  mode: ProjectPublishMode;
  frontendFiles?: FrontendBundleFile[];
  container?: DeployAppInput;
}

export interface PublishProjectResult {
  project: ProjectSummary;
  app: App;
  publicUrl: string;
  apiKey?: string;
}

export interface ProjectPublishDependencies {
  createCloudApp: typeof createApp;
  bindProject: (
    projectId: string,
    cloudAppId: string,
  ) => Promise<ProjectSummary>;
  publishFrontend: typeof publishFrontendBundle;
  deployContainer: typeof deployApp;
  waitForContainer: (appId: string) => Promise<App>;
  patchCloudApp: typeof updateApp;
  readCloudApp: typeof getApp;
}

/** Bind through the local agent API, whose handler delegates to core registry. */
export async function bindLocalProjectCloudApp(
  projectId: string,
  cloudAppId: string,
): Promise<ProjectSummary> {
  return client.bindProjectCloudApp(projectId, cloudAppId);
}

/** Clear only the Cloud binding; the local project itself remains intact. */
export async function unbindLocalProjectCloudApp(
  projectId: string,
): Promise<ProjectSummary> {
  return client.unbindProjectCloudApp(projectId);
}

/**
 * Poll the authoritative container deployment and app record until it is live.
 * The deploy route is asynchronous; returning after the trigger would falsely
 * label a queued or failed backend as Published.
 */
export async function waitForContainerPublication(
  appId: string,
  options: {
    attempts?: number;
    intervalMs?: number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<App> {
  const attempts = options.attempts ?? DEFAULT_CONTAINER_POLL_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_CONTAINER_POLL_INTERVAL_MS;
  const wait =
    options.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, ms);
      }));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const deployment = await getLatestAppDeployment(appId);
    if (deployment.status === "ERROR") {
      throw new Error(
        deployment.error ?? "Container deployment failed before going live",
      );
    }
    if (deployment.status === "READY") {
      const app = await getApp(appId);
      if (app.deployment_status !== "deployed" || !app.production_url?.trim()) {
        throw new Error(
          "Container reported ready without an authoritative production URL",
        );
      }
      return app;
    }
    if (attempt < attempts - 1) await wait(intervalMs);
  }
  throw new Error("Container deployment timed out before going live");
}

const defaultDependencies: ProjectPublishDependencies = {
  createCloudApp: createApp,
  bindProject: bindLocalProjectCloudApp,
  publishFrontend: publishFrontendBundle,
  deployContainer: deployApp,
  waitForContainer: waitForContainerPublication,
  patchCloudApp: updateApp,
  readCloudApp: getApp,
};

/** Publish or complete one bound project through the selected hosting path. */
export async function publishProject(
  input: PublishProjectInput,
  dependencies: ProjectPublishDependencies = defaultDependencies,
): Promise<PublishProjectResult> {
  if (input.mode === "managed-frontend" && !input.frontendFiles?.length) {
    throw new Error("Select a built frontend folder or files to publish");
  }
  if (input.mode === "container" && !input.container) {
    throw new Error(
      "A Git repository and immutable commit SHA are required for container publication",
    );
  }

  let app = input.existingApp;
  let boundProject = input.project;
  let apiKey: string | undefined;
  if (!app) {
    const description = input.description.trim();
    const created = await dependencies.createCloudApp({
      name: input.name.trim(),
      ...(description ? { description } : {}),
      app_url: PENDING_PUBLICATION_URL,
      allowed_origins: [PENDING_PUBLICATION_URL],
      is_active: false,
      skipGitHubRepo: true,
    });
    app = created.app;
    apiKey = created.apiKey;
    boundProject = await dependencies.bindProject(input.project.id, app.id);
    await input.onBound?.({
      project: boundProject,
      app,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  // Cloud records default active at creation. Keep the bound record explicitly
  // unpublished until the selected host proves a live URL; failed deploys must
  // never leave an active record pointing at pending.invalid.
  await dependencies.patchCloudApp(app.id, { is_active: false });

  let publicUrl: string;
  if (input.mode === "managed-frontend") {
    const published = await dependencies.publishFrontend(app.id, {
      files: input.frontendFiles ?? [],
      activate: true,
      buildMeta: { source: "project-publish" },
    });
    if (
      published.deployment.status !== "active" ||
      !published.public_url?.trim()
    ) {
      throw new Error(
        "Managed frontend uploaded but no active public URL is configured",
      );
    }
    publicUrl = published.public_url;
  } else {
    await dependencies.deployContainer(app.id, input.container);
    const deployed = await dependencies.waitForContainer(app.id);
    publicUrl = deployed.production_url?.trim() ?? "";
    if (!publicUrl) {
      throw new Error(
        "Container deployed without an authoritative production URL",
      );
    }
  }

  await dependencies.patchCloudApp(app.id, {
    name: input.name.trim(),
    description: input.description.trim(),
    app_url: publicUrl,
    allowed_origins: [publicUrl],
    is_active: true,
  });
  const freshApp = await dependencies.readCloudApp(app.id);
  return {
    project: boundProject,
    app: freshApp,
    publicUrl,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Unpublish without clearing the durable project-to-Cloud binding. */
export async function unpublishProject(appId: string): Promise<void> {
  await updateApp(appId, { is_active: false });
}

/** Delete the Cloud record, then clear its local binding. */
export async function deletePublishedProject(
  projectId: string,
  appId: string,
): Promise<ProjectSummary> {
  await deleteApp(appId);
  return unbindLocalProjectCloudApp(projectId);
}
