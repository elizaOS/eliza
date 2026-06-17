export const JOB_TYPES = {
  AGENT_PROVISION: "agent_provision",
  AGENT_DELETE: "agent_delete",
  AGENT_SUSPEND: "agent_suspend",
  AGENT_RESUME: "agent_resume",
  AGENT_RESTART: "agent_restart",
  AGENT_LOGS: "agent_logs",
  /**
   * Patron chat turn: forward a `message.send` to a running agent's bridge
   * from the daemon (which, unlike the CF edge worker, can reach the
   * container's raw bridge port). Used by the synchronous patron chat proxy
   * at /api/v1/agents/:id/message: the route enqueues this job, triggers the
   * daemon immediately, then polls the job row for the reply.
   */
  AGENT_MESSAGE: "agent_message",
  AGENT_SNAPSHOT: "agent_snapshot",
  /**
   * Fleet-upgrade: blue/green swap an agent onto the currently-deployed
   * image. Enqueued by the reconciler when the registry digest of the
   * configured tag has moved and the agent is still on the old digest.
   */
  AGENT_UPGRADE: "agent_upgrade",
  /**
   * Sleep: durably back the agent's full state up to object storage, then
   * stop AND remove the container so the compute slot is freed (the node
   * autoscaler reclaims a now-empty Hetzner box). Distinct from
   * `agent_suspend`, which keeps the container + node slot for a fast
   * `docker start`. Sleep is cold storage: compute cost goes to zero.
   */
  AGENT_SLEEP: "agent_sleep",
  /**
   * Wake: provision a fresh container (claiming a warm-pool slot when one is
   * available) and restore the agent's state from its latest backup. The
   * inverse of `agent_sleep`.
   */
  AGENT_WAKE: "agent_wake",

  // ── Apps lane (Product 2) ──────────────────────────────────────────────
  // Generic, image-agnostic container lifecycle for user-deployed apps —
  // distinct from the AGENT_* lane above. These rows target the `containers`
  // table (not `agent_sandboxes`), carry NO eliza scaffolding, and NEVER
  // receive the shared agent DATABASE_URL. The daemon picks them up via the
  // same `Object.values(JOB_TYPES)` scan, so registering them here is enough;
  // executors are added separately and never alter the AGENT_* arms.
  /** Provision a generic app container from a caller-supplied image. */
  CONTAINER_PROVISION: "container_provision",
  /** Stop + remove an app container and free its slot. */
  CONTAINER_DELETE: "container_delete",
  /** Restart an app container in place. */
  CONTAINER_RESTART: "container_restart",
  /** Re-deploy an app container onto a new image. */
  CONTAINER_UPGRADE: "container_upgrade",
  /** Fetch recent logs from an app container. */
  CONTAINER_LOGS: "container_logs",
  /**
   * Run the full app deploy on a node host (Apps / Product 2): the cloud-api
   * Worker enqueues this (pg-free) and the provisioning-worker daemon claims it,
   * runs the node AppDeployRunner (ensure tenant DB -> create container row with
   * the per-tenant DSN -> enqueue CONTAINER_PROVISION -> link), keeping all
   * `pg`/SSH off the workerd request path.
   */
  APP_DEPLOY: "app_deploy",
  /**
   * Tear down an app's ISOLATED per-tenant DB (Apps / Product 2): DROP DATABASE
   * + DROP ROLE and release the cluster slot. The Worker delete path enqueues
   * this (pg-free, carrying the app's encrypted DSN) and the provisioning-worker
   * daemon claims it and runs the real DROP node-side — because `pg` and the
   * cluster admin DSN only exist on the daemon. Without it, a deleted isolated
   * app strands a live DB we keep paying for and burns a finite slot (#8342).
   */
  APP_DB_DEPROVISION: "app_db_deprovision",
} as const;

export type ProvisioningJobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

// ── Lanes (which daemon claims which jobs) ──────────────────────────────────
// The one `jobs` table + ProvisioningJobService codepath is shared, but the
// rows split into two INDEPENDENT lanes that can be claimed by SEPARATE daemons:
//
//   - `agent` — the AGENT_* sandbox lifecycle (Product 1). Owned by the
//     control-plane provisioning-worker, which ALSO holds the agent-fleet
//     singletons (liveness heartbeat, fleet upgrade, node autoscale, warm pool).
//   - `apps`  — the CONTAINER_* / APP_* lifecycle (Product 2). Provisioning a
//     per-tenant DB needs `pg` reach to the PRIVATE tenant Postgres, and running
//     untrusted user containers wants isolation from the agent control plane.
//     Owned by a dedicated apps-control daemon that lives ON the apps private
//     network (so it can reach the tenant DB) and runs NONE of the agent
//     singletons — so it can never race/duplicate the live fleet.
//
// A daemon scopes itself with `PROVISIONING_JOB_LANES` (comma list). Unset → ALL
// types (the historical single-daemon behavior), so this split is INERT until a
// second daemon is actually deployed and each side is pinned to its lane.
export const AGENT_JOB_TYPES = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_DELETE,
  JOB_TYPES.AGENT_SUSPEND,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_LOGS,
  JOB_TYPES.AGENT_MESSAGE,
  JOB_TYPES.AGENT_SNAPSHOT,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_SLEEP,
  JOB_TYPES.AGENT_WAKE,
] as const satisfies readonly ProvisioningJobType[];

export const APPS_JOB_TYPES = [
  JOB_TYPES.CONTAINER_PROVISION,
  JOB_TYPES.CONTAINER_DELETE,
  JOB_TYPES.CONTAINER_RESTART,
  JOB_TYPES.CONTAINER_UPGRADE,
  JOB_TYPES.CONTAINER_LOGS,
  JOB_TYPES.APP_DEPLOY,
  JOB_TYPES.APP_DB_DEPROVISION,
] as const satisfies readonly ProvisioningJobType[];

export const JOB_LANES = {
  agent: AGENT_JOB_TYPES,
  apps: APPS_JOB_TYPES,
} as const;

export type JobLane = keyof typeof JOB_LANES;

/**
 * Resolve the job types a daemon should claim from a `PROVISIONING_JOB_LANES`
 * spec (comma-separated `agent`/`apps`, case-insensitive).
 *
 * Fail-OPEN to the historical all-types behavior in every ambiguous case:
 *   - empty / undefined  → ALL types (one daemon does both lanes);
 *   - no recognized lane → ALL types (never silently claim nothing).
 * Unknown lane tokens are ignored. The returned list preserves `JOB_TYPES`
 * order so logs/iteration are stable.
 */
export function resolveJobTypesForLanes(spec: string | undefined | null): ProvisioningJobType[] {
  const all = Object.values(JOB_TYPES);
  if (!spec || !spec.trim()) return all;
  const wanted = new Set<ProvisioningJobType>();
  let matchedAnyLane = false;
  for (const raw of spec.split(",")) {
    const lane = raw.trim().toLowerCase();
    if (lane in JOB_LANES) {
      matchedAnyLane = true;
      for (const t of JOB_LANES[lane as JobLane]) wanted.add(t);
    }
  }
  if (!matchedAnyLane) return all;
  return all.filter((t) => wanted.has(t));
}
