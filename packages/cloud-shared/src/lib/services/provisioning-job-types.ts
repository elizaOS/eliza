export const JOB_TYPES = {
  AGENT_PROVISION: "agent_provision",
  AGENT_DELETE: "agent_delete",
  AGENT_SUSPEND: "agent_suspend",
  AGENT_RESUME: "agent_resume",
} as const;

export type ProvisioningJobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
