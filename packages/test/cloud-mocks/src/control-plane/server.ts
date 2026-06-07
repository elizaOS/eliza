import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ControlPlaneStore, type Job, type Sandbox } from "./store";

type DatabaseJob = {
  id: string;
  type: string;
  data: unknown;
  max_attempts?: number | null;
};

export interface ControlPlaneMockOptions {
  /** Bearer token required on every request. Defaults to env or "test-token". */
  token?: string;
  /** Hetzner mock base URL (e.g. `http://127.0.0.1:NNNN/v1`). */
  hetznerUrl: string;
  /** Hetzner bearer token. Defaults to env or "test-token". */
  hetznerToken?: string;
  /** Optional clock for time-based logic. */
  now?: () => Date;
  /** Optional store override. */
  store?: ControlPlaneStore;
  /** How long an action poll is allowed to take per job tick, in ms. */
  hetznerActionPollTimeoutMs?: number;
  /** Stuck-provisioning cutoff in ms (default 10 minutes). */
  stuckProvisioningMs?: number;
  /** Default warm-pool target size; `agent-hot-pool` cron drives toward this. */
  hotPoolSize?: number;
  /** Default agent image used by hot-pool cron. */
  defaultAgentImage?: string;
  /** Stub log lines returned by GET /containers/:id/logs. */
  containerLogLines?: string[];
  /** Bearer token required on `/api/v1/admin/*` endpoints. */
  adminToken?: string;
  /** ms until container create/delete/restart actions resolve. Default 30. */
  containerActionMs?: number;
  /** ms between SSE events on the bridge stream. Default 5. */
  bridgeStreamIntervalMs?: number;
  /**
   * When set, requests must also include `x-container-control-plane-token` with this value
   * in addition to the bearer token. Mirrors the real impl's dual-token auth, which is
   * enabled by `CONTAINER_CONTROL_PLANE_TOKEN` env var. Default reads that env var; pass
   * an empty string or `undefined` to disable.
   */
  expectedAuxToken?: string;
  /** Whether the warm pool is enabled (admin GET reports this). Default true. */
  warmPoolEnabled?: boolean;
  /** Warm-pool min size (admin GET reports this). Default 0. */
  warmPoolMin?: number;
  /** Warm-pool max size (admin GET reports this). Default 10. */
  warmPoolMax?: number;
  /** Warm-pool image label (admin GET reports this). Default `elizaos/agent:latest`. */
  warmPoolImage?: string;
}

interface HetznerActionResponse {
  action: { id: number; status: "running" | "success" | "error" };
}

interface HetznerServerResponse {
  server: { id: number; status: string };
  action?: { id: number; status: "running" | "success" | "error" };
}

export function buildControlPlaneApp(options: ControlPlaneMockOptions): {
  app: Hono;
  store: ControlPlaneStore;
  tick: (
    limit?: number,
  ) => Promise<{ processed: number; failed: number; skipped: number }>;
  processDbBackedJobs: (
    databaseUrl: string,
    origin: string,
    limit?: number,
  ) => Promise<{
    claimed: number;
    succeeded: number;
    failed: number;
    errors: Array<{ jobId: string; error: string }>;
  }>;
  cleanupStuck: () => Promise<{ failed: number }>;
} {
  const token =
    options.token ?? process.env.CONTAINER_CONTROL_PLANE_TOKEN ?? "test-token";
  const hetznerToken =
    options.hetznerToken ?? process.env.HCLOUD_TOKEN ?? "test-token";
  const hetznerUrl = options.hetznerUrl.replace(/\/$/, "");
  const now = options.now ?? (() => new Date());
  const store = options.store ?? new ControlPlaneStore(now);
  const actionPollTimeoutMs = options.hetznerActionPollTimeoutMs ?? 5000;
  const stuckProvisioningMs = options.stuckProvisioningMs ?? 10 * 60 * 1000;
  const hotPoolSize = options.hotPoolSize ?? 0;
  const defaultAgentImage =
    options.defaultAgentImage ?? "ghcr.io/elizaos/agent:latest";
  const containerLogLines = options.containerLogLines ?? [
    "[mock] container started",
    "[mock] health check passed",
  ];
  const adminToken = options.adminToken ?? "test-admin-token";
  const containerActionMs = options.containerActionMs ?? 30;
  const bridgeStreamIntervalMs = options.bridgeStreamIntervalMs ?? 5;
  const expectedAuxToken =
    options.expectedAuxToken !== undefined
      ? options.expectedAuxToken || undefined
      : process.env.CONTAINER_CONTROL_PLANE_TOKEN || undefined;
  const warmPoolEnabled = options.warmPoolEnabled ?? true;
  const warmPoolMin = options.warmPoolMin ?? 0;
  const warmPoolMax = options.warmPoolMax ?? 10;
  const warmPoolImage = options.warmPoolImage ?? defaultAgentImage;

  store.setWarmPoolState({
    enabled: warmPoolEnabled,
    minSize: warmPoolMin,
    maxSize: warmPoolMax,
    image: warmPoolImage,
    targetImage: warmPoolImage,
  });

  store.setHotPoolTarget(hotPoolSize);

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    // Admin endpoints use their own token, validated per-route.
    if (c.req.path.startsWith("/api/v1/admin/")) return next();
    // Compat endpoints are public stubs.
    if (c.req.path.startsWith("/api/compat/")) return next();
    if (expectedAuxToken) {
      const aux = c.req.header("x-container-control-plane-token")?.trim();
      if (aux !== expectedAuxToken) {
        return c.json(
          { success: false, error: "Unauthorized (aux token)" },
          401,
        );
      }
      if (
        c.req.path.startsWith("/api/v1/cron/") ||
        c.req.path.startsWith("/cron/")
      ) {
        return next();
      }
    }
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ") || auth.slice(7).trim() !== token) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    await next();
  });

  function readJobString(job: DatabaseJob, key: string): string {
    const data =
      job.data && typeof job.data === "object"
        ? (job.data as Record<string, unknown>)
        : {};
    const value = data[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`DB-backed mock job ${job.id} missing ${key}`);
    }
    return value;
  }

  async function processDbBackedJobs(
    databaseUrl: string,
    origin: string,
    limit = 1000,
  ): Promise<{
    claimed: number;
    succeeded: number;
    failed: number;
    errors: Array<{ jobId: string; error: string }>;
  }> {
    const [
      { agentSandboxesRepository },
      { jobsRepository },
      { runWithCloudBindingsAsync },
      { JOB_TYPES },
    ] = await Promise.all([
      import("@elizaos/cloud-shared/db/repositories/agent-sandboxes.ts"),
      import("@elizaos/cloud-shared/db/repositories/jobs.ts"),
      import("@elizaos/cloud-shared/lib/runtime/cloud-bindings.ts"),
      import("@elizaos/cloud-shared/lib/services/provisioning-job-types.ts"),
    ]);

    return runWithCloudBindingsAsync(
      { DATABASE_URL: databaseUrl },
      async () => {
        const result = {
          claimed: 0,
          succeeded: 0,
          failed: 0,
          errors: [] as Array<{ jobId: string; error: string }>,
        };
        const batchSize = Math.max(1, Math.floor(limit));
        const claim = (type: string) =>
          jobsRepository.claimPendingJobs({ type, limit: batchSize });
        // Provision/delete are reimplemented against the Hetzner mock; the
        // remaining lifecycle jobs are reproduced as direct agent_sandboxes
        // row transitions (mirroring the real handlers' DB effects), which is
        // all the mock stack needs to assert status/backup outcomes.
        const provisionJobs = await claim(JOB_TYPES.AGENT_PROVISION);
        const deleteJobs = await claim(JOB_TYPES.AGENT_DELETE);
        const suspendJobs = await claim(JOB_TYPES.AGENT_SUSPEND);
        const resumeJobs = await claim(JOB_TYPES.AGENT_RESUME);
        const sleepJobs = await claim(JOB_TYPES.AGENT_SLEEP);
        const wakeJobs = await claim(JOB_TYPES.AGENT_WAKE);
        const snapshotJobs = await claim(JOB_TYPES.AGENT_SNAPSHOT);

        for (const job of [
          ...provisionJobs,
          ...deleteJobs,
          ...suspendJobs,
          ...resumeJobs,
          ...sleepJobs,
          ...wakeJobs,
          ...snapshotJobs,
        ]) {
          result.claimed += 1;
          try {
            if (job.type === JOB_TYPES.AGENT_DELETE) {
              const agentId = readJobString(job, "agentId");
              const organizationId = readJobString(job, "organizationId");
              const existing = await agentSandboxesRepository.findByIdAndOrg(
                agentId,
                organizationId,
              );
              if (
                existing?.sandbox_id &&
                store.getSandbox(existing.sandbox_id)
              ) {
                store.updateSandbox(existing.sandbox_id, { status: "deleted" });
              }
              await agentSandboxesRepository.delete(agentId, organizationId);
              await jobsRepository.updateStatus(job.id, "completed", {
                result: {
                  cloudAgentId: agentId,
                  containerStopped: true,
                  rowDeleted: true,
                },
                completed_at: now(),
              });
              result.succeeded += 1;
              continue;
            }

            if (job.type === JOB_TYPES.AGENT_SUSPEND) {
              const agentId = readJobString(job, "agentId");
              await agentSandboxesRepository.update(agentId, {
                status: "stopped",
                bridge_url: null,
                health_url: null,
              });
              await jobsRepository.updateStatus(job.id, "completed", {
                result: { cloudAgentId: agentId, containerStopped: true },
                completed_at: now(),
              });
              result.succeeded += 1;
              continue;
            }

            if (job.type === JOB_TYPES.AGENT_RESUME) {
              const agentId = readJobString(job, "agentId");
              const organizationId = readJobString(job, "organizationId");
              const existing = await agentSandboxesRepository.findByIdAndOrg(
                agentId,
                organizationId,
              );
              const sandboxId = existing?.sandbox_id ?? `memory-${agentId}`;
              const bridgeUrl = `${origin}/api/compat/agents/${encodeURIComponent(sandboxId)}`;
              await agentSandboxesRepository.update(agentId, {
                status: "running",
                sandbox_id: sandboxId,
                bridge_url: bridgeUrl,
                health_url: `${bridgeUrl}/health`,
                last_heartbeat_at: now(),
                error_message: null,
              });
              await jobsRepository.updateStatus(job.id, "completed", {
                result: {
                  cloudAgentId: agentId,
                  containerStarted: true,
                  reprovisioned: true,
                },
                completed_at: now(),
              });
              result.succeeded += 1;
              continue;
            }

            if (job.type === JOB_TYPES.AGENT_SLEEP) {
              const agentId = readJobString(job, "agentId");
              const organizationId = readJobString(job, "organizationId");
              const existing = await agentSandboxesRepository.findByIdAndOrg(
                agentId,
                organizationId,
              );
              const stateData = {
                memories: [],
                config:
                  (existing?.agent_config as Record<string, unknown> | null) ??
                  {},
                workspaceFiles: {},
              };
              const backup = await agentSandboxesRepository.createBackup({
                sandbox_record_id: agentId,
                snapshot_type: "pre-shutdown",
                state_data: stateData,
                size_bytes: Buffer.byteLength(
                  JSON.stringify(stateData),
                  "utf-8",
                ),
              });
              await agentSandboxesRepository.update(agentId, {
                status: "sleeping",
                sandbox_id: null,
                bridge_url: null,
                health_url: null,
                node_id: null,
                container_name: null,
                bridge_port: null,
                web_ui_port: null,
                last_backup_at: now(),
              });
              await jobsRepository.updateStatus(job.id, "completed", {
                result: {
                  cloudAgentId: agentId,
                  containerRemoved: true,
                  backupId: backup.id,
                },
                completed_at: now(),
              });
              result.succeeded += 1;
              continue;
            }

            if (job.type === JOB_TYPES.AGENT_WAKE) {
              const agentId = readJobString(job, "agentId");
              const organizationId = readJobString(job, "organizationId");
              const userId = readJobString(job, "userId");
              // Mirror provision: stand up a fresh mock sandbox, mark running.
              const sandbox = store.createSandbox({
                organizationId,
                userId,
                agentId,
              });
              store.updateSandbox(sandbox.id, { status: "running" });
              const bridgeUrl = `${origin}/api/compat/agents/${encodeURIComponent(sandbox.id)}`;
              await agentSandboxesRepository.update(agentId, {
                status: "running",
                sandbox_id: sandbox.id,
                bridge_url: bridgeUrl,
                health_url: `${bridgeUrl}/health`,
                last_heartbeat_at: now(),
                error_message: null,
              });
              await jobsRepository.updateStatus(job.id, "completed", {
                result: { cloudAgentId: agentId, reprovisioned: true },
                completed_at: now(),
              });
              result.succeeded += 1;
              continue;
            }

            if (job.type === JOB_TYPES.AGENT_SNAPSHOT) {
              const agentId = readJobString(job, "agentId");
              const organizationId = readJobString(job, "organizationId");
              const data =
                job.data && typeof job.data === "object"
                  ? (job.data as Record<string, unknown>)
                  : {};
              const snapshotType =
                data.snapshotType === "manual" ? "manual" : "auto";
              const existing = await agentSandboxesRepository.findByIdAndOrg(
                agentId,
                organizationId,
              );
              const stateData = {
                memories: [],
                config:
                  (existing?.agent_config as Record<string, unknown> | null) ??
                  {},
                workspaceFiles: {},
              };
              const backup = await agentSandboxesRepository.createBackup({
                sandbox_record_id: agentId,
                snapshot_type: snapshotType,
                state_data: stateData,
                size_bytes: Buffer.byteLength(
                  JSON.stringify(stateData),
                  "utf-8",
                ),
              });
              await agentSandboxesRepository.update(agentId, {
                last_backup_at: now(),
              });
              await jobsRepository.updateStatus(job.id, "completed", {
                result: {
                  cloudAgentId: agentId,
                  backupId: backup.id,
                  snapshotType,
                  sizeBytes: backup.size_bytes ?? 0,
                },
                completed_at: now(),
              });
              result.succeeded += 1;
              continue;
            }

            const agentId = readJobString(job, "agentId");
            const organizationId = readJobString(job, "organizationId");
            const userId = readJobString(job, "userId");
            const agentName = readJobString(job, "agentName");
            const sandbox = store.createSandbox({
              organizationId,
              userId,
              agentId,
            });
            store.updateSandbox(sandbox.id, { status: "running" });
            const container = store.createContainer({
              name: agentName,
              projectName: `agent-${agentId.slice(0, 8)}`,
              organizationId,
              userId,
              image: defaultAgentImage,
              actionMs: containerActionMs,
            });
            store.updateContainer(container.id, {
              status: "running",
              pendingActionAt: undefined,
              pendingAction: undefined,
            });

            const bridgeUrl = `${origin}/api/compat/agents/${encodeURIComponent(
              sandbox.id,
            )}`;
            const healthUrl = `${bridgeUrl}/health`;
            await agentSandboxesRepository.update(agentId, {
              status: "running",
              database_status: "ready",
              database_uri: databaseUrl,
              sandbox_id: sandbox.id,
              bridge_url: bridgeUrl,
              health_url: healthUrl,
              last_heartbeat_at: now(),
              error_message: null,
            });
            await jobsRepository.updateStatus(job.id, "completed", {
              result: {
                cloudAgentId: agentId,
                status: "running",
                bridgeUrl,
                healthUrl,
              },
              completed_at: now(),
            });
            result.succeeded += 1;
          } catch (error) {
            result.failed += 1;
            const message =
              error instanceof Error ? error.message : String(error);
            result.errors.push({ jobId: job.id, error: message });
            await jobsRepository.incrementAttempt(
              job.id,
              message,
              job.max_attempts ?? 3,
            );
          }
        }
        return result;
      },
    );
  }

  function requireForwardedAuth(
    c: Context,
  ): { userId: string; organizationId: string } | Response {
    const userId = c.req.header("x-eliza-user-id")?.trim();
    const organizationId = c.req.header("x-eliza-organization-id")?.trim();
    if (!userId || !organizationId) {
      return c.json(
        {
          success: false,
          error: "Missing forwarded user or organization headers",
        },
        400,
      );
    }
    return { userId, organizationId };
  }

  app.get("/health", (c) =>
    c.json({ success: true, service: "control-plane-mock" }),
  );

  app.post("/jobs", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return c.json({ success: false, error: "JSON body required" }, 400);

    const type =
      body.type === "agent_delete" ? "agent_delete" : "agent_provision";

    let sandboxId =
      typeof body.sandbox_id === "string" ? body.sandbox_id : undefined;
    if (type === "agent_provision") {
      if (!sandboxId) {
        const sandbox = store.createSandbox({
          organizationId: auth.organizationId,
          userId: auth.userId,
          agentId:
            typeof body.agent_id === "string" ? body.agent_id : undefined,
        });
        sandboxId = sandbox.id;
      }
    } else {
      if (!sandboxId) {
        return c.json(
          { success: false, error: "sandbox_id required for agent_delete" },
          400,
        );
      }
      const sandbox = store.getSandbox(sandboxId);
      if (!sandbox)
        return c.json({ success: false, error: "sandbox not found" }, 404);
      store.updateSandbox(sandboxId, { status: "deletion_pending" });
    }

    const job = store.createJob({
      type,
      sandboxId,
      organizationId: auth.organizationId,
      userId: auth.userId,
      payload: (body.payload as Record<string, unknown> | undefined) ?? {},
    });

    return c.json(
      { success: true, data: { job, sandbox: store.getSandbox(sandboxId) } },
      201,
    );
  });

  app.get("/jobs/:id", (c) => {
    const job = store.getJob(c.req.param("id"));
    if (!job) return c.json({ success: false, error: "job not found" }, 404);
    return c.json({ success: true, data: job });
  });

  app.get("/sandboxes/:id", (c) => {
    const sandbox = store.getSandbox(c.req.param("id"));
    if (!sandbox)
      return c.json({ success: false, error: "sandbox not found" }, 404);
    return c.json({ success: true, data: sandbox });
  });

  const processProvisioningJobsHandler = async (c: Context) => {
    const rawLimit = c.req.query("limit");
    const parsed =
      rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : Number.NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
    const databaseUrl = c.req.header("x-eliza-cloud-database-url")?.trim();
    const result = databaseUrl
      ? await processDbBackedJobs(databaseUrl, new URL(c.req.url).origin, limit)
      : await tick(limit);
    return c.json({ success: true, data: result });
  };
  app.post("/cron/process-provisioning-jobs", processProvisioningJobsHandler);
  app.get("/cron/process-provisioning-jobs", processProvisioningJobsHandler);
  app.post(
    "/api/v1/cron/process-provisioning-jobs",
    processProvisioningJobsHandler,
  );
  app.get(
    "/api/v1/cron/process-provisioning-jobs",
    processProvisioningJobsHandler,
  );

  const cleanupStuckHandler = async (c: Context) => {
    const result = await cleanupStuck();
    return c.json({ success: true, data: result });
  };
  app.post("/cron/cleanup-stuck-provisioning", cleanupStuckHandler);
  app.get("/cron/cleanup-stuck-provisioning", cleanupStuckHandler);
  app.post("/api/v1/cron/cleanup-stuck-provisioning", cleanupStuckHandler);
  app.get("/api/v1/cron/cleanup-stuck-provisioning", cleanupStuckHandler);

  // ── Latency injection ─────────────────────────────────────────────────
  async function latency(): Promise<void> {
    if (process.env.MOCK_HETZNER_LATENCY === "0") return;
    await new Promise((r) => setTimeout(r, 5));
  }

  function requireAdmin(c: Context): Response | null {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ") || auth.slice(7).trim() !== adminToken) {
      return c.json({ success: false, error: "Unauthorized (admin)" }, 401);
    }
    return null;
  }

  // ── Containers CRUD ──────────────────────────────────────────────────
  app.post("/api/v1/containers", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return c.json({ success: false, error: "JSON body required" }, 400);
    const name = typeof body.name === "string" ? body.name : undefined;
    const projectName =
      typeof body.project_name === "string" ? body.project_name : undefined;
    const image = typeof body.image === "string" ? body.image : undefined;
    if (!name || !projectName || !image) {
      return c.json(
        { success: false, error: "name, project_name, image required" },
        400,
      );
    }
    const env =
      body.environment_vars &&
      typeof body.environment_vars === "object" &&
      !Array.isArray(body.environment_vars)
        ? Object.fromEntries(
            Object.entries(
              body.environment_vars as Record<string, unknown>,
            ).map(([k, v]) => [k, String(v)]),
          )
        : {};
    const container = store.createContainer({
      name,
      projectName,
      organizationId: auth.organizationId,
      userId: auth.userId,
      image,
      port: typeof body.port === "number" ? body.port : undefined,
      desiredCount:
        typeof body.desired_count === "number" ? body.desired_count : undefined,
      cpu: typeof body.cpu === "number" ? body.cpu : undefined,
      memoryMb: typeof body.memory === "number" ? body.memory : undefined,
      healthCheckPath:
        typeof body.health_check_path === "string"
          ? body.health_check_path
          : undefined,
      environmentVars: env,
      actionMs: containerActionMs,
    });
    return c.json(
      {
        success: true,
        data: container,
        polling: {
          endpoint: `/api/v1/containers/${container.id}`,
          intervalMs: 50,
          expectedDurationMs: containerActionMs * 4,
        },
      },
      201,
    );
  });

  app.get("/api/v1/containers/:id", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    store.resolveContainerActions();
    const container = store.getContainer(c.req.param("id"));
    if (!container)
      return c.json({ success: false, error: "Container not found" }, 404);
    if (container.organizationId !== auth.organizationId) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    return c.json({ success: true, data: container });
  });

  app.patch("/api/v1/containers/:id", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const id = c.req.param("id");
    const container = store.getContainer(id);
    if (!container || container.organizationId !== auth.organizationId) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return c.json({ success: false, error: "JSON body required" }, 400);
    if (body.environment_vars !== undefined) {
      if (
        typeof body.environment_vars !== "object" ||
        body.environment_vars === null ||
        Array.isArray(body.environment_vars)
      ) {
        return c.json(
          { success: false, error: "environment_vars must be an object" },
          400,
        );
      }
      const env = Object.fromEntries(
        Object.entries(body.environment_vars as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)],
        ),
      );
      const updated = store.updateContainer(id, { environmentVars: env });
      return c.json({ success: true, data: updated });
    }
    if (body.desired_count !== undefined) {
      const next = Number(body.desired_count);
      if (!Number.isFinite(next)) {
        return c.json(
          { success: false, error: "desired_count must be a number" },
          400,
        );
      }
      const updated = store.updateContainer(id, { desiredCount: next });
      return c.json({ success: true, data: updated });
    }
    if (body.action === "restart" || body.status === "restarting") {
      const updated = store.updateContainer(id, {
        status: "restarting",
        pendingActionAt: now().getTime() + containerActionMs,
        pendingAction: "running",
      });
      return c.json({ success: true, data: updated });
    }
    return c.json(
      {
        success: false,
        error:
          "PATCH supports environment_vars, desired_count, or action=restart",
      },
      400,
    );
  });

  app.delete("/api/v1/containers/:id", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const id = c.req.param("id");
    const container = store.getContainer(id);
    if (!container || container.organizationId !== auth.organizationId) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    store.updateContainer(id, {
      status: "deleting",
      pendingActionAt: now().getTime() + containerActionMs,
      pendingAction: "deleted",
    });
    return c.json({ success: true });
  });

  app.post("/api/v1/containers/:id/workspace-sync", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const id = c.req.param("id");
    const container = store.getContainer(id);
    if (!container || container.organizationId !== auth.organizationId) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    const updated = store.updateContainer(id, {
      workspaceSyncs: container.workspaceSyncs + 1,
    });
    return c.json(
      {
        success: true,
        data: {
          containerId: id,
          syncCount: updated.workspaceSyncs,
          acceptedAt: now().toISOString(),
        },
      },
      202,
    );
  });

  app.get("/api/v1/containers/:id/logs", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const id = c.req.param("id");
    const container = store.getContainer(id);
    if (!container || container.organizationId !== auth.organizationId) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    const tailRaw = Number(c.req.query("tail") ?? "200");
    const tail = Number.isFinite(tailRaw)
      ? Math.max(1, Math.floor(tailRaw))
      : 200;
    const lines = containerLogLines.slice(-tail).join("\n");
    return c.text(lines, 200, { "content-type": "text/plain; charset=utf-8" });
  });

  app.get("/api/v1/containers/:id/metrics", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const id = c.req.param("id");
    const container = store.getContainer(id);
    if (!container || container.organizationId !== auth.organizationId) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    return c.json({
      success: true,
      data: {
        containerId: id,
        cpu: { usagePct: 12.5, limit: container.cpu },
        memory: { usedMb: 64, limitMb: container.memoryMb },
        disk: { usedMb: 128, limitMb: 1024 },
        timestamp: now().toISOString(),
      },
    });
  });

  // ── JSON-RPC bridge + SSE ────────────────────────────────────────────
  app.post("/api/v1/eliza/agents/:agentId/bridge", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid JSON-RPC request" },
        },
        400,
      );
    }
    const id = body.id ?? null;
    const method = body.method;
    let result: unknown;
    if (method === "ping") {
      result = { pong: true, agentId: c.req.param("agentId") };
    } else if (method === "getStatus") {
      result = {
        status: "running",
        agentId: c.req.param("agentId"),
        uptimeMs: 1000,
      };
    } else {
      result = {};
    }
    return c.json({ jsonrpc: "2.0", id, result });
  });

  app.get("/api/v1/eliza/agents/:agentId/bridge/stream", async (c) => {
    const authResult = requireForwardedAuth(c);
    if (authResult instanceof Response) return authResult;
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ agentId: c.req.param("agentId") }),
      });
      for (let i = 0; i < 3; i += 1) {
        await stream.sleep(bridgeStreamIntervalMs);
        await stream.writeSSE({
          event: "tick",
          data: JSON.stringify({ n: i + 1 }),
        });
      }
      await stream.writeSSE({ event: "done", data: JSON.stringify({}) });
    });
  });

  // Real impl: POST /api/v1/eliza/agents/:id/stream takes a JSON-RPC body
  // (method must be "message.send") and returns SSE.
  app.post("/api/v1/eliza/agents/:agentId/stream", async (c) => {
    const authResult = requireForwardedAuth(c);
    if (authResult instanceof Response) return authResult;
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const streamHeaders = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return new Response(
        `event: error\ndata: ${JSON.stringify({ message: "Invalid JSON-RPC stream request" })}\n\n`,
        { status: 400, headers: streamHeaders },
      );
    }
    const rpcId = body.id ?? null;
    const agentId = c.req.param("agentId");
    return streamSSE(c, async (stream) => {
      for (let i = 1; i <= 2; i += 1) {
        await stream.sleep(bridgeStreamIntervalMs);
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify({
            jsonrpc: "2.0",
            method: "progress",
            params: { step: i },
          }),
        });
      }
      await stream.sleep(bridgeStreamIntervalMs);
      await stream.writeSSE({
        event: "response",
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          result: { agentId, accepted: true },
        }),
      });
    });
  });

  // ── Hot pool / autoscale crons ───────────────────────────────────────
  const deploymentMonitorHandler = async (_c: Context) => {
    await latency();
    const count = store.incrementCron("deployment-monitor-tick");
    return _c.json({
      success: true,
      data: { count, timestamp: now().toISOString() },
    });
  };
  app.post("/api/v1/cron/deployment-monitor", deploymentMonitorHandler);
  app.get("/api/v1/cron/deployment-monitor", deploymentMonitorHandler);

  const agentHotPoolHandler = async (c: Context) => {
    await latency();
    const count = store.incrementCron("agent-hot-pool-tick");
    const added = store.replenishWarmPool(
      defaultAgentImage,
      store.getHotPoolTarget(),
    );
    return c.json({
      success: true,
      data: {
        count,
        image: defaultAgentImage,
        target: store.getHotPoolTarget(),
        added,
        warmPoolSize: store.warmPoolSnapshot().length,
        timestamp: now().toISOString(),
      },
    });
  };
  app.post("/api/v1/cron/agent-hot-pool", agentHotPoolHandler);
  app.get("/api/v1/cron/agent-hot-pool", agentHotPoolHandler);

  const nodeAutoscaleHandler = async (c: Context) => {
    await latency();
    const count = store.incrementCron("node-autoscale-tick");
    return c.json({
      success: true,
      data: { count, action: "noop", timestamp: now().toISOString() },
    });
  };
  app.post("/api/v1/cron/node-autoscale", nodeAutoscaleHandler);
  app.get("/api/v1/cron/node-autoscale", nodeAutoscaleHandler);

  // Hono parameters do not match partial-segment patterns like `pool-:rest`,
  // so use a single catchall handler that inspects the suffix.
  const poolCatchallHandler = async (c: Context) => {
    const name = c.req.param("name");
    if (!name?.startsWith("pool-")) {
      return c.json({ success: false, error: "Not found" }, 404);
    }
    await latency();
    const count = store.incrementCron(`${name}-tick`);
    return c.json({
      success: true,
      data: { kind: name, count, timestamp: now().toISOString() },
    });
  };
  app.post("/api/v1/cron/:name", poolCatchallHandler);
  app.get("/api/v1/cron/:name", poolCatchallHandler);

  // ── Admin endpoints ──────────────────────────────────────────────────
  app.get("/api/v1/admin/warm-pool", async (c) => {
    const unauthorized = requireAdmin(c);
    if (unauthorized) return unauthorized;
    await latency();
    const state = store.getWarmPoolState();
    return c.json({
      success: true,
      data: {
        image: state.image,
        enabled: state.enabled,
        minSize: state.minSize,
        maxSize: state.maxSize,
        currentSize: store.warmPoolSnapshot().length,
        rolloutState: state.rolloutState,
      },
    });
  });

  app.get("/api/v1/admin/warm-pool/rollout-status", async (c) => {
    const unauthorized = requireAdmin(c);
    if (unauthorized) return unauthorized;
    await latency();
    const state = store.getWarmPoolState();
    return c.json({
      success: true,
      data: {
        status: state.rolloutState,
        targetImage: state.targetImage,
        completedSandboxes: state.completedSandboxes,
        totalSandboxes: state.totalSandboxes,
      },
    });
  });

  app.post("/api/v1/admin/warm-pool", async (c) => {
    const unauthorized = requireAdmin(c);
    if (unauthorized) return unauthorized;
    await latency();
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (
      !body ||
      typeof body.target !== "number" ||
      !Number.isFinite(body.target)
    ) {
      return c.json({ success: false, error: "target (number) required" }, 400);
    }
    store.setHotPoolTarget(body.target);
    return c.json({
      success: true,
      data: {
        target: store.getHotPoolTarget(),
        warmPoolSize: store.warmPoolSnapshot().length,
      },
    });
  });

  app.post("/api/v1/admin/docker-nodes/:id/health-check", async (c) => {
    const unauthorized = requireAdmin(c);
    if (unauthorized) return unauthorized;
    await latency();
    return c.json({
      success: true,
      data: {
        nodeId: c.req.param("id"),
        healthy: true,
        timestamp: now().toISOString(),
      },
    });
  });

  // ── Compat ───────────────────────────────────────────────────────────
  app.delete("/api/compat/agents/:id", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    await latency();
    const id = c.req.param("id");
    // Find a sandbox associated with this agentId (best-effort match).
    const sandbox = store
      .allSandboxes()
      .find(
        (s) => s.agentId === id && s.organizationId === auth.organizationId,
      );
    if (!sandbox) {
      return c.json({ error: "agent_not_found" }, 404);
    }
    store.updateSandbox(sandbox.id, { status: "deletion_pending" });
    const job = store.createJob({
      type: "agent_delete",
      sandboxId: sandbox.id,
      organizationId: auth.organizationId,
      userId: auth.userId,
      payload: { agentId: id },
    });
    return c.json({ ok: true, jobId: job.id });
  });

  app.get("/api/compat/agents/:id", async (c) => {
    await latency();
    const id = c.req.param("id");
    return c.json({
      success: true,
      data: {
        id,
        name: "Mock Agent",
        bio: ["A mock agent character returned by the control-plane mock."],
        system: "You are a mock agent.",
        plugins: [],
      },
    });
  });

  async function hetznerFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${hetznerUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${hetznerToken}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  async function pollHetznerAction(
    actionId: number,
  ): Promise<"success" | "error" | "timeout"> {
    const deadline = Date.now() + actionPollTimeoutMs;
    while (Date.now() < deadline) {
      const res = await hetznerFetch(`/actions/${actionId}`);
      if (!res.ok) return "error";
      const body = (await res.json()) as HetznerActionResponse;
      if (body.action.status === "success") return "success";
      if (body.action.status === "error") return "error";
      await new Promise((r) => setTimeout(r, 20));
    }
    return "timeout";
  }

  async function processProvisionJob(job: Job): Promise<void> {
    const sandbox = store.getSandbox(job.sandboxId);
    if (!sandbox) {
      store.updateJob(job.id, {
        status: "failed",
        errorReason: "sandbox missing",
        finishedAt: now(),
      });
      return;
    }
    const createRes = await hetznerFetch("/servers", {
      method: "POST",
      body: JSON.stringify({
        name: `mock-${sandbox.id}`,
        server_type: "cx22",
        location: "fsn1",
        image: "ubuntu-22.04",
        user_data: "",
        labels: {
          sandbox_id: sandbox.id,
          organization_id: sandbox.organizationId,
        },
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      failJobAndSandbox(
        job,
        sandbox,
        `hetzner create failed: ${createRes.status} ${text}`,
        "error",
      );
      return;
    }
    const body = (await createRes.json()) as HetznerServerResponse;
    const serverId = body.server.id;
    store.updateSandbox(sandbox.id, { hetznerServerId: serverId });

    if (body.action) {
      const result = await pollHetznerAction(body.action.id);
      if (result !== "success") {
        failJobAndSandbox(
          job,
          sandbox,
          `hetzner action ${result}`,
          result === "timeout" ? "error" : "error",
        );
        return;
      }
    }

    store.updateSandbox(sandbox.id, { status: "running" });
    store.updateJob(job.id, { status: "completed", finishedAt: now() });
  }

  async function processDeleteJob(job: Job): Promise<void> {
    const sandbox = store.getSandbox(job.sandboxId);
    if (!sandbox) {
      store.updateJob(job.id, {
        status: "failed",
        errorReason: "sandbox missing",
        finishedAt: now(),
      });
      return;
    }
    if (sandbox.hetznerServerId !== null) {
      const deleteRes = await hetznerFetch(
        `/servers/${sandbox.hetznerServerId}`,
        {
          method: "DELETE",
        },
      );
      // 404 = already gone; treated as success per docker-error-classifier (PR #7746).
      if (!deleteRes.ok && deleteRes.status !== 404) {
        const text = await deleteRes.text().catch(() => "");
        failDeleteJob(
          job,
          sandbox,
          `hetzner delete failed: ${deleteRes.status} ${text}`,
        );
        return;
      }
      if (deleteRes.ok) {
        const body = (await deleteRes
          .json()
          .catch(() => null)) as HetznerActionResponse | null;
        if (body?.action) {
          const result = await pollHetznerAction(body.action.id);
          if (result === "error") {
            failDeleteJob(job, sandbox, "hetzner delete action errored");
            return;
          }
        }
      }
    }
    store.updateSandbox(sandbox.id, { status: "deleted" });
    store.updateJob(job.id, { status: "completed", finishedAt: now() });
  }

  function failJobAndSandbox(
    job: Job,
    sandbox: Sandbox,
    reason: string,
    sandboxStatus: "error",
  ): void {
    store.updateSandbox(sandbox.id, {
      status: sandboxStatus,
      errorReason: reason,
    });
    store.updateJob(job.id, {
      status: "failed",
      errorReason: reason,
      finishedAt: now(),
    });
  }

  function failDeleteJob(job: Job, sandbox: Sandbox, reason: string): void {
    store.updateSandbox(sandbox.id, {
      status: "deletion_failed",
      errorReason: reason,
    });
    store.updateJob(job.id, {
      status: "failed",
      errorReason: reason,
      finishedAt: now(),
    });
  }

  async function tick(limit = Number.POSITIVE_INFINITY): Promise<{
    processed: number;
    failed: number;
    skipped: number;
  }> {
    const pending = store.pendingJobs();
    const cap = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : pending.length;
    const slice = pending.slice(0, cap);
    let processed = 0;
    let failed = 0;
    for (const job of slice) {
      store.updateJob(job.id, { status: "in_progress", startedAt: now() });
      const fresh = store.getJob(job.id);
      if (!fresh) continue;
      if (fresh.type === "agent_provision") {
        await processProvisionJob(fresh);
      } else {
        await processDeleteJob(fresh);
      }
      const after = store.getJob(job.id);
      if (after?.status === "completed") processed += 1;
      else if (after?.status === "failed") failed += 1;
    }
    const skipped = store.pendingJobCount();
    return { processed, failed, skipped };
  }

  async function cleanupStuck(): Promise<{ failed: number }> {
    const cutoff = new Date(now().getTime() - stuckProvisioningMs);
    const stuck = store.stuckProvisioningSandboxes(cutoff);
    let failed = 0;
    for (const sandbox of stuck) {
      store.updateSandbox(sandbox.id, {
        status: "error",
        errorReason: "stuck in provisioning past cutoff",
      });
      // Fail any pending/in-progress jobs that target this sandbox.
      for (const job of store.allJobs()) {
        if (
          job.sandboxId === sandbox.id &&
          (job.status === "pending" || job.status === "in_progress")
        ) {
          store.updateJob(job.id, {
            status: "failed",
            errorReason: "sandbox stuck in provisioning",
            finishedAt: now(),
          });
        }
      }
      failed += 1;
    }
    return { failed };
  }

  return { app, store, tick, processDbBackedJobs, cleanupStuck };
}
