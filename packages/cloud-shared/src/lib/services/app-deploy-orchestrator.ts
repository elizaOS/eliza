/**
 * App deploy orchestration (Apps / Product 2) — turns a deploy request into a
 * real provision: ensure the app's ISOLATED per-tenant DB, create a container
 * row carrying that DSN, enqueue a CONTAINER_PROVISION job, and link the
 * container to the app. This is what replaces the `/v1/apps/:id/deploy` stub
 * (which only flipped status='building').
 *
 * Every side is an injected seam, so the flow is unit-testable with fakes and
 * stays decoupled from 2AM's `containers` schema/repo (createContainerRow is
 * injected). The load-bearing property — the app container gets its OWN DSN, not
 * the shared agent DATABASE_URL — is asserted as a unit test.
 */

export interface DeployAppRequest {
  appId: string;
  organizationId: string;
  userId: string;
  containerName: string;
  image: string;
  port?: number;
}

export interface NewAppContainerRow {
  appId: string;
  organizationId: string;
  userId: string;
  containerName: string;
  image: string;
  port: number;
  environmentVars: Record<string, string>;
}

export interface AppDeployDeps {
  /** Ensure the app's isolated per-tenant DB exists; returns its DSN. */
  ensureTenantDb: (appId: string) => Promise<string>;
  /** Create the container row (in the `containers` table); returns its id. */
  createContainerRow: (row: NewAppContainerRow) => Promise<{ containerId: string }>;
  /** Enqueue the provision job for a container. */
  enqueueProvision: (p: {
    containerId: string;
    organizationId: string;
    userId: string;
  }) => Promise<{ id: string }>;
  /** Record the container id on the app (e.g. apps.metadata.containerId). */
  linkContainerToApp: (appId: string, containerId: string) => Promise<void>;
}

export interface DeployAppResult {
  containerId: string;
  jobId: string;
}

/**
 * Seam the deploy route/service calls to kick off the real provision for a
 * queued app deploy. The concrete runner (wired with the apps repo, image
 * resolution, and {@link deployApp}'s deps) lives at the integration boundary;
 * `AppDeploymentsService` invokes it after marking the app `building`.
 */
export interface AppDeployRunner {
  run(appId: string): Promise<void>;
}

/**
 * Deploy an app container. Order matters: the DB DSN must exist before the
 * container row is created (the row carries it), and the row must exist before
 * the provision job can reference it.
 */
export async function deployApp(
  req: DeployAppRequest,
  deps: AppDeployDeps,
): Promise<DeployAppResult> {
  const dsn = await deps.ensureTenantDb(req.appId);

  const { containerId } = await deps.createContainerRow({
    appId: req.appId,
    organizationId: req.organizationId,
    userId: req.userId,
    containerName: req.containerName,
    image: req.image,
    port: req.port ?? 3000,
    // The app's OWN isolated DSN — never the shared agent DATABASE_URL.
    environmentVars: { DATABASE_URL: dsn },
  });

  const { id: jobId } = await deps.enqueueProvision({
    containerId,
    organizationId: req.organizationId,
    userId: req.userId,
  });

  await deps.linkContainerToApp(req.appId, containerId);

  return { containerId, jobId };
}
