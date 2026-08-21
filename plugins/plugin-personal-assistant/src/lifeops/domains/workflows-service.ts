/**
 * Workflows domain for LifeOps: CRUD and execution of owner workflow definitions
 * — multi-step automations whose steps resolve through the workflow-step
 * registry and whose cron/relative schedules compute the next run instant. Runs
 * and audit events are persisted for owner review.
 */
import { computeNextCronRunAtMs } from "@elizaos/agent";
import type {
  CreateLifeOpsWorkflowRequest,
  LifeOpsAuditEvent,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventEndedFilters,
  LifeOpsEventKind,
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRecord,
  LifeOpsWorkflowRun,
  LifeOpsWorkflowSchedule,
  UpdateLifeOpsWorkflowRequest,
} from "../../contracts/index.js";
import { LIFEOPS_WORKFLOW_STATUSES } from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type AnyWorkflowStepContribution,
  getWorkflowStepRegistry,
  UnknownWorkflowStepError,
  type WorkflowStepExecuteArgs,
  type WorkflowStepExecuteContext,
} from "../registries/workflow-step-registry.js";
import { resolveNextRelativeScheduleInstant } from "../relative-schedule-resolver.js";
import {
  createLifeOpsWorkflowDefinition,
  createLifeOpsWorkflowRun,
  type LifeOpsScheduleMergedStateRecord,
} from "../repository.js";
import { parseWorkflowSchedulerState } from "../service-helpers-browser.js";
import {
  isRecord,
  normalizeOptionalRecord,
  requireRecord,
} from "../service-helpers-misc.js";
import {
  fail,
  normalizeEnumValue,
  normalizeIsoString,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireNonEmptyString,
} from "../service-normalize.js";
import {
  normalizeWorkflowPermissionPolicy,
  normalizeWorkflowSchedule,
  normalizeWorkflowTriggerType,
} from "../service-normalize-connector.js";
import { normalizeWorkflowActionPlan } from "../service-normalize-task.js";
import type {
  ExecuteWorkflowResult,
  LifeOpsWorkflowSchedulerState,
} from "../service-types.js";
import {
  LifeOpsServiceError,
  LifeOpsWorkflowRunFailedUncompensatedError,
} from "../service-types.js";
import { addMinutes } from "../time.js";

type LifeOpsWorkflowEvent = {
  id: string;
  kind: LifeOpsEventKind;
  occurredAt: string;
  confidence: number;
  payload: Record<string, unknown>;
};

type WorkflowEventSchedule = Extract<
  LifeOpsWorkflowSchedule,
  { kind: "event" }
>;

function readFailedCompensationKinds(
  run: LifeOpsWorkflowRun,
): readonly string[] {
  if (!isRecord(run.result) || !Array.isArray(run.result.compensations)) {
    return [];
  }
  return run.result.compensations.flatMap((entry) =>
    isRecord(entry) &&
    entry.status === "compensation_failed" &&
    typeof entry.kind === "string"
      ? [entry.kind]
      : [],
  );
}

function readRecordedWorkflowFailure(run: LifeOpsWorkflowRun): Error {
  if (isRecord(run.result) && Array.isArray(run.result.steps)) {
    for (const entry of [...run.result.steps].reverse()) {
      if (isRecord(entry) && typeof entry.error === "string") {
        return new Error(entry.error);
      }
    }
  }
  return new Error(`workflow run ${run.id} previously failed`);
}

/**
 * Cross-domain and base helpers the workflows domain depends on.
 * `recordWorkflowAudit` and `getWorkflowDefinition` live on the base
 * (`LifeOpsServiceBase`); `readEffectiveScheduleState` and
 * `emitWorkflowRunNudge` live on the reminders domain. None is part of
 * {@link LifeOpsContext}, so they are injected as typed callbacks.
 *
 * `workflowStepContext` is the fully composed service instance handed to
 * registered workflow-step contributions during execution — those steps reach
 * across many domains (calendar, gmail, browser, definitions), so the context
 * must be the composed instance, not this sub-service.
 */
export type WorkflowsDeps = {
  recordWorkflowAudit(
    eventType: "workflow_created" | "workflow_updated" | "workflow_run",
    ownerId: string,
    actor: "user" | "workflow",
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<LifeOpsAuditEvent>;
  getWorkflowDefinition(workflowId: string): Promise<LifeOpsWorkflowDefinition>;
  readEffectiveScheduleState(args?: {
    timezone?: string | null;
    now?: Date;
  }): Promise<LifeOpsScheduleMergedStateRecord | null>;
  emitWorkflowRunNudge(
    workflow: LifeOpsWorkflowDefinition,
    run: LifeOpsWorkflowRun,
  ): Promise<void>;
  workflowStepContext: WorkflowStepExecuteContext;
};

export function matchesCalendarEventEndedFilters(
  event: LifeOpsCalendarEvent,
  filters: LifeOpsCalendarEventEndedFilters | undefined,
): boolean {
  if (!filters) return true;
  if (
    filters.calendarIds &&
    filters.calendarIds.length > 0 &&
    !filters.calendarIds.includes(event.calendarId)
  ) {
    return false;
  }
  if (filters.titleIncludesAny && filters.titleIncludesAny.length > 0) {
    const title = event.title.toLowerCase();
    if (
      !filters.titleIncludesAny.some((needle) =>
        title.includes(needle.toLowerCase()),
      )
    ) {
      return false;
    }
  }
  if (typeof filters.minDurationMinutes === "number") {
    const durationMinutes =
      (Date.parse(event.endAt) - Date.parse(event.startAt)) / 60_000;
    if (
      !Number.isFinite(durationMinutes) ||
      durationMinutes < filters.minDurationMinutes
    ) {
      return false;
    }
  }
  if (
    filters.attendeeEmailIncludesAny &&
    filters.attendeeEmailIncludesAny.length > 0
  ) {
    const attendees = Array.isArray(event.attendees) ? event.attendees : [];
    const emails = attendees
      .map((attendee) =>
        attendee && typeof attendee === "object" && "email" in attendee
          ? String((attendee as { email?: unknown }).email ?? "").toLowerCase()
          : "",
      )
      .filter(Boolean);
    if (
      !filters.attendeeEmailIncludesAny.some((needle) =>
        emails.some((email) => email.includes(needle.toLowerCase())),
      )
    ) {
      return false;
    }
  }
  return true;
}

function matchesLifeOpsDerivedEventFilters(
  event: LifeOpsWorkflowEvent,
  filters: unknown,
  nowIso: string,
): boolean {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    return true;
  }
  const record = filters as Record<string, unknown>;
  if (
    typeof record.minConfidence === "number" &&
    event.confidence < record.minConfidence
  ) {
    return false;
  }
  if (typeof record.offsetMinutes === "number") {
    const dueAtMs =
      Date.parse(event.occurredAt) + record.offsetMinutes * 60_000;
    if (Date.parse(nowIso) < dueAtMs) {
      return false;
    }
  }
  if (
    event.kind === "lifeops.bedtime.imminent" &&
    typeof record.minutesBefore === "number"
  ) {
    const payloadMinutes = event.payload.minutesUntilBedtimeTarget;
    if (
      typeof payloadMinutes !== "number" ||
      payloadMinutes > record.minutesBefore
    ) {
      return false;
    }
  }
  if (
    event.kind === "lifeops.regularity.changed" &&
    typeof record.becomes === "string"
  ) {
    // The event fires on any class transition; the filter narrows to the
    // specific target class. The target class lands in the payload via the
    // merged state's regularity block.
    const payload = event.payload;
    const regularity =
      typeof payload === "object" && payload !== null
        ? (payload as { regularityClass?: unknown }).regularityClass
        : undefined;
    if (regularity !== record.becomes) {
      return false;
    }
  }
  if (
    event.kind === "gmail.message.received" ||
    event.kind === "gmail.thread.needs_response"
  ) {
    const payload = isRecord(event.payload) ? event.payload : {};
    const grantId = typeof payload.grantId === "string" ? payload.grantId : "";
    if (
      Array.isArray(record.grantIds) &&
      record.grantIds.length > 0 &&
      !record.grantIds.includes(grantId)
    ) {
      return false;
    }
    if (
      Array.isArray(record.fromIncludesAny) &&
      record.fromIncludesAny.length > 0
    ) {
      const sender =
        `${String(payload.from ?? "")} ${String(payload.fromEmail ?? "")}`.toLowerCase();
      if (
        !record.fromIncludesAny.some((needle) =>
          sender.includes(String(needle).toLowerCase()),
        )
      ) {
        return false;
      }
    }
    if (
      Array.isArray(record.subjectIncludesAny) &&
      record.subjectIncludesAny.length > 0
    ) {
      const subject = String(payload.subject ?? "").toLowerCase();
      if (
        !record.subjectIncludesAny.some((needle) =>
          subject.includes(String(needle).toLowerCase()),
        )
      ) {
        return false;
      }
    }
    if (Array.isArray(record.labelIds) && record.labelIds.length > 0) {
      const labels = new Set(
        Array.isArray(payload.labels)
          ? payload.labels.map((label) => String(label))
          : [],
      );
      if (!record.labelIds.some((labelId) => labels.has(String(labelId)))) {
        return false;
      }
    }
    if (
      typeof record.requiresReplyNeeded === "boolean" &&
      Boolean(payload.likelyReplyNeeded) !== record.requiresReplyNeeded
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Workflow domain: definition CRUD, scheduler-state bookkeeping, and the
 * scheduled / event-triggered run loops (`runDueWorkflows`,
 * `runDueEventWorkflows`) consumed by the reminders scheduler. Base helpers
 * (`recordWorkflowAudit`, `getWorkflowDefinition`), reminders helpers
 * (`readEffectiveScheduleState`, `emitWorkflowRunNudge`), and the composed
 * workflow-step execution context are injected via {@link WorkflowsDeps}.
 */
export class WorkflowsDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: WorkflowsDeps,
  ) {}

  readWorkflowSchedulerState(
    workflow: LifeOpsWorkflowDefinition,
  ): LifeOpsWorkflowSchedulerState | null {
    return parseWorkflowSchedulerState(
      isRecord(workflow.metadata) ? workflow.metadata.lifeopsScheduler : null,
    );
  }

  computeWorkflowNextDueAt(
    workflow: LifeOpsWorkflowDefinition,
    cursorIso?: string | null,
  ): string | null {
    if (workflow.triggerType !== "schedule") {
      return null;
    }
    const schedule = workflow.schedule;
    if (
      schedule.kind === "manual" ||
      schedule.kind === "event" ||
      schedule.kind === "relative_to_wake" ||
      schedule.kind === "relative_to_bedtime" ||
      schedule.kind === "during_morning" ||
      schedule.kind === "during_night"
    ) {
      return null;
    }
    if (schedule.kind === "once") {
      return cursorIso ? null : schedule.runAt;
    }
    if (schedule.kind === "interval") {
      const baseIso = cursorIso ?? workflow.createdAt;
      return addMinutes(new Date(baseIso), schedule.everyMinutes).toISOString();
    }
    const baseMs = cursorIso
      ? Date.parse(cursorIso)
      : Date.parse(workflow.createdAt) - 60_000;
    const nextRunMs = computeNextCronRunAtMs(
      schedule.cronExpression,
      baseMs,
      schedule.timezone,
    );
    return nextRunMs === null ? null : new Date(nextRunMs).toISOString();
  }

  withWorkflowSchedulerState(
    workflow: LifeOpsWorkflowDefinition,
    state: LifeOpsWorkflowSchedulerState | null,
  ): LifeOpsWorkflowDefinition {
    const metadata = { ...workflow.metadata };
    if (state) {
      metadata.lifeopsScheduler = state;
    } else {
      delete metadata.lifeopsScheduler;
    }
    return {
      ...workflow,
      metadata,
      updatedAt: new Date().toISOString(),
    };
  }

  initializeWorkflowSchedulerState(
    workflow: LifeOpsWorkflowDefinition,
  ): LifeOpsWorkflowDefinition {
    const currentState = this.readWorkflowSchedulerState(workflow);
    const targetState = this.buildInitialSchedulerState(workflow);
    if (
      (currentState === null && targetState === null) ||
      (currentState &&
        targetState &&
        currentState.nextDueAt === targetState.nextDueAt &&
        currentState.lastDueAt === targetState.lastDueAt &&
        currentState.lastRunId === targetState.lastRunId &&
        currentState.lastRunStatus === targetState.lastRunStatus &&
        (currentState.lastFiredEventEndAt ?? null) ===
          (targetState.lastFiredEventEndAt ?? null) &&
        (currentState.lastFiredEventId ?? null) ===
          (targetState.lastFiredEventId ?? null))
    ) {
      return workflow;
    }
    return this.withWorkflowSchedulerState(workflow, targetState);
  }

  buildInitialSchedulerState(
    workflow: LifeOpsWorkflowDefinition,
  ): LifeOpsWorkflowSchedulerState | null {
    if (workflow.triggerType === "manual") {
      return null;
    }
    if (workflow.triggerType === "event") {
      // Anchor the cursor at workflow creation so we never fire for events
      // that ended before the workflow existed.
      return {
        managedBy: "task_worker",
        nextDueAt: null,
        lastDueAt: null,
        lastRunId: null,
        lastRunStatus: null,
        updatedAt: new Date().toISOString(),
        lastFiredEventEndAt: workflow.createdAt,
        lastFiredEventId: null,
      };
    }
    if (workflow.schedule.kind === "manual") {
      return null;
    }
    return {
      managedBy: "task_worker",
      nextDueAt: this.computeWorkflowNextDueAt(workflow),
      lastDueAt: null,
      lastRunId: null,
      lastRunStatus: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async runDueWorkflows(args: {
    now: string;
    limit: number;
  }): Promise<LifeOpsWorkflowRun[]> {
    const nowMs = Date.parse(args.now);
    const workflows = await this.ctx.repository.listWorkflows(
      this.ctx.agentId(),
    );
    const runs: LifeOpsWorkflowRun[] = [];

    for (const workflow of workflows) {
      if (runs.length >= args.limit) {
        break;
      }
      if (
        workflow.status !== "active" ||
        workflow.triggerType !== "schedule" ||
        workflow.schedule.kind === "manual"
      ) {
        continue;
      }

      let nextWorkflow = workflow;
      const existingSchedulerState =
        this.readWorkflowSchedulerState(nextWorkflow);
      let schedulerState =
        existingSchedulerState ??
        ({
          managedBy: "task_worker",
          nextDueAt: this.computeWorkflowNextDueAt(nextWorkflow),
          lastDueAt: null,
          lastRunId: null,
          lastRunStatus: null,
          updatedAt: new Date().toISOString(),
        } satisfies LifeOpsWorkflowSchedulerState);
      let stateChanged = existingSchedulerState === null;
      if (
        schedulerState.nextDueAt === null &&
        (nextWorkflow.schedule.kind === "relative_to_wake" ||
          nextWorkflow.schedule.kind === "relative_to_bedtime" ||
          nextWorkflow.schedule.kind === "during_morning" ||
          nextWorkflow.schedule.kind === "during_night")
      ) {
        const effectiveSchedule = await this.deps.readEffectiveScheduleState({
          timezone: nextWorkflow.schedule.timezone,
          now: new Date(args.now),
        });
        schedulerState = {
          ...schedulerState,
          nextDueAt: resolveNextRelativeScheduleInstant({
            schedule: nextWorkflow.schedule,
            state: effectiveSchedule,
            cursorIso: schedulerState.lastDueAt,
            nowMs: Date.parse(args.now),
          }),
          updatedAt: new Date().toISOString(),
        };
        stateChanged = true;
      }

      while (
        runs.length < args.limit &&
        schedulerState.nextDueAt &&
        Date.parse(schedulerState.nextDueAt) <= nowMs
      ) {
        const dueAt = schedulerState.nextDueAt;
        const { run, error, disposition } =
          await this.executeWorkflowDefinition(nextWorkflow, {
            startedAt: dueAt,
            confirmBrowserActions: false,
            request: {
              scheduledExecution: true,
            },
            idempotencyKey: `schedule:${nextWorkflow.id}:${dueAt}`,
          });
        if (disposition === "in_progress") {
          // A claim that never completed is unrecoverable without operator
          // action: the partial unique index means this (agent, workflow, key)
          // can never be claimed again, so this workflow's cursor stops
          // advancing permanently. reportError is the designated signal for
          // that — it reaches RECENT_ERRORS and owner escalation, where a warn
          // re-logged on every scheduler tick reaches nobody.
          this.ctx.runtime.reportError(
            "workflow_scheduled_execution",
            new LifeOpsServiceError(
              409,
              `workflow run ${run.id} holds an uncompleted running claim; the scheduler cursor cannot advance until it is released`,
              "WORKFLOW_RUN_CLAIM_WEDGED",
            ),
            {
              workflowId: nextWorkflow.id,
              workflowRunId: run.id,
              dueAt,
            },
          );
          break;
        }
        runs.push(run);
        await this.deps.emitWorkflowRunNudge(nextWorkflow, run);
        const nextDueAt =
          nextWorkflow.schedule.kind === "relative_to_wake" ||
          nextWorkflow.schedule.kind === "relative_to_bedtime" ||
          nextWorkflow.schedule.kind === "during_morning" ||
          nextWorkflow.schedule.kind === "during_night"
            ? resolveNextRelativeScheduleInstant({
                schedule: nextWorkflow.schedule,
                state: await this.deps.readEffectiveScheduleState({
                  timezone: nextWorkflow.schedule.timezone,
                  now: new Date(args.now),
                }),
                cursorIso: dueAt,
                nowMs: Date.parse(args.now),
              })
            : this.computeWorkflowNextDueAt(nextWorkflow, dueAt);
        schedulerState = {
          managedBy: "task_worker",
          nextDueAt,
          lastDueAt: dueAt,
          lastRunId: run.id,
          lastRunStatus: run.status,
          updatedAt: new Date().toISOString(),
        };
        stateChanged = true;

        if (error) {
          this.ctx.logLifeOpsError("workflow_scheduled_execution", error, {
            workflowId: nextWorkflow.id,
            workflowRunId: run.id,
            dueAt,
          });
        }
      }

      if (stateChanged) {
        nextWorkflow = this.withWorkflowSchedulerState(
          nextWorkflow,
          schedulerState,
        );
        await this.ctx.repository.updateWorkflow(nextWorkflow);
      }
    }

    return runs;
  }

  /**
   * Fires event-triggered workflows for calendar events that have ended since
   * the workflow's cursor. Uses a (end_at, id) tuple cursor per workflow so
   * repeated invocations never re-fire for the same event.
   */
  async runDueEventWorkflows(args: {
    now: string;
    limit: number;
    lifeOpsEvents?: LifeOpsWorkflowEvent[];
  }): Promise<LifeOpsWorkflowRun[]> {
    const workflows = await this.ctx.repository.listWorkflows(
      this.ctx.agentId(),
    );
    const runs: LifeOpsWorkflowRun[] = [];

    for (const workflow of workflows) {
      if (runs.length >= args.limit) {
        break;
      }
      if (
        workflow.status !== "active" ||
        workflow.triggerType !== "event" ||
        workflow.schedule.kind !== "event"
      ) {
        continue;
      }
      const eventSchedule = workflow.schedule as WorkflowEventSchedule;
      let nextWorkflow = workflow;
      const existingState = this.readWorkflowSchedulerState(nextWorkflow);
      let schedulerState: LifeOpsWorkflowSchedulerState = existingState ?? {
        managedBy: "task_worker",
        nextDueAt: null,
        lastDueAt: null,
        lastRunId: null,
        lastRunStatus: null,
        updatedAt: new Date().toISOString(),
        lastFiredEventEndAt: nextWorkflow.createdAt,
        lastFiredEventId: null,
      };
      let stateChanged = existingState === null;

      const remaining = args.limit - runs.length;
      if (eventSchedule.eventKind === "calendar.event.ended") {
        const candidates =
          await this.ctx.repository.listCalendarEventsEndedAfterCursor({
            agentId: this.ctx.agentId(),
            provider: "google",
            side: "owner",
            cursorEndAt: schedulerState.lastFiredEventEndAt ?? null,
            cursorEventId: schedulerState.lastFiredEventId ?? null,
            upToIso: args.now,
            limit: Math.max(remaining * 4, 8),
          });

        const filters =
          eventSchedule.filters?.kind === "calendar.event.ended"
            ? eventSchedule.filters.filters
            : undefined;

        for (const event of candidates) {
          if (runs.length >= args.limit) {
            break;
          }
          if (!matchesCalendarEventEndedFilters(event, filters)) {
            schedulerState = {
              ...schedulerState,
              lastFiredEventEndAt: event.endAt,
              lastFiredEventId: event.id,
              updatedAt: new Date().toISOString(),
            };
            stateChanged = true;
            continue;
          }
          const { run, error, disposition } =
            await this.executeWorkflowDefinition(nextWorkflow, {
              startedAt: event.endAt,
              confirmBrowserActions: false,
              request: {
                scheduledExecution: false,
                event: {
                  kind: "calendar.event.ended",
                  eventId: event.id,
                  calendarId: event.calendarId,
                  title: event.title,
                  startAt: event.startAt,
                  endAt: event.endAt,
                  htmlLink: event.htmlLink,
                },
              },
              idempotencyKey: `event:${nextWorkflow.id}:${event.id}:${event.endAt}`,
            });
          if (disposition === "in_progress") {
            // Same unrecoverable shape as the scheduled path above: the claim
            // can never be re-taken, so this workflow stops advancing until an
            // operator releases it.
            this.ctx.runtime.reportError(
              "workflow_event_execution",
              new LifeOpsServiceError(
                409,
                `workflow run ${run.id} holds an uncompleted running claim; the event cursor cannot advance until it is released`,
                "WORKFLOW_RUN_CLAIM_WEDGED",
              ),
              {
                workflowId: nextWorkflow.id,
                workflowRunId: run.id,
                eventId: event.id,
                eventEndAt: event.endAt,
              },
            );
            break;
          }
          runs.push(run);
          await this.deps.emitWorkflowRunNudge(nextWorkflow, run);
          schedulerState = {
            ...schedulerState,
            lastDueAt: event.endAt,
            lastRunId: run.id,
            lastRunStatus: run.status,
            lastFiredEventEndAt: event.endAt,
            lastFiredEventId: event.id,
            updatedAt: new Date().toISOString(),
          };
          stateChanged = true;

          if (error) {
            this.ctx.logLifeOpsError("workflow_event_execution", error, {
              workflowId: nextWorkflow.id,
              workflowRunId: run.id,
              eventId: event.id,
              eventEndAt: event.endAt,
            });
          }
        }
      } else {
        const candidates = (args.lifeOpsEvents ?? [])
          .filter((event) => event.kind === eventSchedule.eventKind)
          .filter((event) => {
            if (!schedulerState.lastFiredEventEndAt) {
              return true;
            }
            if (event.occurredAt > schedulerState.lastFiredEventEndAt) {
              return true;
            }
            return (
              event.occurredAt === schedulerState.lastFiredEventEndAt &&
              event.id !== schedulerState.lastFiredEventId
            );
          })
          .slice(0, Math.max(remaining * 4, 8));

        const filters =
          eventSchedule.filters?.kind === eventSchedule.eventKind
            ? eventSchedule.filters.filters
            : undefined;

        for (const event of candidates) {
          if (runs.length >= args.limit) {
            break;
          }
          if (!matchesLifeOpsDerivedEventFilters(event, filters, args.now)) {
            schedulerState = {
              ...schedulerState,
              updatedAt: new Date().toISOString(),
            };
            stateChanged = true;
            continue;
          }
          const { run, error, disposition } =
            await this.executeWorkflowDefinition(nextWorkflow, {
              startedAt: event.occurredAt,
              confirmBrowserActions: false,
              request: {
                scheduledExecution: false,
                event: {
                  kind: event.kind,
                  eventId: event.id,
                  occurredAt: event.occurredAt,
                  confidence: event.confidence,
                  payload: event.payload,
                },
              },
              idempotencyKey: `event:${nextWorkflow.id}:${event.id}:${event.occurredAt}`,
            });
          if (disposition === "in_progress") {
            // Same unrecoverable shape as the scheduled path above: the claim
            // can never be re-taken, so this workflow stops advancing until an
            // operator releases it.
            this.ctx.runtime.reportError(
              "workflow_event_execution",
              new LifeOpsServiceError(
                409,
                `workflow run ${run.id} holds an uncompleted running claim; the event cursor cannot advance until it is released`,
                "WORKFLOW_RUN_CLAIM_WEDGED",
              ),
              {
                workflowId: nextWorkflow.id,
                workflowRunId: run.id,
                eventId: event.id,
                eventEndAt: event.occurredAt,
              },
            );
            break;
          }
          runs.push(run);
          await this.deps.emitWorkflowRunNudge(nextWorkflow, run);
          schedulerState = {
            ...schedulerState,
            lastDueAt: event.occurredAt,
            lastRunId: run.id,
            lastRunStatus: run.status,
            lastFiredEventEndAt: event.occurredAt,
            lastFiredEventId: event.id,
            updatedAt: new Date().toISOString(),
          };
          stateChanged = true;

          if (error) {
            this.ctx.logLifeOpsError("workflow_event_execution", error, {
              workflowId: nextWorkflow.id,
              workflowRunId: run.id,
              eventId: event.id,
              eventEndAt: event.occurredAt,
            });
          }
        }
      }

      if (stateChanged) {
        nextWorkflow = this.withWorkflowSchedulerState(
          nextWorkflow,
          schedulerState,
        );
        await this.ctx.repository.updateWorkflow(nextWorkflow);
      }
    }

    return runs;
  }

  async listWorkflows(): Promise<LifeOpsWorkflowRecord[]> {
    const workflows = await this.ctx.repository.listWorkflows(
      this.ctx.agentId(),
    );
    const records: LifeOpsWorkflowRecord[] = [];
    for (const definition of workflows) {
      records.push({
        definition,
        runs: await this.ctx.repository.listWorkflowRuns(
          this.ctx.agentId(),
          definition.id,
        ),
      });
    }
    return records;
  }

  async getWorkflow(workflowId: string): Promise<LifeOpsWorkflowRecord> {
    const definition = await this.deps.getWorkflowDefinition(workflowId);
    return {
      definition,
      runs: await this.ctx.repository.listWorkflowRuns(
        this.ctx.agentId(),
        workflowId,
      ),
    };
  }

  async createWorkflow(
    request: CreateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord> {
    const triggerType = normalizeWorkflowTriggerType(request.triggerType);
    const ownership = this.ctx.normalizeOwnership(request.ownership);
    let definition = createLifeOpsWorkflowDefinition({
      agentId: this.ctx.agentId(),
      ...ownership,
      title: requireNonEmptyString(request.title, "title"),
      triggerType,
      schedule: normalizeWorkflowSchedule(request.schedule, triggerType),
      actionPlan: normalizeWorkflowActionPlan(request.actionPlan),
      permissionPolicy: normalizeWorkflowPermissionPolicy(
        request.permissionPolicy,
      ),
      status:
        request.status === undefined
          ? "active"
          : normalizeEnumValue(
              request.status,
              "status",
              LIFEOPS_WORKFLOW_STATUSES,
            ),
      createdBy:
        request.createdBy === undefined
          ? "user"
          : normalizeEnumValue(request.createdBy, "createdBy", [
              "agent",
              "user",
              "workflow",
              "connector",
            ] as const),
      metadata: normalizeOptionalRecord(request.metadata, "metadata") ?? {},
    });
    definition = this.initializeWorkflowSchedulerState(definition);
    await this.ctx.repository.createWorkflow(definition);
    await this.deps.recordWorkflowAudit(
      "workflow_created",
      definition.id,
      "user",
      "workflow created",
      { request },
      {
        triggerType: definition.triggerType,
        status: definition.status,
      },
    );
    return {
      definition,
      runs: [],
    };
  }

  async updateWorkflow(
    workflowId: string,
    request: UpdateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord> {
    const current = await this.deps.getWorkflowDefinition(workflowId);
    const ownership = this.ctx.normalizeOwnership(request.ownership, current);
    const nextTriggerType =
      request.triggerType === undefined
        ? current.triggerType
        : normalizeWorkflowTriggerType(request.triggerType);
    let nextDefinition: LifeOpsWorkflowDefinition = {
      ...current,
      ...ownership,
      title:
        request.title === undefined
          ? current.title
          : requireNonEmptyString(request.title, "title"),
      triggerType: nextTriggerType,
      schedule:
        request.schedule === undefined
          ? current.schedule
          : normalizeWorkflowSchedule(request.schedule, nextTriggerType),
      actionPlan:
        request.actionPlan === undefined
          ? current.actionPlan
          : normalizeWorkflowActionPlan(request.actionPlan),
      permissionPolicy: normalizeWorkflowPermissionPolicy(
        request.permissionPolicy,
        current.permissionPolicy,
      ),
      status:
        request.status === undefined
          ? current.status
          : normalizeEnumValue(
              request.status,
              "status",
              LIFEOPS_WORKFLOW_STATUSES,
            ),
      metadata:
        request.metadata === undefined
          ? current.metadata
          : {
              ...current.metadata,
              ...requireRecord(request.metadata, "metadata"),
            },
      updatedAt: new Date().toISOString(),
    };
    if (
      request.triggerType !== undefined ||
      request.schedule !== undefined ||
      this.readWorkflowSchedulerState(nextDefinition) === null
    ) {
      nextDefinition = this.initializeWorkflowSchedulerState(nextDefinition);
    }
    await this.ctx.repository.updateWorkflow(nextDefinition);
    await this.deps.recordWorkflowAudit(
      "workflow_updated",
      nextDefinition.id,
      "user",
      "workflow updated",
      { request },
      {
        triggerType: nextDefinition.triggerType,
        status: nextDefinition.status,
      },
    );
    return this.getWorkflow(nextDefinition.id);
  }

  /**
   * Runs for the same agent and workflow definition are serialized through
   * this promise chain so scheduled, event-triggered, and manual executions
   * within this runtime process never interleave their step side effects.
   * The durable run claim below provides the corresponding cross-process
   * fence for keyed executions.
   */
  private readonly executionChains = new Map<string, Promise<unknown>>();

  async executeWorkflowDefinition(
    definition: LifeOpsWorkflowDefinition,
    args: {
      startedAt: string;
      confirmBrowserActions: boolean;
      request: Record<string, unknown>;
      /**
       * Replay guard. A keyed run is reserved durably before its first step,
       * then completed in place. This prevents another process from starting
       * the same keyed execution and makes replay an indexed point lookup.
       * It does not make external side effects transactional: a crash can
       * leave a `running` reservation that requires operator recovery.
       */
      idempotencyKey?: string | null;
    },
  ): Promise<ExecuteWorkflowResult> {
    // Capture the agent synchronously so a mutable runtime context cannot
    // change the chain key or persistence scope after this call is queued.
    const agentId = this.ctx.agentId();
    const chainKey = JSON.stringify([agentId, definition.id]);
    const tail = this.executionChains.get(chainKey) ?? Promise.resolve();
    const execution = tail.then(
      () => this.executeWorkflowDefinitionSerialized(agentId, definition, args),
      () => this.executeWorkflowDefinitionSerialized(agentId, definition, args),
    );
    const settled = execution.then(
      () => undefined,
      () => undefined,
    );
    this.executionChains.set(chainKey, settled);
    void settled.then(() => {
      if (this.executionChains.get(chainKey) === settled) {
        this.executionChains.delete(chainKey);
      }
    });
    return execution;
  }

  private replayWorkflowRun(
    run: LifeOpsWorkflowRun,
    idempotencyKey: string,
  ): ExecuteWorkflowResult {
    if (run.status === "success") {
      return { run, error: null, disposition: "replayed" };
    }
    if (run.status === "failed_uncompensated") {
      return {
        run,
        error: new LifeOpsWorkflowRunFailedUncompensatedError(
          run,
          readFailedCompensationKinds(run),
          readRecordedWorkflowFailure(run),
          409,
        ),
        disposition: "replayed",
      };
    }
    if (run.status === "failed") {
      return {
        run,
        error: new LifeOpsServiceError(
          409,
          `workflow run ${run.id} already failed for idempotency key "${idempotencyKey}"; use a new key to re-execute`,
          "WORKFLOW_RUN_ALREADY_FAILED",
        ),
        disposition: "replayed",
      };
    }
    if (run.status === "running" || run.status === "queued") {
      return {
        run,
        error: new LifeOpsServiceError(
          409,
          `workflow run ${run.id} is already in progress for idempotency key "${idempotencyKey}"`,
          "WORKFLOW_RUN_IN_PROGRESS",
        ),
        disposition: "in_progress",
      };
    }
    return {
      run,
      error: new LifeOpsServiceError(
        409,
        `workflow run ${run.id} was cancelled for idempotency key "${idempotencyKey}"; use a new key to re-execute`,
        "WORKFLOW_RUN_CANCELLED",
      ),
      disposition: "replayed",
    };
  }

  private async persistTerminalWorkflowRun(
    run: LifeOpsWorkflowRun,
    wasClaimed: boolean,
  ): Promise<void> {
    if (!wasClaimed) {
      await this.ctx.repository.createWorkflowRun(run);
      return;
    }
    if (await this.ctx.repository.completeWorkflowRun(run)) {
      return;
    }
    const error = new LifeOpsServiceError(
      500,
      `workflow run ${run.id} could not be completed from its running claim`,
      "WORKFLOW_RUN_COMPLETION_CONFLICT",
    );
    this.ctx.runtime.reportError("workflow_run_completion", error, {
      workflowId: run.workflowId,
      workflowRunId: run.id,
      status: run.status,
    });
    throw error;
  }

  private async executeWorkflowDefinitionSerialized(
    agentId: string,
    definition: LifeOpsWorkflowDefinition,
    args: {
      startedAt: string;
      confirmBrowserActions: boolean;
      request: Record<string, unknown>;
      idempotencyKey?: string | null;
    },
  ): Promise<ExecuteWorkflowResult> {
    const idempotencyKey = args.idempotencyKey ?? null;
    const registry = getWorkflowStepRegistry(this.ctx.runtime);
    if (!registry) {
      throw new Error(
        "WorkflowStepRegistry not registered on runtime — call registerDefaultWorkflowStepPack() in plugin init",
      );
    }

    let claimedRun: LifeOpsWorkflowRun | null = null;
    if (idempotencyKey !== null) {
      claimedRun = createLifeOpsWorkflowRun({
        agentId,
        workflowId: definition.id,
        idempotencyKey,
        startedAt: args.startedAt,
        finishedAt: null,
        status: "running",
        result: { idempotencyKey, steps: [], outputs: {} },
        auditRef: null,
      });
      if (!(await this.ctx.repository.claimWorkflowRun(claimedRun))) {
        const replayed =
          await this.ctx.repository.getWorkflowRunByIdempotencyKey(
            agentId,
            definition.id,
            idempotencyKey,
          );
        if (!replayed) {
          throw new LifeOpsServiceError(
            409,
            `workflow run claim conflicted for idempotency key "${idempotencyKey}" but no claimed run was found`,
            "WORKFLOW_RUN_CLAIM_CONFLICT",
          );
        }
        return this.replayWorkflowRun(replayed, idempotencyKey);
      }
    }

    const outputs: Record<string, unknown> = {};
    const steps: Array<Record<string, unknown>> = [];
    let status: LifeOpsWorkflowRun["status"] = "success";
    const ctx = this.deps.workflowStepContext;
    // Executed steps retained for reverse-order compensation on failure.
    const executed: Array<{
      contribution: AnyWorkflowStepContribution;
      validated: { kind: string };
      value: unknown;
    }> = [];

    try {
      for (const [index, step] of definition.actionPlan.steps.entries()) {
        const contribution = registry.get(step.kind);
        if (!contribution) {
          throw new UnknownWorkflowStepError(
            step.kind,
            registry.list().map((c) => c.kind),
          );
        }
        const validated = contribution.paramSchema.parse(step);
        const stepArgs: WorkflowStepExecuteArgs = {
          definition,
          startedAt: args.startedAt,
          confirmBrowserActions: args.confirmBrowserActions,
          request: args.request,
          outputs,
          previousStepValue: steps.at(-1)?.value ?? null,
        };
        // Lineage: which upstream resultKeys were visible to this step, and
        // which registered provider produced its value.
        const inputKeys = Object.keys(outputs);
        const value = await contribution.execute(validated, stepArgs, ctx);
        const stepRecord = {
          index,
          kind: step.kind,
          provider: contribution.describe.provider,
          resultKey: step.resultKey ?? null,
          inputKeys,
          value,
        };
        if (step.resultKey) {
          outputs[step.resultKey] = value;
        }
        steps.push(stepRecord);
        executed.push({ contribution, validated, value });
      }
    } catch (error) {
      status = "failed";
      steps.push({
        error: error instanceof Error ? error.message : String(error),
      });
      const compensations: Array<Record<string, unknown>> = [];
      const failedCompensationKinds: string[] = [];
      for (const entry of executed.reverse()) {
        if (!entry.contribution.compensate) {
          continue;
        }
        try {
          await entry.contribution.compensate(
            entry.validated,
            {
              definition,
              startedAt: args.startedAt,
              request: args.request,
              executedValue: entry.value,
            },
            ctx,
          );
          compensations.push({
            kind: entry.contribution.kind,
            status: "compensated",
          });
        } catch (compensationError) {
          // error-policy:J6 compensation is best-effort teardown of earlier
          // side effects; a failure is recorded on the run and logged while
          // the remaining compensations still execute.
          compensations.push({
            kind: entry.contribution.kind,
            status: "compensation_failed",
            error:
              compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
          });
          failedCompensationKinds.push(entry.contribution.kind);
          this.ctx.runtime.reportError(
            "workflow_step_compensation",
            compensationError,
            {
              workflowId: definition.id,
              stepKind: entry.contribution.kind,
            },
          );
        }
      }
      if (failedCompensationKinds.length > 0) {
        status = "failed_uncompensated";
      }
      const audit = await this.deps.recordWorkflowAudit(
        "workflow_run",
        definition.id,
        "workflow",
        "workflow run failed",
        {
          request: args.request,
        },
        {
          status,
          steps,
          compensations,
        },
      );
      const terminalValues = {
        finishedAt: new Date().toISOString(),
        status,
        result: {
          steps,
          outputs,
          compensations,
          ...(idempotencyKey !== null ? { idempotencyKey } : {}),
        },
        auditRef: audit.id,
      } satisfies Pick<
        LifeOpsWorkflowRun,
        "finishedAt" | "status" | "result" | "auditRef"
      >;
      const run = claimedRun
        ? { ...claimedRun, ...terminalValues }
        : createLifeOpsWorkflowRun({
            agentId,
            workflowId: definition.id,
            idempotencyKey: null,
            startedAt: args.startedAt,
            ...terminalValues,
          });
      await this.persistTerminalWorkflowRun(run, claimedRun !== null);
      return {
        run,
        error:
          status === "failed_uncompensated"
            ? new LifeOpsWorkflowRunFailedUncompensatedError(
                run,
                failedCompensationKinds,
                error,
              )
            : error,
        disposition: "executed",
      };
    }

    const audit = await this.deps.recordWorkflowAudit(
      "workflow_run",
      definition.id,
      "workflow",
      "workflow run succeeded",
      {
        request: args.request,
      },
      {
        status,
        steps,
      },
    );
    const terminalValues = {
      finishedAt: new Date().toISOString(),
      status,
      result: {
        steps,
        outputs,
        ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      },
      auditRef: audit.id,
    } satisfies Pick<
      LifeOpsWorkflowRun,
      "finishedAt" | "status" | "result" | "auditRef"
    >;
    const run = claimedRun
      ? { ...claimedRun, ...terminalValues }
      : createLifeOpsWorkflowRun({
          agentId,
          workflowId: definition.id,
          idempotencyKey: null,
          startedAt: args.startedAt,
          ...terminalValues,
        });
    await this.persistTerminalWorkflowRun(run, claimedRun !== null);
    return {
      run,
      error: null,
      disposition: "executed",
    };
  }

  async runWorkflow(
    workflowId: string,
    request: {
      now?: string;
      confirmBrowserActions?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<LifeOpsWorkflowRun> {
    const definition = await this.deps.getWorkflowDefinition(workflowId);
    if (definition.status !== "active") {
      fail(409, `workflow cannot run from status ${definition.status}`);
    }
    const startedAt =
      request.now === undefined
        ? new Date().toISOString()
        : normalizeIsoString(request.now, "now");
    const confirmBrowserActions =
      normalizeOptionalBoolean(
        request.confirmBrowserActions,
        "confirmBrowserActions",
      ) ?? false;
    const idempotencyKey =
      normalizeOptionalString(request.idempotencyKey) ?? null;
    if (idempotencyKey !== null && idempotencyKey.length > 256) {
      fail(400, "idempotencyKey must be at most 256 characters");
    }
    if (idempotencyKey?.includes("\0")) {
      fail(400, "idempotencyKey must not contain NUL characters");
    }
    const result = await this.executeWorkflowDefinition(definition, {
      startedAt,
      confirmBrowserActions,
      request: request as Record<string, unknown>,
      idempotencyKey,
    });
    if (result.error instanceof LifeOpsServiceError) {
      throw result.error;
    }
    if (result.error) {
      throw result.error;
    }
    return result.run;
  }
}
