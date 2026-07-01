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

import { type AppDatabaseMode, DEFAULT_APP_DATABASE_MODE } from "./app-database-mode";
import { RESERVED_PLATFORM_ENV_KEYS, stripReservedEnvKeys } from "./reserved-env-keys";

export interface DeployAppRequest {
  appId: string;
  organizationId: string;
  userId: string;
  containerName: string;
  image: string;
  port?: number;
  /**
   * Whether this app gets its OWN isolated per-tenant Postgres. Default "none"
   * (a stateless app — no DB, no DATABASE_URL). "isolated" provisions the app's
   * own DB and injects the DSN. See {@link AppDatabaseMode}.
   */
  databaseMode?: AppDatabaseMode;
  /** Runtime env injected into the app container. DB vars are platform-owned. */
  env?: Record<string, string>;
}

export interface AppDeployRunOptions {
  /** Build context override, normally a git URL supplied to POST /deploy. */
  repoUrl?: string;
  /** Git branch/SHA/tag to build. */
  ref?: string;
  /** Dockerfile path relative to the build context. */
  dockerfile?: string;
  /** Runtime env injected into the app container. */
  env?: Record<string, string>;
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
  run(appId: string, options?: AppDeployRunOptions): Promise<void>;
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
  // Only "isolated" apps get a per-tenant DB. "none" (the default) is a stateless
  // app: skip provisioning entirely and inject NO DATABASE_URL — so a stateless
  // app never pays for a DB it doesn't use, and the deploy doesn't depend on the
  // tenant-DB cluster existing. Add one later by flipping the mode + redeploying
  // (ensureTenantDb is create-if-not-exists, so it materializes seamlessly).
  const mode = req.databaseMode ?? DEFAULT_APP_DATABASE_MODE;
  const dsn = mode === "isolated" ? await deps.ensureTenantDb(req.appId) : undefined;
  // Strip caller-supplied platform-reserved keys (managed DB DSN, cloud API
  // token, metered-identity keys, app attribution id) BEFORE injecting platform
  // values. Without this a stateless ("none"-mode) app could set
  // DATABASE_URL/POSTGRES_URL to point at an arbitrary DB, pre-empt a managed
  // identity key, or spoof the app id used for monetization attribution. The
  // agent path already enforces this denylist (findReservedManagedElizaEnvKeys);
  // the app path must too. POSTGRES_URL is added to the shared platform list
  // because it is the app-container DB var (DATABASE_URL is already reserved).
  const safeCallerEnv = stripReservedEnvKeys(req.env ?? {}, [
    ...RESERVED_PLATFORM_ENV_KEYS,
    "ELIZA_APP_ID",
    "POSTGRES_URL",
  ]);
  const environmentVars = {
    ...safeCallerEnv,
    // Platform-owned app attribution. Injected for both stateless and isolated
    // apps so in-container SDK calls can identify the deployed app.
    ELIZA_APP_ID: req.appId,
    // Platform-owned DB values are injected last so they always win for isolated
    // apps; stateless apps get neither var (and can no longer inject one).
    ...(dsn ? { DATABASE_URL: dsn, POSTGRES_URL: dsn } : {}),
  };

  const { containerId } = await deps.createContainerRow({
    appId: req.appId,
    organizationId: req.organizationId,
    userId: req.userId,
    containerName: req.containerName,
    image: req.image,
    port: req.port ?? 3000,
    // Every app gets the platform-owned ELIZA_APP_ID for attribution. Isolated
    // apps additionally get their OWN per-tenant DSN under BOTH `DATABASE_URL`
    // (the de-facto standard most apps read) and `POSTGRES_URL` (what plugin-sql
    // / eliza-based images read) — never the shared agent DATABASE_URL, and
    // never a silent fallback to a throwaway local/PGlite store. Stateless
    // ("none") apps get no DB vars.
    environmentVars,
  });

  const { id: jobId } = await deps.enqueueProvision({
    containerId,
    organizationId: req.organizationId,
    userId: req.userId,
  });

  await deps.linkContainerToApp(req.appId, containerId);

  return { containerId, jobId };
}
