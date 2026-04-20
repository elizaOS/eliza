// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  CreateLifeOpsWorkflowRequest,
  LifeOpsBrowserSession,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventEndedFilters,
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRecord,
  LifeOpsWorkflowRun,
  UpdateLifeOpsWorkflowRequest,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_WORKFLOW_STATUSES } from "@elizaos/shared/contracts/lifeops";
import { computeNextCronRunAtMs } from "@elizaos/agent/triggers/scheduling";
import {
  createLifeOpsWorkflowDefinition,
  createLifeOpsWorkflowRun,
} from "./repository.js";
import {
  fail,
  normalizeIsoString,
  normalizeOptionalBoolean,
  normalizeEnumValue,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeWorkflowTriggerType,
  normalizeWorkflowSchedule,
  normalizeWorkflowPermissionPolicy,
} from "./service-normalize-connector.js";
import {
  normalizeWorkflowActionPlan,
} from "./service-normalize-task.js";
import {
  isRecord,
  normalizeOptionalRecord,
  requireRecord,
} from "./service-helpers-misc.js";
import {
  summarizeWorkflowValue,
  parseWorkflowSchedulerState,
} from "./service-helpers-browser.js";
import { addMinutes } from "./time.js";
import type { LifeOpsWorkflowSchedulerState, ExecuteWorkflowResult } from "./service-types.js";
import { LifeOpsServiceError } from "./service-types.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withWorkflows<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsWorkflowsServiceMixin extends Base {
    public readWorkflowSchedulerState(
      workflow: LifeOpsWorkflowDefinition,
    ): LifeOpsWorkflowSchedulerState | null {
      return parseWorkflowSchedulerState(
        isRecord(workflow.metadata) ? workflow.metadata.lifeopsScheduler : null,
      );
    }

    public computeWorkflowNextDueAt(
      workflow: LifeOpsWorkflowDefinition,
      cursorIso?: string | null,
    ): string | null {
      if (workflow.triggerType !== "schedule") {
        return null;
      }
      const schedule = workflow.schedule;
      if (schedule.kind === "manual" || schedule.kind === "event") {
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

    public withWorkflowSchedulerState(
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

    public initializeWorkflowSchedulerState(
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

    public async runDueWorkflows(args: {
      now: string;
      limit: number;
    }): Promise<LifeOpsWorkflowRun[]> {
      const nowMs = Date.parse(args.now);
      const workflows = await this.repository.listWorkflows(this.agentId());
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

        while (
          runs.length < args.limit &&
          schedulerState.nextDueAt &&
          Date.parse(schedulerState.nextDueAt) <= nowMs
        ) {
          const dueAt = schedulerState.nextDueAt;
          const { run, error } = await this.executeWorkflowDefinition(
            nextWorkflow,
            {
              startedAt: dueAt,
              confirmBrowserActions: false,
              request: {
                scheduledExecution: true,
              },
            },
          );
          runs.push(run);
          await this.emitWorkflowRunNudge(nextWorkflow, run);
          schedulerState = {
            managedBy: "task_worker",
            nextDueAt: this.computeWorkflowNextDueAt(nextWorkflow, dueAt),
            lastDueAt: dueAt,
            lastRunId: run.id,
            lastRunStatus: run.status,
            updatedAt: new Date().toISOString(),
          };
          stateChanged = true;

          if (error) {
            this.logLifeOpsError("workflow_scheduled_execution", error, {
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
          await this.repository.updateWorkflow(nextWorkflow);
        }
      }

      return runs;
    }

    /**
     * Fires event-triggered workflows for calendar events that have ended since
     * the workflow's cursor. Uses a (end_at, id) tuple cursor per workflow so
     * repeated invocations never re-fire for the same event.
     */
    public async runDueEventWorkflows(args: {
      now: string;
      limit: number;
    }): Promise<LifeOpsWorkflowRun[]> {
      const workflows = await this.repository.listWorkflows(this.agentId());
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
        if (workflow.schedule.eventKind !== "calendar.event.ended") {
          continue;
        }

        let nextWorkflow = workflow;
        const existingState = this.readWorkflowSchedulerState(nextWorkflow);
        let schedulerState: LifeOpsWorkflowSchedulerState =
          existingState ?? {
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
        const candidates =
          await this.repository.listCalendarEventsEndedAfterCursor({
            agentId: this.agentId(),
            provider: "google",
            side: "owner",
            cursorEndAt: schedulerState.lastFiredEventEndAt ?? null,
            cursorEventId: schedulerState.lastFiredEventId ?? null,
            upToIso: args.now,
            limit: Math.max(remaining * 4, 8),
          });

        const filters =
          workflow.schedule.filters?.kind === "calendar.event.ended"
            ? workflow.schedule.filters.filters
            : undefined;

        for (const event of candidates) {
          if (runs.length >= args.limit) {
            break;
          }
          if (!matchesCalendarEventEndedFilters(event, filters)) {
            // Even when skipped we advance the cursor so the workflow never
            // re-considers this event on the next tick.
            schedulerState = {
              ...schedulerState,
              lastFiredEventEndAt: event.endAt,
              lastFiredEventId: event.id,
              updatedAt: new Date().toISOString(),
            };
            stateChanged = true;
            continue;
          }
          const { run, error } = await this.executeWorkflowDefinition(
            nextWorkflow,
            {
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
            },
          );
          runs.push(run);
          await this.emitWorkflowRunNudge(nextWorkflow, run);
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
            this.logLifeOpsError("workflow_event_execution", error, {
              workflowId: nextWorkflow.id,
              workflowRunId: run.id,
              eventId: event.id,
              eventEndAt: event.endAt,
            });
          }
        }

        if (stateChanged) {
          nextWorkflow = this.withWorkflowSchedulerState(
            nextWorkflow,
            schedulerState,
          );
          await this.repository.updateWorkflow(nextWorkflow);
        }
      }

      return runs;
    }

    async listWorkflows(): Promise<LifeOpsWorkflowRecord[]> {
      const workflows = await this.repository.listWorkflows(this.agentId());
      const records: LifeOpsWorkflowRecord[] = [];
      for (const definition of workflows) {
        records.push({
          definition,
          runs: await this.repository.listWorkflowRuns(
            this.agentId(),
            definition.id,
          ),
        });
      }
      return records;
    }

    async getWorkflow(workflowId: string): Promise<LifeOpsWorkflowRecord> {
      const definition = await this.getWorkflowDefinition(workflowId);
      return {
        definition,
        runs: await this.repository.listWorkflowRuns(this.agentId(), workflowId),
      };
    }

    async createWorkflow(
      request: CreateLifeOpsWorkflowRequest,
    ): Promise<LifeOpsWorkflowRecord> {
      const triggerType = normalizeWorkflowTriggerType(request.triggerType);
      const ownership = this.normalizeOwnership(request.ownership);
      let definition = createLifeOpsWorkflowDefinition({
        agentId: this.agentId(),
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
      await this.repository.createWorkflow(definition);
      await this.recordWorkflowAudit(
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
      const current = await this.getWorkflowDefinition(workflowId);
      const ownership = this.normalizeOwnership(request.ownership, current);
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
      await this.repository.updateWorkflow(nextDefinition);
      await this.recordWorkflowAudit(
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

    public async executeWorkflowDefinition(
      definition: LifeOpsWorkflowDefinition,
      args: {
        startedAt: string;
        confirmBrowserActions: boolean;
        request: Record<string, unknown>;
      },
    ): Promise<ExecuteWorkflowResult> {
      const internalUrl = new URL("http://127.0.0.1/");
      const outputs: Record<string, unknown> = {};
      const steps: Array<Record<string, unknown>> = [];
      let status: LifeOpsWorkflowRun["status"] = "success";

      try {
        for (const [index, step] of definition.actionPlan.steps.entries()) {
          let value: unknown;
          if (step.kind === "create_task") {
            const created = await this.createDefinition({
              ...step.request,
              ownership: step.request.ownership ?? {
                domain: definition.domain,
                subjectType: definition.subjectType,
                subjectId: definition.subjectId,
                visibilityScope: definition.visibilityScope,
                contextPolicy: definition.contextPolicy,
              },
            });
            value = {
              definitionId: created.definition.id,
              title: created.definition.title,
              reminderPlanId: created.reminderPlan?.id ?? null,
            };
          } else if (step.kind === "relock_website_access") {
            value = await this.relockWebsiteAccessGroup(
              step.request.groupKey,
              new Date(args.startedAt),
            );
          } else if (step.kind === "resolve_website_access_callback") {
            value = await this.resolveWebsiteAccessCallback(
              step.request.callbackKey,
              new Date(args.startedAt),
            );
          } else if (step.kind === "get_calendar_feed") {
            value = await this.getCalendarFeed(
              internalUrl,
              step.request ?? {},
              new Date(args.startedAt),
            );
          } else if (step.kind === "get_gmail_triage") {
            value = await this.getGmailTriage(
              internalUrl,
              step.request ?? {},
              new Date(args.startedAt),
            );
          } else if (step.kind === "summarize") {
            const sourceValue =
              (step.sourceKey ? outputs[step.sourceKey] : steps.at(-1)?.value) ??
              null;
            value = {
              text: summarizeWorkflowValue(sourceValue, step.prompt),
            };
          } else {
            if (!definition.permissionPolicy.allowBrowserActions) {
              value = {
                blocked: true,
                reason: "browser_actions_disabled",
              };
            } else {
              const session = await this.createBrowserSessionInternal({
                workflowId: definition.id,
                title: step.sessionTitle,
                actions: step.actions,
                ownership: {
                  domain: definition.domain,
                  subjectType: definition.subjectType,
                  subjectId: definition.subjectId,
                  visibilityScope: definition.visibilityScope,
                  contextPolicy: definition.contextPolicy,
                },
              });
              if (
                session.awaitingConfirmationForActionId &&
                !definition.permissionPolicy.trustedBrowserActions &&
                !args.confirmBrowserActions
              ) {
                value = {
                  sessionId: session.id,
                  status: session.status,
                  requiresConfirmation: true,
                };
              } else {
                const updated: LifeOpsBrowserSession = {
                  ...session,
                  status: "queued",
                  awaitingConfirmationForActionId: null,
                  updatedAt: new Date().toISOString(),
                };
                await this.repository.updateBrowserSession(updated);
                await this.recordBrowserAudit(
                  "browser_session_updated",
                  updated.id,
                  "browser session started",
                  {
                    workflowId: definition.id,
                  },
                  {
                    status: updated.status,
                  },
                );
                value = {
                  sessionId: updated.id,
                  status: updated.status,
                  requiresConfirmation: false,
                };
              }
            }
          }
          const stepRecord = {
            index,
            kind: step.kind,
            resultKey: step.resultKey ?? null,
            value,
          };
          if (step.resultKey) {
            outputs[step.resultKey] = value;
          }
          steps.push(stepRecord);
        }
      } catch (error) {
        status = "failed";
        steps.push({
          error: error instanceof Error ? error.message : String(error),
        });
        const audit = await this.recordWorkflowAudit(
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
          },
        );
        const run = createLifeOpsWorkflowRun({
          agentId: this.agentId(),
          workflowId: definition.id,
          startedAt: args.startedAt,
          finishedAt: new Date().toISOString(),
          status,
          result: { steps, outputs },
          auditRef: audit.id,
        });
        await this.repository.createWorkflowRun(run);
        return {
          run,
          error,
        };
      }

      const audit = await this.recordWorkflowAudit(
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
      const run = createLifeOpsWorkflowRun({
        agentId: this.agentId(),
        workflowId: definition.id,
        startedAt: args.startedAt,
        finishedAt: new Date().toISOString(),
        status,
        result: { steps, outputs },
        auditRef: audit.id,
      });
      await this.repository.createWorkflowRun(run);
      return {
        run,
        error: null,
      };
    }

    async runWorkflow(
      workflowId: string,
      request: { now?: string; confirmBrowserActions?: boolean } = {},
    ): Promise<LifeOpsWorkflowRun> {
      const definition = await this.getWorkflowDefinition(workflowId);
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
      const result = await this.executeWorkflowDefinition(definition, {
        startedAt,
        confirmBrowserActions,
        request: request as Record<string, unknown>,
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

  return LifeOpsWorkflowsServiceMixin;
}

export function matchesCalendarEventEndedFilters(
  event: LifeOpsCalendarEvent,
  filters: LifeOpsCalendarEventEndedFilters | undefined,
): boolean {
  if (!filters) {
    return true;
  }
  if (filters.calendarIds && filters.calendarIds.length > 0) {
    if (!filters.calendarIds.includes(event.calendarId)) {
      return false;
    }
  }
  if (filters.titleIncludesAny && filters.titleIncludesAny.length > 0) {
    const title = (event.title ?? "").toLowerCase();
    const matched = filters.titleIncludesAny.some((needle) =>
      title.includes(needle.toLowerCase()),
    );
    if (!matched) {
      return false;
    }
  }
  if (typeof filters.minDurationMinutes === "number") {
    const startMs = Date.parse(event.startAt);
    const endMs = Date.parse(event.endAt);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      const minutes = (endMs - startMs) / 60_000;
      if (minutes < filters.minDurationMinutes) {
        return false;
      }
    }
  }
  if (
    filters.attendeeEmailIncludesAny &&
    filters.attendeeEmailIncludesAny.length > 0
  ) {
    const attendees = Array.isArray(event.attendees) ? event.attendees : [];
    const matched = attendees.some((attendee) => {
      const email =
        typeof attendee === "object" && attendee !== null
          ? String(
              (attendee as { email?: unknown }).email ?? "",
            ).toLowerCase()
          : "";
      if (!email) {
        return false;
      }
      return filters.attendeeEmailIncludesAny!.some((needle) =>
        email.includes(needle.toLowerCase()),
      );
    });
    if (!matched) {
      return false;
    }
  }
  return true;
}
