/** Provider JobState values; do not collapse unknown states into success or running. */
export const VERTEX_TUNING_JOB_STATES = [
  "JOB_STATE_UNSPECIFIED",
  "JOB_STATE_QUEUED",
  "JOB_STATE_PENDING",
  "JOB_STATE_RUNNING",
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLING",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_PAUSED",
  "JOB_STATE_EXPIRED",
  "JOB_STATE_UPDATING",
  "JOB_STATE_PARTIALLY_SUCCEEDED",
] as const;
export type VertexTuningJobState = (typeof VERTEX_TUNING_JOB_STATES)[number];
