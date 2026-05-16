/**
 * In-memory state for the control-plane mock.
 *
 * Mirrors the real `agent_sandboxes` + `jobs` tables in `@elizaos/cloud-shared`
 * just enough for tests that exercise the cloud-api → control-plane integration.
 *
 * Status models match PR #7746 + cloud-shared schemas:
 *   sandbox.status: provisioning → running → stopped | error
 *                                ↳ deletion_pending → deleted | deletion_failed
 *   job.status:     pending → in_progress → completed | failed
 *   job.type:       agent_provision | agent_delete
 */

export type SandboxStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "error"
  | "deletion_pending"
  | "deleted"
  | "deletion_failed";

export interface Sandbox {
  id: string;
  organizationId: string;
  userId: string;
  agentId?: string;
  status: SandboxStatus;
  hetznerServerId: number | null;
  errorReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type JobStatus = "pending" | "in_progress" | "completed" | "failed";
export type JobType = "agent_provision" | "agent_delete";

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  sandboxId: string;
  organizationId: string;
  userId: string;
  payload: Record<string, unknown>;
  errorReason?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export class ControlPlaneStore {
  private readonly jobs = new Map<string, Job>();
  private readonly sandboxes = new Map<string, Sandbox>();
  private idSeq = 0;

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  now(): Date {
    return this.nowFn();
  }

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}-${this.idSeq.toString().padStart(6, "0")}`;
  }

  createSandbox(input: {
    organizationId: string;
    userId: string;
    agentId?: string;
  }): Sandbox {
    const now = this.now();
    const sandbox: Sandbox = {
      id: this.nextId("sbx"),
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      status: "provisioning",
      hetznerServerId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  getSandbox(id: string): Sandbox | undefined {
    return this.sandboxes.get(id);
  }

  updateSandbox(id: string, patch: Partial<Sandbox>): Sandbox {
    const existing = this.sandboxes.get(id);
    if (!existing) throw new Error(`sandbox '${id}' not found`);
    const next: Sandbox = { ...existing, ...patch, id, updatedAt: this.now() };
    this.sandboxes.set(id, next);
    return next;
  }

  createJob(input: {
    type: JobType;
    sandboxId: string;
    organizationId: string;
    userId: string;
    payload?: Record<string, unknown>;
  }): Job {
    const now = this.now();
    const job: Job = {
      id: this.nextId("job"),
      type: input.type,
      status: "pending",
      sandboxId: input.sandboxId,
      organizationId: input.organizationId,
      userId: input.userId,
      payload: input.payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, patch: Partial<Job>): Job {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`job '${id}' not found`);
    const next: Job = { ...existing, ...patch, id, updatedAt: this.now() };
    this.jobs.set(id, next);
    return next;
  }

  /** Pending jobs in FIFO order. */
  pendingJobs(): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.status === "pending")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Sandboxes still in `provisioning` whose `createdAt` is older than the cutoff. */
  stuckProvisioningSandboxes(cutoff: Date): Sandbox[] {
    return [...this.sandboxes.values()].filter(
      (s) => s.status === "provisioning" && s.createdAt.getTime() < cutoff.getTime(),
    );
  }

  allSandboxes(): Sandbox[] {
    return [...this.sandboxes.values()];
  }

  allJobs(): Job[] {
    return [...this.jobs.values()];
  }
}
