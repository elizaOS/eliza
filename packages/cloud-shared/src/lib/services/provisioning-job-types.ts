export const JOB_TYPES = {
  AGENT_PROVISION: "agent_provision",
  AGENT_DELETE: "agent_delete",
  AGENT_SUSPEND: "agent_suspend",
  AGENT_RESUME: "agent_resume",
  AGENT_RESTART: "agent_restart",
  AGENT_LOGS: "agent_logs",
  AGENT_SNAPSHOT: "agent_snapshot",
  /**
   * Fleet-upgrade: blue/green swap an agent onto the currently-deployed
   * image. Enqueued by the reconciler when the registry digest of the
   * configured tag has moved and the agent is still on the old digest.
   */
  AGENT_UPGRADE: "agent_upgrade",
} as const;

export type ProvisioningJobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
