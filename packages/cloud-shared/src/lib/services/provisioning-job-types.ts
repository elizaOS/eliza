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
  /**
   * Stop a container's live runtime when billing is suspended, WITHOUT
   * deleting its row or volume (#8342). The container-billing cron runs on the
   * Worker (no SSH) and can't `docker stop` the node-side container, which runs
   * `--restart unless-stopped` and would otherwise keep running for free after
   * billing stops. The Worker enqueues this; the daemon runs the real stop via
   * HetznerContainersClient (preserving the volume) and frees the node slot.
   */
  CONTAINER_STOP: "container_stop",
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
