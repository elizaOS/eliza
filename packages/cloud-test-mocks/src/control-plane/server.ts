import { type Context, Hono } from "hono";
import { ControlPlaneStore, type Job, type Sandbox } from "./store";

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
  tick: () => Promise<{ processed: number; failed: number }>;
  cleanupStuck: () => Promise<{ failed: number }>;
} {
  const token = options.token ?? process.env.CONTAINER_CONTROL_PLANE_TOKEN ?? "test-token";
  const hetznerToken = options.hetznerToken ?? process.env.HCLOUD_TOKEN ?? "test-token";
  const hetznerUrl = options.hetznerUrl.replace(/\/$/, "");
  const now = options.now ?? (() => new Date());
  const store = options.store ?? new ControlPlaneStore(now);
  const actionPollTimeoutMs = options.hetznerActionPollTimeoutMs ?? 5000;
  const stuckProvisioningMs = options.stuckProvisioningMs ?? 10 * 60 * 1000;

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7).trim() !== token) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    await next();
  });

  function requireForwardedAuth(c: Context): { userId: string; organizationId: string } | Response {
    const userId = c.req.header("x-eliza-user-id")?.trim();
    const organizationId = c.req.header("x-eliza-organization-id")?.trim();
    if (!userId || !organizationId) {
      return c.json({ success: false, error: "Missing forwarded user or organization headers" }, 400);
    }
    return { userId, organizationId };
  }

  app.get("/health", (c) => c.json({ success: true, service: "control-plane-mock" }));

  app.post("/jobs", async (c) => {
    const auth = requireForwardedAuth(c);
    if (auth instanceof Response) return auth;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ success: false, error: "JSON body required" }, 400);

    const type = body.type === "agent_delete" ? "agent_delete" : "agent_provision";

    let sandboxId = typeof body.sandbox_id === "string" ? body.sandbox_id : undefined;
    if (type === "agent_provision") {
      if (!sandboxId) {
        const sandbox = store.createSandbox({
          organizationId: auth.organizationId,
          userId: auth.userId,
          agentId: typeof body.agent_id === "string" ? body.agent_id : undefined,
        });
        sandboxId = sandbox.id;
      }
    } else {
      if (!sandboxId) {
        return c.json({ success: false, error: "sandbox_id required for agent_delete" }, 400);
      }
      const sandbox = store.getSandbox(sandboxId);
      if (!sandbox) return c.json({ success: false, error: "sandbox not found" }, 404);
      store.updateSandbox(sandboxId, { status: "deletion_pending" });
    }

    const job = store.createJob({
      type,
      sandboxId,
      organizationId: auth.organizationId,
      userId: auth.userId,
      payload: (body.payload as Record<string, unknown> | undefined) ?? {},
    });

    return c.json({ success: true, data: { job, sandbox: store.getSandbox(sandboxId) } }, 201);
  });

  app.get("/jobs/:id", (c) => {
    const job = store.getJob(c.req.param("id"));
    if (!job) return c.json({ success: false, error: "job not found" }, 404);
    return c.json({ success: true, data: job });
  });

  app.get("/sandboxes/:id", (c) => {
    const sandbox = store.getSandbox(c.req.param("id"));
    if (!sandbox) return c.json({ success: false, error: "sandbox not found" }, 404);
    return c.json({ success: true, data: sandbox });
  });

  app.post("/cron/process-provisioning-jobs", async (c) => {
    const result = await tick();
    return c.json({ success: true, data: result });
  });

  app.post("/cron/cleanup-stuck-provisioning", async (c) => {
    const result = await cleanupStuck();
    return c.json({ success: true, data: result });
  });

  async function hetznerFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${hetznerUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${hetznerToken}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  async function pollHetznerAction(actionId: number): Promise<"success" | "error" | "timeout"> {
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
        labels: { sandbox_id: sandbox.id, organization_id: sandbox.organizationId },
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      failJobAndSandbox(job, sandbox, `hetzner create failed: ${createRes.status} ${text}`, "error");
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
      const deleteRes = await hetznerFetch(`/servers/${sandbox.hetznerServerId}`, {
        method: "DELETE",
      });
      // 404 = already gone; treated as success per docker-error-classifier (PR #7746).
      if (!deleteRes.ok && deleteRes.status !== 404) {
        const text = await deleteRes.text().catch(() => "");
        failDeleteJob(job, sandbox, `hetzner delete failed: ${deleteRes.status} ${text}`);
        return;
      }
      if (deleteRes.ok) {
        const body = (await deleteRes.json().catch(() => null)) as HetznerActionResponse | null;
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
    store.updateSandbox(sandbox.id, { status: sandboxStatus, errorReason: reason });
    store.updateJob(job.id, { status: "failed", errorReason: reason, finishedAt: now() });
  }

  function failDeleteJob(job: Job, sandbox: Sandbox, reason: string): void {
    store.updateSandbox(sandbox.id, { status: "deletion_failed", errorReason: reason });
    store.updateJob(job.id, { status: "failed", errorReason: reason, finishedAt: now() });
  }

  async function tick(): Promise<{ processed: number; failed: number }> {
    const pending = store.pendingJobs();
    let processed = 0;
    let failed = 0;
    for (const job of pending) {
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
    return { processed, failed };
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
        if (job.sandboxId === sandbox.id && (job.status === "pending" || job.status === "in_progress")) {
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

  return { app, store, tick, cleanupStuck };
}
