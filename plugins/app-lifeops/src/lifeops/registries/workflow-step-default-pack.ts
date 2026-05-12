/**
 * Default WorkflowStepRegistry pack.
 *
 * Lifts the 9-branch `if/else` switch from `service-mixin-workflows.ts`
 * (audit `rigidity-hunt-audit.md` top-2: workflow step dispatch) into 10
 * registry contributions — one per existing `step.kind`. Pure refactor:
 * each handler is the same body that previously lived inside the switch
 * arm. Behavior must be identical.
 *
 * The 10 contributions:
 *   1. `create_task` — delegate to `LifeOpsServiceBase.createDefinition`,
 *      defaulting ownership to the workflow's domain/subject when the
 *      step omits its own ownership block.
 *   2. `relock_website_access` — call `relockWebsiteAccessGroup(groupKey, now)`.
 *   3. `resolve_website_access_callback` —
 *      call `resolveWebsiteAccessCallback(callbackKey, now)`.
 *   4. `get_calendar_feed` — invoke `getCalendarFeed` with an internal URL.
 *   5. `get_gmail_triage` — invoke `getGmailTriage`.
 *   6. `get_gmail_unresponded` — invoke `getGmailUnresponded`.
 *   7. `get_health_summary` — invoke `getHealthSummary`.
 *   8. `dispatch_workflow` — resolve `WORKFLOW_DISPATCH` service and
 *      delegate, threading the workflow `request` + accumulated outputs.
 *   9. `summarize` — describe the previous step or named-output value.
 *  10. `browser` — open a browser session honoring the workflow's
 *      permission policy + confirmation flag.
 */

import { z } from "zod";
import { describeWorkflowValue } from "../service-helpers-browser.js";
import type {
  AnyWorkflowStepContribution,
  WorkflowStepRegistry,
} from "./workflow-step-registry.js";

const baseStepFields = {
  id: z.string().optional(),
  resultKey: z.string().optional(),
} as const;

// -- 1. create_task -------------------------------------------------------

const createTaskStepSchema = z.object({
  kind: z.literal("create_task"),
  ...baseStepFields,
  // Request body forwarded to createDefinition; full schema lives in
  // service-normalize-task.ts and runs at intake. Registry only enforces
  // record-shape + presence, not the full CreateLifeOpsDefinitionRequest.
  request: z.record(z.string(), z.unknown()),
});

const createTaskContribution: AnyWorkflowStepContribution = {
  kind: "create_task",
  describe: {
    label: "Create task",
    description:
      "Create a LifeOpsTaskDefinition; defaults ownership to the workflow's domain when omitted.",
    provider: "app-lifeops:default",
  },
  paramSchema: createTaskStepSchema,
  async execute(step, args, ctx) {
    const typed = step as z.infer<typeof createTaskStepSchema>;
    const stepRequest = typed.request as {
      ownership?: unknown;
      [key: string]: unknown;
    };
    const created = await ctx.createDefinition({
      ...stepRequest,
      ownership: stepRequest.ownership ?? {
        domain: args.definition.domain,
        subjectType: args.definition.subjectType,
        subjectId: args.definition.subjectId,
        visibilityScope: args.definition.visibilityScope,
        contextPolicy: args.definition.contextPolicy,
      },
    } as Parameters<typeof ctx.createDefinition>[0]);
    return {
      definitionId: created.definition.id,
      title: created.definition.title,
      reminderPlanId: created.reminderPlan?.id ?? null,
    };
  },
};

// -- 2. relock_website_access --------------------------------------------

const relockWebsiteAccessStepSchema = z.object({
  kind: z.literal("relock_website_access"),
  ...baseStepFields,
  request: z.object({
    groupKey: z.string().min(1),
  }),
});

const relockWebsiteAccessContribution: AnyWorkflowStepContribution = {
  kind: "relock_website_access",
  describe: {
    label: "Re-lock website access group",
    description: "Revoke any active website-access grants for the named group.",
    provider: "app-lifeops:default",
  },
  paramSchema: relockWebsiteAccessStepSchema,
  async execute(step, args, ctx) {
    const typed = step as z.infer<typeof relockWebsiteAccessStepSchema>;
    return ctx.relockWebsiteAccessGroup(
      typed.request.groupKey,
      new Date(args.startedAt),
    );
  },
};

// -- 3. resolve_website_access_callback ----------------------------------

const resolveWebsiteAccessCallbackStepSchema = z.object({
  kind: z.literal("resolve_website_access_callback"),
  ...baseStepFields,
  request: z.object({
    callbackKey: z.string().min(1),
  }),
});

const resolveWebsiteAccessCallbackContribution: AnyWorkflowStepContribution = {
  kind: "resolve_website_access_callback",
  describe: {
    label: "Resolve website-access callback",
    description: "Revoke website-access grants tied to a callback key.",
    provider: "app-lifeops:default",
  },
  paramSchema: resolveWebsiteAccessCallbackStepSchema,
  async execute(step, args, ctx) {
    const typed = step as z.infer<
      typeof resolveWebsiteAccessCallbackStepSchema
    >;
    return ctx.resolveWebsiteAccessCallback(
      typed.request.callbackKey,
      new Date(args.startedAt),
    );
  },
};

// -- 4. get_calendar_feed -------------------------------------------------

const getCalendarFeedStepSchema = z.object({
  kind: z.literal("get_calendar_feed"),
  ...baseStepFields,
  request: z.record(z.string(), z.unknown()).optional(),
});

const getCalendarFeedContribution: AnyWorkflowStepContribution = {
  kind: "get_calendar_feed",
  describe: {
    label: "Get calendar feed",
    description:
      "Read the LifeOps calendar feed (events + suggestions) at the run instant.",
    provider: "app-lifeops:default",
  },
  paramSchema: getCalendarFeedStepSchema,
  async execute(step, args, ctx) {
    const internalUrl = new URL("http://127.0.0.1/");
    const request = (step as z.infer<typeof getCalendarFeedStepSchema>).request;
    return ctx.getCalendarFeed(
      internalUrl,
      (request ?? {}) as Parameters<typeof ctx.getCalendarFeed>[1],
      new Date(args.startedAt),
    );
  },
};

// -- 5. get_gmail_triage --------------------------------------------------

const getGmailTriageStepSchema = z.object({
  kind: z.literal("get_gmail_triage"),
  ...baseStepFields,
  request: z.record(z.string(), z.unknown()).optional(),
});

const getGmailTriageContribution: AnyWorkflowStepContribution = {
  kind: "get_gmail_triage",
  describe: {
    label: "Get Gmail triage",
    description: "Read the Gmail triage feed (priority, drafts, unread).",
    provider: "app-lifeops:default",
  },
  paramSchema: getGmailTriageStepSchema,
  async execute(step, args, ctx) {
    const internalUrl = new URL("http://127.0.0.1/");
    const request = (step as z.infer<typeof getGmailTriageStepSchema>).request;
    return ctx.getGmailTriage(
      internalUrl,
      (request ?? {}) as Parameters<typeof ctx.getGmailTriage>[1],
      new Date(args.startedAt),
    );
  },
};

// -- 6. get_gmail_unresponded --------------------------------------------

const getGmailUnrespondedStepSchema = z.object({
  kind: z.literal("get_gmail_unresponded"),
  ...baseStepFields,
  request: z.record(z.string(), z.unknown()).optional(),
});

const getGmailUnrespondedContribution: AnyWorkflowStepContribution = {
  kind: "get_gmail_unresponded",
  describe: {
    label: "Get unresponded Gmail thread",
    description:
      "Read Gmail threads awaiting a reply older than the threshold.",
    provider: "app-lifeops:default",
  },
  paramSchema: getGmailUnrespondedStepSchema,
  async execute(step, args, ctx) {
    const internalUrl = new URL("http://127.0.0.1/");
    const request = (step as z.infer<typeof getGmailUnrespondedStepSchema>)
      .request;
    return ctx.getGmailUnresponded(
      internalUrl,
      (request ?? {}) as Parameters<typeof ctx.getGmailUnresponded>[1],
      new Date(args.startedAt),
    );
  },
};

// -- 7. get_health_summary -----------------------------------------------

const getHealthSummaryStepSchema = z.object({
  kind: z.literal("get_health_summary"),
  ...baseStepFields,
  request: z.record(z.string(), z.unknown()).optional(),
});

const getHealthSummaryContribution: AnyWorkflowStepContribution = {
  kind: "get_health_summary",
  describe: {
    label: "Get health summary",
    description: "Read the LifeOps health summary (sleep, activity, vitals).",
    provider: "app-lifeops:default",
  },
  paramSchema: getHealthSummaryStepSchema,
  async execute(step, _args, ctx) {
    const request = (step as z.infer<typeof getHealthSummaryStepSchema>)
      .request;
    return ctx.getHealthSummary(
      (request ?? {}) as Parameters<typeof ctx.getHealthSummary>[0],
    );
  },
};

// -- 8. dispatch_workflow -------------------------------------------------

const dispatchWorkflowStepSchema = z.object({
  kind: z.literal("dispatch_workflow"),
  ...baseStepFields,
  workflowId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});

interface WorkflowDispatchServiceLike {
  execute?: (
    workflowId: string,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
}

const dispatchWorkflowContribution: AnyWorkflowStepContribution = {
  kind: "dispatch_workflow",
  describe: {
    label: "Dispatch nested workflow",
    description:
      "Invoke another workflow by id via the WORKFLOW_DISPATCH service, threading the parent run's request + accumulated outputs.",
    provider: "app-lifeops:default",
  },
  paramSchema: dispatchWorkflowStepSchema,
  async execute(step, args, ctx) {
    const typed = step as z.infer<typeof dispatchWorkflowStepSchema>;
    const dispatch = ctx.runtime.getService(
      "WORKFLOW_DISPATCH",
    ) as WorkflowDispatchServiceLike | null;
    if (!dispatch || typeof dispatch.execute !== "function") {
      return {
        ok: false,
        error: "WORKFLOW_DISPATCH service not registered",
      };
    }
    return dispatch.execute(typed.workflowId, {
      ...(typed.payload ?? {}),
      request: args.request,
      outputs: args.outputs,
    });
  },
};

// -- 9. summarize ---------------------------------------------------------

const summarizeStepSchema = z.object({
  kind: z.literal("summarize"),
  ...baseStepFields,
  sourceKey: z.string().optional(),
  prompt: z.string().optional(),
});

const summarizeContribution: AnyWorkflowStepContribution = {
  kind: "summarize",
  describe: {
    label: "Summarize prior output",
    description:
      "Describe the previous step (or a named output via sourceKey) using describeWorkflowValue.",
    provider: "app-lifeops:default",
  },
  paramSchema: summarizeStepSchema,
  async execute(step, args, _ctx) {
    const typed = step as z.infer<typeof summarizeStepSchema>;
    const sourceValue =
      (typed.sourceKey
        ? args.outputs[typed.sourceKey]
        : args.previousStepValue) ?? null;
    return {
      text: describeWorkflowValue(sourceValue, typed.prompt),
    };
  },
};

// -- 10. browser ----------------------------------------------------------

const browserStepSchema = z.object({
  kind: z.literal("browser"),
  ...baseStepFields,
  sessionTitle: z.string().min(1),
  actions: z.array(z.record(z.string(), z.unknown())).min(1),
});

const browserContribution: AnyWorkflowStepContribution = {
  kind: "browser",
  describe: {
    label: "Run browser session",
    description:
      "Open a browser session for the workflow; honors permissionPolicy.allowBrowserActions and confirmation flags.",
    provider: "app-lifeops:default",
  },
  paramSchema: browserStepSchema,
  async execute(step, args, ctx) {
    const typed = step as z.infer<typeof browserStepSchema>;
    if (!args.definition.permissionPolicy.allowBrowserActions) {
      return {
        blocked: true,
        reason: "browser_actions_disabled" as const,
      };
    }
    const session = await ctx.createBrowserSessionInternal({
      workflowId: args.definition.id,
      title: typed.sessionTitle,
      actions: typed.actions as Parameters<
        typeof ctx.createBrowserSessionInternal
      >[0]["actions"],
      ownership: {
        domain: args.definition.domain,
        subjectType: args.definition.subjectType,
        subjectId: args.definition.subjectId,
        visibilityScope: args.definition.visibilityScope,
        contextPolicy: args.definition.contextPolicy,
      },
    });
    if (
      session.awaitingConfirmationForActionId &&
      !args.definition.permissionPolicy.trustedBrowserActions &&
      !args.confirmBrowserActions
    ) {
      return {
        sessionId: session.id,
        status: session.status,
        requiresConfirmation: true,
      };
    }
    const updated = {
      ...session,
      status: "queued" as const,
      awaitingConfirmationForActionId: null,
      updatedAt: new Date().toISOString(),
    };
    await ctx.repository.updateBrowserSession(updated);
    await ctx.recordBrowserAudit(
      "browser_session_updated",
      updated.id,
      "browser session started",
      { workflowId: args.definition.id },
      { status: updated.status },
    );
    return {
      sessionId: updated.id,
      status: updated.status,
      requiresConfirmation: false,
    };
  },
};

// ---------------------------------------------------------------------------

export const APP_LIFEOPS_WORKFLOW_STEP_CONTRIBUTIONS: readonly AnyWorkflowStepContribution[] =
  [
    createTaskContribution,
    relockWebsiteAccessContribution,
    resolveWebsiteAccessCallbackContribution,
    getCalendarFeedContribution,
    getGmailTriageContribution,
    getGmailUnrespondedContribution,
    getHealthSummaryContribution,
    dispatchWorkflowContribution,
    summarizeContribution,
    browserContribution,
  ];

export function registerDefaultWorkflowStepPack(
  registry: WorkflowStepRegistry,
): void {
  for (const contribution of APP_LIFEOPS_WORKFLOW_STEP_CONTRIBUTIONS) {
    registry.register(contribution);
  }
}
