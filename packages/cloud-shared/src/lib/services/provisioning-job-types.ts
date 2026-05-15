export const JOB_TYPES = {
  AGENT_PROVISION: "agent_provision",
} as const;

export type ProvisioningJobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
