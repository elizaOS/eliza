/**
 * Turns one compact objective into a durable, restart-safe organization backed by existing ACP tasks.
 *
 * The service owns planning and reconciliation. The core aggregate owns authority
 * and work state, while OrchestratorTaskService remains the only owner of coding
 * task and ACP session lifecycle.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, ModelType, Service } from "@elizaos/core";
import type {
  AgentOrganizationRecord,
  OrganizationCommand,
  OrganizationPrincipalId,
  OrganizationStore,
} from "@elizaos/core/contracts/agent-organization";
import {
  delegatedOrganizationAuthorizer,
  toOrganizationCommandId,
  toOrganizationId,
  toOrganizationPrincipalId,
  toOrganizationTimestamp,
} from "@elizaos/core/contracts/agent-organization";
import { AcpService } from "./acp-service.js";
import { parseJsonObjectResponse } from "./json-model-output.js";
import type { TaskThreadDetailDto } from "./orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "./orchestrator-task-service.js";
import { FileOrganizationStore } from "./organization-file-store.js";

export const AUTONOMOUS_ORGANIZATION_SERVICE_TYPE =
  "AUTONOMOUS_ORGANIZATION_SERVICE";

/** Requires explicit host approval before organizations may start or resume coding workers. */
export function autonomousOrganizationsEnabled(
  runtime: IAgentRuntime,
): boolean {
  const value = runtime.getSetting("ELIZA_ENABLE_AUTONOMOUS_ORGANIZATIONS");
  return value === true || value === "true" || value === "1";
}

export interface OrganizationWorkerCandidate {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  framework?: string;
}

export interface OrganizationPlan {
  name: string;
  selectedMembers: Array<{
    candidateId: string;
    role: string;
  }>;
  workItems: Array<{
    id: string;
    objective: string;
    assigneeCandidateId: string;
    dependsOnWorkItemIds: string[];
  }>;
}

export interface OrganizationPlanner {
  plan(input: {
    objective: string;
    candidates: readonly OrganizationWorkerCandidate[];
  }): Promise<OrganizationPlan>;
  recover(input: {
    objective: string;
    failedWorkItem: {
      id: string;
      objective: string;
      assigneeMemberId: string;
      error: string;
    };
    candidates: readonly OrganizationWorkerCandidate[];
  }): Promise<{ candidateId: string; reason: string }>;
}

export type OrganizationWorkerExecutionStatus =
  | { kind: "running" }
  | { kind: "completed"; result: string }
  | { kind: "failed"; error: string };

export interface OrganizationWorkerHost {
  ensureWorker(input: {
    organizationId: string;
    workItemId: string;
    objective: string;
    member: OrganizationWorkerCandidate;
    dependencyResults: string[];
  }): Promise<{ executionId: string }>;
  status(executionId: string): Promise<OrganizationWorkerExecutionStatus>;
}

export interface StartAutonomousOrganizationInput {
  requestId: string;
  sponsorPrincipalId: string;
  objective: string;
  candidates?: readonly OrganizationWorkerCandidate[];
}

export interface AutonomousOrganizationServiceOptions {
  store?: OrganizationStore;
  planner?: OrganizationPlanner;
  workerHost?: OrganizationWorkerHost;
  candidates?: () => Promise<readonly OrganizationWorkerCandidate[]>;
  now?: () => Date;
}

function requiredText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new ElizaError(`Autonomous organization ${field} is required`, {
      code: "ORGANIZATION_AUTONOMY_INVALID_INPUT",
      context: { field },
    });
  }
  return normalized;
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${prefix}-${digest.slice(0, 24)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ElizaError(`Organization plan ${field} must be an array`, {
      code: "ORGANIZATION_PLAN_INVALID",
    });
  }
  return value.map((item, index) => requiredText(item, `${field}.${index}`));
}

export function parseOrganizationPlan(
  value: unknown,
  candidates: readonly OrganizationWorkerCandidate[],
): OrganizationPlan {
  if (
    !isRecord(value) ||
    !Array.isArray(value.selectedMembers) ||
    !Array.isArray(value.workItems)
  ) {
    throw new ElizaError("Organization planner returned an invalid object", {
      code: "ORGANIZATION_PLAN_INVALID",
    });
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const selectedMembers = value.selectedMembers.map((item, index) => {
    if (!isRecord(item)) {
      throw new ElizaError("Organization plan member is invalid", {
        code: "ORGANIZATION_PLAN_INVALID",
        context: { index },
      });
    }
    const candidateId = requiredText(
      item.candidateId,
      `selectedMembers.${index}.candidateId`,
    );
    if (!candidateIds.has(candidateId)) {
      throw new ElizaError(
        "Organization plan selected an unavailable candidate",
        {
          code: "ORGANIZATION_PLAN_CANDIDATE_UNAVAILABLE",
          context: { candidateId },
        },
      );
    }
    return {
      candidateId,
      role: requiredText(item.role, `selectedMembers.${index}.role`),
    };
  });
  const selectedIds = new Set(
    selectedMembers.map((member) => member.candidateId),
  );
  if (selectedIds.size === 0 || selectedIds.size !== selectedMembers.length) {
    throw new ElizaError("Organization plan must select unique members", {
      code: "ORGANIZATION_PLAN_INVALID",
    });
  }
  const workItems = value.workItems.map((item, index) => {
    if (!isRecord(item)) {
      throw new ElizaError("Organization plan work item is invalid", {
        code: "ORGANIZATION_PLAN_INVALID",
        context: { index },
      });
    }
    const assigneeCandidateId = requiredText(
      item.assigneeCandidateId,
      `workItems.${index}.assigneeCandidateId`,
    );
    if (!selectedIds.has(assigneeCandidateId)) {
      throw new ElizaError(
        "Organization plan assigned work to an unselected candidate",
        {
          code: "ORGANIZATION_PLAN_INVALID",
          context: { assigneeCandidateId },
        },
      );
    }
    return {
      id: requiredText(item.id, `workItems.${index}.id`),
      objective: requiredText(item.objective, `workItems.${index}.objective`),
      assigneeCandidateId,
      dependsOnWorkItemIds: parseStringList(
        item.dependsOnWorkItemIds,
        `workItems.${index}.dependsOnWorkItemIds`,
      ),
    };
  });
  const workIds = new Set(workItems.map((item) => item.id));
  if (workIds.size === 0 || workIds.size !== workItems.length) {
    throw new ElizaError("Organization plan must contain unique work items", {
      code: "ORGANIZATION_PLAN_INVALID",
    });
  }
  for (const item of workItems) {
    if (
      item.dependsOnWorkItemIds.some((id) => !workIds.has(id) || id === item.id)
    ) {
      throw new ElizaError("Organization plan contains an invalid dependency", {
        code: "ORGANIZATION_PLAN_INVALID",
        context: { workItemId: item.id },
      });
    }
  }
  return {
    name: requiredText(value.name, "name"),
    selectedMembers,
    workItems,
  };
}

class RuntimeOrganizationPlanner implements OrganizationPlanner {
  constructor(private readonly runtime: IAgentRuntime) {}

  async plan(input: {
    objective: string;
    candidates: readonly OrganizationWorkerCandidate[];
  }): Promise<OrganizationPlan> {
    const prompt = [
      "Create a small autonomous team plan for the objective.",
      "Select only useful candidates. Return one JSON object and no prose.",
      'Shape: {"name":string,"selectedMembers":[{"candidateId":string,"role":string}],"workItems":[{"id":string,"objective":string,"assigneeCandidateId":string,"dependsOnWorkItemIds":string[]}]}',
      "Every work item must have one selected assignee. Dependencies must reference work item ids.",
      `Objective:\n${input.objective}`,
      `Candidates:\n${JSON.stringify(input.candidates)}`,
    ].join("\n\n");
    const raw = await this.runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const parsed = parseJsonObjectResponse<unknown>(String(raw));
    if (!parsed) {
      throw new ElizaError("Organization planner returned no JSON object", {
        code: "ORGANIZATION_PLAN_INVALID",
      });
    }
    return parseOrganizationPlan(parsed, input.candidates);
  }

  async recover(input: {
    objective: string;
    failedWorkItem: {
      id: string;
      objective: string;
      assigneeMemberId: string;
      error: string;
    };
    candidates: readonly OrganizationWorkerCandidate[];
  }): Promise<{ candidateId: string; reason: string }> {
    const prompt = [
      "Choose the best available worker to retry failed organization work.",
      "Return one JSON object and no prose.",
      'Shape: {"candidateId":string,"reason":string}',
      `Organization objective:\n${input.objective}`,
      `Failed work:\n${JSON.stringify(input.failedWorkItem)}`,
      `Candidates:\n${JSON.stringify(input.candidates)}`,
    ].join("\n\n");
    const raw = await this.runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const parsed = parseJsonObjectResponse<unknown>(String(raw));
    if (!isRecord(parsed)) {
      throw new ElizaError(
        "Organization recovery planner returned no JSON object",
        {
          code: "ORGANIZATION_PLAN_INVALID",
        },
      );
    }
    const candidateId = requiredText(
      parsed.candidateId,
      "recovery.candidateId",
    );
    if (!input.candidates.some((candidate) => candidate.id === candidateId)) {
      throw new ElizaError(
        "Organization recovery selected an unavailable candidate",
        {
          code: "ORGANIZATION_PLAN_CANDIDATE_UNAVAILABLE",
          context: { candidateId },
        },
      );
    }
    return {
      candidateId,
      reason: requiredText(parsed.reason, "recovery.reason"),
    };
  }
}

function organizationStateRoot(runtime: IAgentRuntime): string {
  const configured =
    process.env.ELIZA_ACP_STATE_DIR ??
    runtime.getSetting?.("ELIZA_ACP_STATE_DIR");
  const base =
    typeof configured === "string" && configured.trim()
      ? configured.trim()
      : join(homedir(), ".eliza", "plugin-acp");
  return join(base, "organizations", runtime.agentId);
}

function metadataText(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Builds the complete worker request, including every accepted dependency result without compaction. */
export function buildOrganizationWorkerPrompt(input: {
  objective: string;
  dependencyResults: readonly string[];
}): string {
  if (input.dependencyResults.length === 0) return input.objective;
  return [
    input.objective,
    "",
    "Complete results from prerequisite work, in dependency order:",
    JSON.stringify(input.dependencyResults),
  ].join("\n");
}

/** Selects the elected completion coordinator's exact session output. */
export function authoritativeOrganizationResult(input: {
  completionCoordinatorSessionId?: string | null;
  sessions: ReadonlyArray<{
    sessionId: string;
    completionSummary?: string | null;
  }>;
}): string | undefined {
  if (!input.completionCoordinatorSessionId) return undefined;
  const result = input.sessions.find(
    (session) => session.sessionId === input.completionCoordinatorSessionId,
  )?.completionSummary;
  return result?.trim() ? result : undefined;
}

class AcpOrganizationWorkerHost implements OrganizationWorkerHost {
  constructor(private readonly taskService: OrchestratorTaskService) {}

  private async findTask(
    organizationId: string,
    workItemId: string,
    memberId: string,
  ): Promise<TaskThreadDetailDto | null> {
    for (const task of await this.taskService.listTasks({
      includeArchived: true,
    })) {
      const detail = await this.taskService.getTask(task.id);
      if (
        detail &&
        metadataText(detail.metadata, "organizationId") === organizationId &&
        metadataText(detail.metadata, "organizationWorkItemId") ===
          workItemId &&
        metadataText(detail.metadata, "organizationMemberId") === memberId
      ) {
        if (["failed", "interrupted", "archived"].includes(detail.status)) {
          continue;
        }
        return detail;
      }
    }
    return null;
  }

  async ensureWorker(input: {
    organizationId: string;
    workItemId: string;
    objective: string;
    member: OrganizationWorkerCandidate;
    dependencyResults: string[];
  }): Promise<{ executionId: string }> {
    const workerPrompt = buildOrganizationWorkerPrompt(input);
    const existing = await this.findTask(
      input.organizationId,
      input.workItemId,
      input.member.id,
    );
    if (existing) {
      if (
        existing.sessions.length === 0 &&
        !["done", "failed"].includes(existing.status)
      ) {
        await this.taskService.spawnAgentForTask(existing.id, {
          framework: input.member.framework,
          label: input.member.name,
          task: workerPrompt,
        });
      }
      return { executionId: existing.id };
    }
    const detail = await this.taskService.createTask({
      title: `${input.member.name}: ${input.objective}`,
      goal: input.objective,
      originalRequest: input.objective,
      kind: "organization-work",
      acceptanceCriteria: [
        "Return a concrete result for the assigned objective.",
      ],
      metadata: {
        organizationId: input.organizationId,
        organizationWorkItemId: input.workItemId,
        organizationMemberId: input.member.id,
        dependencyResults: input.dependencyResults,
      },
    });
    await this.taskService.spawnAgentForTask(detail.id, {
      framework: input.member.framework,
      label: input.member.name,
      task: workerPrompt,
    });
    return { executionId: detail.id };
  }

  async status(
    executionId: string,
  ): Promise<OrganizationWorkerExecutionStatus> {
    const detail = await this.taskService.getTask(executionId);
    if (!detail) return { kind: "failed", error: "Worker task disappeared" };
    if (detail.status === "done") {
      const result = authoritativeOrganizationResult(detail);
      if (!result) {
        return {
          kind: "failed",
          error:
            "Worker task completed without an authoritative coordinator result",
        };
      }
      return { kind: "completed", result };
    }
    if (["failed", "interrupted", "archived"].includes(detail.status)) {
      return { kind: "failed", error: detail.summary ?? "Worker task failed" };
    }
    return { kind: "running" };
  }
}

export class AutonomousOrganizationService extends Service {
  static override serviceType = AUTONOMOUS_ORGANIZATION_SERVICE_TYPE;
  override capabilityDescription =
    "Creates durable agent organizations from compact objectives and reconciles their ACP-backed work after restart";

  private readonly store: OrganizationStore;
  private readonly planner: OrganizationPlanner;
  private readonly workerHost: OrganizationWorkerHost;
  private readonly candidateSource: () => Promise<
    readonly OrganizationWorkerCandidate[]
  >;
  private readonly now: () => Date;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileInFlight = false;
  private reconcileScan: Promise<AgentOrganizationRecord[]> | null = null;
  private stopped = false;
  private readonly reconcileTails = new Map<string, Promise<void>>();

  constructor(
    runtime: IAgentRuntime,
    options: AutonomousOrganizationServiceOptions = {},
  ) {
    super(runtime);
    this.store =
      options.store ??
      new FileOrganizationStore(organizationStateRoot(runtime), {
        authorize: delegatedOrganizationAuthorizer,
      });
    this.planner = options.planner ?? new RuntimeOrganizationPlanner(runtime);
    const taskService = runtime.getService<OrchestratorTaskService>(
      OrchestratorTaskService.serviceType,
    );
    if (options.workerHost) {
      this.workerHost = options.workerHost;
    } else if (taskService) {
      this.workerHost = new AcpOrganizationWorkerHost(taskService);
    } else {
      throw new ElizaError(
        "Autonomous organizations require the task service",
        {
          code: "ORGANIZATION_WORKER_HOST_UNAVAILABLE",
        },
      );
    }
    this.candidateSource =
      options.candidates ?? (() => this.discoverCandidates(runtime));
    this.now = options.now ?? (() => new Date());
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<AutonomousOrganizationService> {
    await runtime.getServiceLoadPromise(AcpService.serviceType);
    await runtime.getServiceLoadPromise(OrchestratorTaskService.serviceType);
    const service = new AutonomousOrganizationService(runtime);
    if (!autonomousOrganizationsEnabled(runtime)) return service;
    await service.resumeAll();
    service.scheduleReconcile();
    return service;
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    await this.reconcileScan;
    await Promise.all(this.reconcileTails.values());
  }

  private scheduleReconcile(): void {
    if (this.stopped || this.reconcileTimer) return;
    const raw = this.runtime.getSetting?.(
      "ELIZA_ORGANIZATION_RECONCILE_INTERVAL_MS",
    );
    const parsed = typeof raw === "string" ? Number(raw) : Number.NaN;
    const intervalMs =
      Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 15_000;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (this.stopped || this.reconcileInFlight) {
        this.scheduleReconcile();
        return;
      }
      this.reconcileInFlight = true;
      this.reconcileScan = this.resumeAll();
      void this.reconcileScan
        .catch((error) => {
          // error-policy:J7 the periodic reconciler reports its failure and retries on the next bounded tick.
          this.runtime.reportError?.("AutonomousOrganization.reconcile", error);
        })
        .finally(() => {
          this.reconcileScan = null;
          this.reconcileInFlight = false;
          this.scheduleReconcile();
        });
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  async resumeAll(): Promise<AgentOrganizationRecord[]> {
    if (this.stopped) return [];
    const resumed: AgentOrganizationRecord[] = [];
    for (const record of await this.store.list()) {
      if (record.organization.status === "completed") {
        resumed.push(record);
        continue;
      }
      try {
        resumed.push(await this.reconcile(record.organization.id));
      } catch (error) {
        // error-policy:J7 one bad organization is reported without blocking independent organizations.
        this.runtime.reportError?.("AutonomousOrganization.resume", error, {
          organizationId: record.organization.id,
        });
        resumed.push(record);
      }
    }
    return resumed;
  }

  private async discoverCandidates(
    runtime: IAgentRuntime,
  ): Promise<readonly OrganizationWorkerCandidate[]> {
    const acp = runtime.getService<AcpService>(AcpService.serviceType);
    if (!acp) return [];
    const available = await acp.getAvailableAgents();
    return available
      .filter((candidate) => candidate.installed)
      .map((candidate) => ({
        id: candidate.agentType,
        name: candidate.agentType,
        role: "autonomous coding specialist",
        capabilities: [
          "software implementation",
          "technical analysis",
          "testing",
          "code review",
        ],
        framework: candidate.agentType,
      }));
  }

  private timestamp(): ReturnType<typeof toOrganizationTimestamp> {
    return toOrganizationTimestamp(this.now().toISOString());
  }

  private async command(
    record: AgentOrganizationRecord,
    actorPrincipalId: OrganizationPrincipalId,
    commandId: string,
    command: OrganizationCommand,
  ): Promise<AgentOrganizationRecord> {
    return (
      await this.store.apply({
        organizationId: record.organization.id,
        commandId: toOrganizationCommandId(commandId),
        expectedRevision: record.revision,
        actorPrincipalId,
        issuedAt: this.timestamp(),
        command,
      })
    ).record;
  }

  private async ensurePlan(
    record: AgentOrganizationRecord,
    candidates: readonly OrganizationWorkerCandidate[],
  ): Promise<AgentOrganizationRecord> {
    if (record.organization.workItems.length > 0) return record;
    if (candidates.length === 0) {
      throw new ElizaError("No organization workers are available", {
        code: "ORGANIZATION_CANDIDATES_UNAVAILABLE",
      });
    }
    const plan = await this.planner.plan({
      objective: record.organization.goal,
      candidates,
    });
    const byId = new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    );
    const coordinatorPrincipal = toOrganizationPrincipalId(
      stableId("principal", record.organization.id, "coordinator"),
    );
    const members = [
      {
        id: "coordinator",
        principalId: coordinatorPrincipal,
        name: this.runtime.character?.name ?? "Coordinator",
        role: "organization coordinator",
        capabilities: ["planning", "delegation", "reconciliation"],
        authority: "coordinate" as const,
      },
      ...plan.selectedMembers.map((selection) => {
        const candidate = byId.get(selection.candidateId);
        if (!candidate) {
          throw new ElizaError("Organization plan candidate disappeared", {
            code: "ORGANIZATION_PLAN_CANDIDATE_UNAVAILABLE",
          });
        }
        return {
          id: candidate.id,
          principalId: toOrganizationPrincipalId(
            stableId("principal", record.organization.id, candidate.id),
          ),
          name: candidate.name,
          role: selection.role,
          capabilities: candidate.capabilities,
          authority: "contribute" as const,
        };
      }),
    ];
    try {
      return await this.command(
        record,
        record.organization.sponsorPrincipalId,
        stableId("command", record.organization.id, "adopt-plan"),
        {
          type: "adopt_plan",
          members,
          workItems: plan.workItems.map((item) => ({
            id: item.id,
            objective: item.objective,
            assigneeMemberId: item.assigneeCandidateId,
            dependsOnWorkItemIds: item.dependsOnWorkItemIds,
          })),
        },
      );
    } catch (error) {
      const current = await this.store.get(record.organization.id);
      if (current?.organization.workItems.length) return current;
      throw error;
    }
  }

  async startOrganization(
    input: StartAutonomousOrganizationInput,
  ): Promise<AgentOrganizationRecord> {
    if (this.stopped) {
      throw new ElizaError("Autonomous organization service is stopped", {
        code: "ORGANIZATION_SERVICE_STOPPED",
      });
    }
    const requestId = requiredText(input.requestId, "requestId");
    const objective = requiredText(input.objective, "objective");
    const sponsorPrincipalId = toOrganizationPrincipalId(
      requiredText(input.sponsorPrincipalId, "sponsorPrincipalId"),
    );
    const organizationId = toOrganizationId(stableId("org", requestId));
    let record = await this.store.get(organizationId);
    if (
      record &&
      (record.organization.sponsorPrincipalId !== sponsorPrincipalId ||
        record.organization.goal !== objective)
    ) {
      throw new ElizaError(
        "Organization request id was reused with different authority or objective",
        {
          code: "ORGANIZATION_REQUEST_ID_COLLISION",
          context: { organizationId, requestId },
          severity: "fatal",
        },
      );
    }
    if (!record) {
      try {
        record = (
          await this.store.apply({
            organizationId,
            commandId: toOrganizationCommandId(
              stableId("command", requestId, "create"),
            ),
            expectedRevision: 0,
            actorPrincipalId: sponsorPrincipalId,
            issuedAt: this.timestamp(),
            command: {
              type: "create_organization",
              name: `Organization ${organizationId.slice(-8)}`,
              goal: objective,
            },
          })
        ).record;
      } catch (error) {
        record = await this.store.get(organizationId);
        if (!record) throw error;
      }
    }
    if (
      record.organization.sponsorPrincipalId !== sponsorPrincipalId ||
      record.organization.goal !== objective
    ) {
      throw new ElizaError(
        "Organization request id was reused with different authority or objective",
        {
          code: "ORGANIZATION_REQUEST_ID_COLLISION",
          context: { organizationId, requestId },
          severity: "fatal",
        },
      );
    }
    return this.reconcile(record.organization.id, input.candidates);
  }

  async reconcile(
    organizationId: ReturnType<typeof toOrganizationId>,
    suppliedCandidates?: readonly OrganizationWorkerCandidate[],
  ): Promise<AgentOrganizationRecord> {
    if (this.stopped) {
      throw new ElizaError("Autonomous organization service is stopped", {
        code: "ORGANIZATION_SERVICE_STOPPED",
      });
    }
    const previous =
      this.reconcileTails.get(organizationId) ?? Promise.resolve();
    const operation = previous.then(() =>
      this.reconcileUnlocked(organizationId, suppliedCandidates),
    );
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.reconcileTails.set(organizationId, tail);
    try {
      return await operation;
    } finally {
      if (this.reconcileTails.get(organizationId) === tail) {
        this.reconcileTails.delete(organizationId);
      }
    }
  }

  private async reconcileUnlocked(
    organizationId: ReturnType<typeof toOrganizationId>,
    suppliedCandidates?: readonly OrganizationWorkerCandidate[],
  ): Promise<AgentOrganizationRecord> {
    let record = await this.store.get(organizationId);
    if (!record) {
      throw new ElizaError("Organization does not exist", {
        code: "ORGANIZATION_NOT_FOUND",
      });
    }
    if (record.organization.status === "completed") return record;
    const candidates = [
      ...(suppliedCandidates ?? (await this.candidateSource())),
    ];
    record = await this.ensurePlan(record, candidates);
    const byId = new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    );
    const coordinator = record.organization.members.find(
      (member) => member.authority === "coordinate",
    );
    if (!coordinator) {
      throw new ElizaError("Organization has no coordinator", {
        code: "ORGANIZATION_COORDINATOR_MISSING",
      });
    }

    for (const snapshot of record.organization.workItems) {
      const workItem = record.organization.workItems.find(
        (item) => item.id === snapshot.id,
      );
      if (!workItem || workItem.status === "completed") continue;
      if (workItem.executionId) {
        if (workItem.status === "assigned") {
          const member = record.organization.members.find(
            (candidate) => candidate.id === workItem.assigneeMemberId,
          );
          if (!member) {
            throw new ElizaError("Organization work member disappeared", {
              code: "ORGANIZATION_MEMBER_NOT_FOUND",
            });
          }
          record = await this.command(
            record,
            member.principalId,
            stableId(
              "command",
              organizationId,
              workItem.id,
              workItem.executionId,
              "in-progress",
            ),
            {
              type: "update_work_status",
              workItemId: workItem.id,
              status: "in_progress",
            },
          );
          continue;
        }
        const status = await this.workerHost.status(workItem.executionId);
        if (status.kind === "completed") {
          const member = record.organization.members.find(
            (candidate) => candidate.id === workItem.assigneeMemberId,
          );
          if (!member)
            throw new ElizaError("Organization work member disappeared", {
              code: "ORGANIZATION_MEMBER_NOT_FOUND",
            });
          record = await this.command(
            record,
            member.principalId,
            stableId(
              "command",
              organizationId,
              workItem.id,
              workItem.executionId,
              "completed",
            ),
            {
              type: "update_work_status",
              workItemId: workItem.id,
              status: "completed",
              result: status.result,
            },
          );
        } else if (status.kind === "failed") {
          const member = record.organization.members.find(
            (candidate) => candidate.id === workItem.assigneeMemberId,
          );
          if (!member)
            throw new ElizaError("Organization work member disappeared", {
              code: "ORGANIZATION_MEMBER_NOT_FOUND",
            });
          if (workItem.status !== "failed") {
            record = await this.command(
              record,
              member.principalId,
              stableId(
                "command",
                organizationId,
                workItem.id,
                workItem.executionId,
                "failed",
              ),
              {
                type: "update_work_status",
                workItemId: workItem.id,
                status: "failed",
                result: status.error,
              },
            );
          }
          const priorRecoveries = record.receipts.filter(
            (receipt) =>
              receipt.commandEnvelope.command.type === "reassign_work" &&
              receipt.commandEnvelope.command.workItemId === workItem.id,
          ).length;
          const recoveryCandidates = candidates.filter(
            (candidate) => candidate.id !== workItem.assigneeMemberId,
          );
          if (priorRecoveries < 2 && recoveryCandidates.length > 0) {
            const recovery = await this.planner.recover({
              objective: record.organization.goal,
              failedWorkItem: {
                id: workItem.id,
                objective: workItem.objective,
                assigneeMemberId: workItem.assigneeMemberId,
                error: status.error,
              },
              candidates: recoveryCandidates,
            });
            let replacement = record.organization.members.find(
              (candidate) => candidate.id === recovery.candidateId,
            );
            if (!replacement) {
              const candidate = byId.get(recovery.candidateId);
              if (!candidate) {
                throw new ElizaError(
                  "Organization recovery candidate disappeared",
                  {
                    code: "ORGANIZATION_PLAN_CANDIDATE_UNAVAILABLE",
                  },
                );
              }
              record = await this.command(
                record,
                coordinator.principalId,
                stableId(
                  "command",
                  organizationId,
                  workItem.id,
                  "add-recovery-member",
                  candidate.id,
                ),
                {
                  type: "add_member",
                  member: {
                    id: candidate.id,
                    principalId: toOrganizationPrincipalId(
                      stableId("principal", organizationId, candidate.id),
                    ),
                    name: candidate.name,
                    role: candidate.role,
                    capabilities: candidate.capabilities,
                    authority: "contribute",
                  },
                },
              );
              replacement = record.organization.members.find(
                (member) => member.id === candidate.id,
              );
            }
            if (!replacement) {
              throw new ElizaError(
                "Organization recovery member was not persisted",
                {
                  code: "ORGANIZATION_MEMBER_NOT_FOUND",
                },
              );
            }
            record = await this.command(
              record,
              coordinator.principalId,
              stableId(
                "command",
                organizationId,
                workItem.id,
                "reassign",
                String(priorRecoveries + 1),
              ),
              {
                type: "reassign_work",
                workItemId: workItem.id,
                assigneeMemberId: replacement.id,
                reason: recovery.reason,
              },
            );
          }
        }
        continue;
      }
      const currentWorkItems = record.organization.workItems;
      const dependencies = workItem.dependsOnWorkItemIds.map((id) =>
        currentWorkItems.find((item) => item.id === id),
      );
      if (dependencies.some((item) => item?.status !== "completed")) continue;
      const member = record.organization.members.find(
        (candidate) => candidate.id === workItem.assigneeMemberId,
      );
      const candidate = member ? byId.get(member.id) : undefined;
      if (!member || !candidate) {
        throw new ElizaError("Organization worker candidate is unavailable", {
          code: "ORGANIZATION_PLAN_CANDIDATE_UNAVAILABLE",
          context: { memberId: workItem.assigneeMemberId },
        });
      }
      const ensured = await this.workerHost.ensureWorker({
        organizationId,
        workItemId: workItem.id,
        objective: workItem.objective,
        member: candidate,
        dependencyResults: dependencies.flatMap((item) =>
          item?.result ? [item.result] : [],
        ),
      });
      record = await this.command(
        record,
        coordinator.principalId,
        stableId(
          "command",
          organizationId,
          workItem.id,
          "bind",
          ensured.executionId,
        ),
        {
          type: "bind_work_execution",
          workItemId: workItem.id,
          executionId: ensured.executionId,
        },
      );
      record = await this.command(
        record,
        member.principalId,
        stableId(
          "command",
          organizationId,
          workItem.id,
          ensured.executionId,
          "in-progress",
        ),
        {
          type: "update_work_status",
          workItemId: workItem.id,
          status: "in_progress",
        },
      );
    }

    if (
      record.organization.workItems.length > 0 &&
      record.organization.workItems.every((item) => item.status === "completed")
    ) {
      record = await this.command(
        record,
        coordinator.principalId,
        stableId("command", organizationId, "complete"),
        { type: "complete_organization" },
      );
    }
    return record;
  }
}
