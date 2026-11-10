/** Immutable authority of one claimed durable job execution. */
export interface JobExecutionAuthority {
  readonly jobId: string;
  readonly organizationId: string;
  readonly executionGeneration: string;
  readonly executionOwnerId: string;
}

export class StaleJobExecutionError extends Error {
  constructor(jobId: string) {
    super(`Job execution generation is no longer current: ${jobId}`);
    this.name = "StaleJobExecutionError";
  }
}
