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
} as const;

export type ProvisioningJobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
