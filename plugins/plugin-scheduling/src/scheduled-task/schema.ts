/**
 * Zod validators for the generic `ScheduledTask` REST boundary.
 *
 * These validate the storage-agnostic `ScheduledTask` shape (runtime types
 * live in `./types.ts`); Zod is the validator at the untyped-input edge of the
 * scheduled-tasks route. Moved here from `@elizaos/plugin-personal-assistant`
 * so the route can live in `@elizaos/plugin-scheduling` and serve on every
 * platform; PA re-exports these for back-compat.
 */

import { z } from "zod";

const isoString = z
  .string()
  .min(1)
  .refine(
    (v) => !Number.isNaN(new Date(v).getTime()),
    "must be an ISO timestamp",
  );

const terminalStateSchema = z.enum([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

const scheduledTaskKindSchema = z.enum([
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
]);

const scheduledTaskPrioritySchema = z.enum(["low", "medium", "high"]);

const scheduledTaskSourceSchema = z.enum([
  "default_pack",
  "user_chat",
  "first_run",
  "plugin",
]);

const scheduledTaskSubjectSchema = z.object({
  kind: z.enum([
    "entity",
    "relationship",
    "thread",
    "document",
    "calendar_event",
    "self",
  ]),
  id: z.string().min(1),
});

const scheduledTaskTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), atIso: isoString }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1),
    tz: z.string().min(1),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().positive(),
    from: isoString.optional(),
    until: isoString.optional(),
  }),
  z.object({
    kind: z.literal("relative_to_anchor"),
    anchorKey: z.string().min(1),
    offsetMinutes: z.number().int(),
  }),
  z.object({
    kind: z.literal("during_window"),
    windowKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal("event"),
    eventKind: z.string().min(1),
    filter: z.unknown().optional(),
  }),
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("after_task"),
    taskId: z.string().min(1),
    outcome: terminalStateSchema,
  }),
]);

const scheduledTaskShouldFireSchema = z.object({
  compose: z.enum(["all", "any", "first_deny"]).optional(),
  gates: z.array(
    z.object({
      kind: z.string().min(1),
      params: z.unknown().optional(),
    }),
  ),
});

const scheduledTaskCompletionCheckSchema = z.object({
  kind: z.string().min(1),
  params: z.unknown().optional(),
  followupAfterMinutes: z.number().int().positive().optional(),
});

const escalationStepSchema = z.object({
  delayMinutes: z.number().int().min(0),
  channelKey: z.string().min(1),
  intensity: z.enum(["soft", "normal", "urgent"]).optional(),
});

const scheduledTaskEscalationSchema = z.object({
  ladderKey: z.string().min(1).optional(),
  steps: z.array(escalationStepSchema).optional(),
});

const scheduledTaskOutputSchema = z.object({
  destination: z.enum([
    "in_app_card",
    "channel",
    "apple_notes",
    "gmail_draft",
    "memory",
  ]),
  target: z.string().min(1).optional(),
  persistAs: z.enum(["task_metadata", "external_only"]).optional(),
});

const scheduledTaskRefSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().min(1), scheduledTaskInputBaseSchema]),
);

const scheduledTaskPipelineSchema = z.object({
  onComplete: z.array(scheduledTaskRefSchema).optional(),
  onSkip: z.array(scheduledTaskRefSchema).optional(),
  onFail: z.array(scheduledTaskRefSchema).optional(),
});

const scheduledTaskContextRequestSchema = z.object({
  includeOwnerFacts: z
    .array(
      z.enum([
        "preferredName",
        "timezone",
        "morningWindow",
        "eveningWindow",
        "locale",
      ]),
    )
    .optional(),
  includeEntities: z
    .object({
      entityIds: z.array(z.string().min(1)),
      fields: z
        .array(
          z.enum([
            "preferredName",
            "type",
            "identities",
            "state.lastInteractionPlatform",
          ]),
        )
        .optional(),
    })
    .optional(),
  includeRelationships: z
    .object({
      relationshipIds: z.array(z.string().min(1)).optional(),
      forEntityIds: z.array(z.string().min(1)).optional(),
      types: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  includeRecentTaskStates: z
    .object({
      kind: scheduledTaskKindSchema.optional(),
      lookbackHours: z.number().int().positive().optional(),
    })
    .optional(),
  includeEventPayload: z.boolean().optional(),
});

/**
 * The "input shape" for `runner.schedule()` — omits server-managed
 * `taskId` and `state` so callers cannot fabricate a state. The route
 * layer accepts this shape; the runner generates the rest.
 */
const scheduledTaskInputBaseSchema = z.object({
  kind: scheduledTaskKindSchema,
  promptInstructions: z.string().min(1),
  contextRequest: scheduledTaskContextRequestSchema.optional(),
  trigger: scheduledTaskTriggerSchema,
  priority: scheduledTaskPrioritySchema,
  shouldFire: scheduledTaskShouldFireSchema.optional(),
  completionCheck: scheduledTaskCompletionCheckSchema.optional(),
  escalation: scheduledTaskEscalationSchema.optional(),
  output: scheduledTaskOutputSchema.optional(),
  pipeline: scheduledTaskPipelineSchema.optional(),
  subject: scheduledTaskSubjectSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  respectsGlobalPause: z.boolean(),
  source: scheduledTaskSourceSchema,
  createdBy: z.string().min(1),
  ownerVisible: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const scheduledTaskInputSchema = scheduledTaskInputBaseSchema;

export const scheduledTaskStateSchema = z.object({
  status: z.enum([
    "completed",
    "skipped",
    "expired",
    "failed",
    "dismissed",
    "scheduled",
    "fired",
    "acknowledged",
  ]),
  firedAt: isoString.optional(),
  acknowledgedAt: isoString.optional(),
  completedAt: isoString.optional(),
  followupCount: z.number().int().min(0),
  lastFollowupAt: isoString.optional(),
  pipelineParentId: z.string().min(1).optional(),
  lastDecisionLog: z.string().optional(),
});

export const scheduledTaskSchema = scheduledTaskInputBaseSchema.extend({
  taskId: z.string().min(1),
  state: scheduledTaskStateSchema,
});

export const scheduledTaskVerbSchema = z.enum([
  "snooze",
  "skip",
  "complete",
  "dismiss",
  "escalate",
  "acknowledge",
  "edit",
  "reopen",
]);

export const scheduledTaskSnoozePayloadSchema = z
  .object({
    minutes: z.number().int().positive().optional(),
    untilIso: isoString.optional(),
  })
  .refine(
    (v) => typeof v.minutes === "number" || typeof v.untilIso === "string",
    "snooze: provide minutes or untilIso",
  );

export const scheduledTaskFilterSchema = z.object({
  kind: scheduledTaskKindSchema.optional(),
  status: z
    .union([
      scheduledTaskStateSchema.shape.status,
      z.array(scheduledTaskStateSchema.shape.status),
    ])
    .optional(),
  subject: scheduledTaskSubjectSchema.optional(),
  source: scheduledTaskSourceSchema.optional(),
  firedSince: isoString.optional(),
  ownerVisibleOnly: z.boolean().optional(),
});
