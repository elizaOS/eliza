// Defines the notification delivery multichannel outcome LifeOps scenario-runner spec.
import type {
  ScenarioCheckResult,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Outcome-asserting scenario for the LifeOps `reminder_dispatch` /
 * notification-delivery capability.
 *
 * Supersedes the routing-only `reminder-dispatch-capability.scenario.ts`, which
 * only proved a single `in_app` reminder reaches the delivery path and the
 * process response said "delivered" + "in_app". That file never proved the
 * multi-step, multi-channel fan-out: that EACH plan step is processed on its own
 * channel at its own offset, that the deliverable channel actually delivered
 * more than once (escalation sequencing), and that the per-channel dispatch
 * RESULT was persisted. This scenario asserts the durable delivery outcome, not
 * routing.
 *
 * GROUNDING — what actually delivers in the scenario runtime (verified in code):
 *   - The reminder service dispatches via `dispatchReminderAttempt`
 *     (`plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.ts`).
 *     The `in_app` channel always resolves to `connectorRef: "system:in_app"`
 *     and records `outcome: "delivered"` with NO external connector — so it is
 *     the deterministically-deliverable channel (same as the template).
 *   - Non-`in_app` channels are dispatched through
 *     `runtime.sendMessageToTarget(target, payload)`. In core
 *     (`packages/core/src/runtime.ts`) that THROWS when no send handler is
 *     registered for the source, and the scenario executor
 *     (`packages/scenario-runner/src/executor.ts`) only `ensureConnection`s
 *     rooms — it never registers send handlers — so `discord` / `telegram`
 *     attempts are genuinely ATTEMPTED on their channel and resolve to
 *     `outcome: "blocked_connector"` (the truthful result: those connectors are
 *     not wired in a credential-less runtime). We assert that real per-channel
 *     dispatch result, NOT a fabricated "delivered" we cannot produce here.
 *   - `priority: 1` maps to `critical` urgency
 *     (`priorityToUrgency`, `service-helpers-misc.ts`), so every channel passes
 *     `isReminderChannelAllowedForUrgency` — the non-`in_app` attempts are real
 *     dispatch attempts, not urgency-gated skips.
 *   - The channel policies (allowReminders + allowEscalation, with a
 *     `metadata.roomId`) make `resolveRuntimeReminderTarget` return a target so
 *     the dispatch path reaches `sendMessageToTarget` instead of being
 *     short-circuited by policy as `blocked_policy`.
 *
 * The OUTCOME is asserted three ways, none of which is routing:
 *   1. `POST /api/lifeops/reminders/process` `assertResponse` — the process
 *      response (`LifeOpsReminderProcessingResult.attempts[]`) must carry a
 *      `delivered` `in_app` attempt AND attempts on both other channels.
 *   2. `GET /api/lifeops/reminders/inspection` `assertResponse` — the persisted
 *      attempts + `reminder_delivered` audit are read back per occurrence.
 *   3. a `custom` finalCheck predicate reads the persisted reminder attempts +
 *      audits back through `LifeOpsService.inspectReminder` (agent-scoped, the
 *      same read the route uses) and asserts the actual per-channel delivery
 *      result: >= 2 delivered `in_app` attempts (plan step + escalation step),
 *      both `discord` and `telegram` attempted, and a persisted
 *      `reminder_delivered` audit. That is the durable artifact, not the planner.
 *
 * Routes / shapes exercised (all confirmed in
 * `plugins/plugin-personal-assistant/src/routes/lifeops-routes.ts` and the
 * `@elizaos/shared` `personal-assistant` contracts):
 *   - POST /api/lifeops/channel-policies   (UpsertLifeOpsChannelPolicyRequest -> 201)
 *   - POST /api/lifeops/definitions        (CreateLifeOpsDefinitionRequest -> 201)
 *   - POST /api/lifeops/reminders/process  (ProcessLifeOpsRemindersRequest -> 200)
 *   - GET  /api/lifeops/reminders/inspection (LifeOpsReminderInspection -> 200)
 */

const REMINDER_TITLE = "Multi-channel meds reminder";

/** Reminder attempt outcomes that count as a real successful delivery. */
const DELIVERED_OUTCOMES: ReadonlyArray<string> = [
  "delivered",
  "delivered_read",
  "delivered_unread",
];

type InspectableReminderService = {
  agentId(): string;
  listDefinitions(): Promise<
    Array<{ definition: { id: string; title: string } }>
  >;
  repository: {
    listOccurrencesForDefinition(
      agentId: string,
      definitionId: string,
    ): Promise<Array<{ id: string }>>;
  };
  inspectReminder(
    ownerType: "occurrence" | "calendar_event",
    ownerId: string,
  ): Promise<{
    attempts: Array<{ channel: string; outcome: string; stepIndex: number }>;
    audits: Array<{ type: string }>;
  }>;
};

/**
 * Read the persisted reminder attempts + audits back through the LifeOps
 * service (the same path `/api/lifeops/reminders/inspection` uses) and assert
 * the actual per-channel delivery RESULT. This never looks at routing or
 * selected actions — only the rows the dispatcher wrote.
 */
async function assertPersistedDelivery(
  ctx: ScenarioContext,
): Promise<ScenarioCheckResult> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return "notification-delivery outcome: scenario runtime unavailable";
  }
  const { LifeOpsService } = (await import(
    "@elizaos/plugin-personal-assistant"
  )) as {
    LifeOpsService: new (rt: unknown) => InspectableReminderService;
  };
  const service = new LifeOpsService(runtime);

  const definitions = await service.listDefinitions();
  const record = definitions.find(
    (entry) => entry.definition.title === REMINDER_TITLE,
  );
  if (!record) {
    return `notification-delivery outcome: no persisted definition titled "${REMINDER_TITLE}"`;
  }

  const occurrences = await service.repository.listOccurrencesForDefinition(
    service.agentId(),
    record.definition.id,
  );
  const occurrence = occurrences[0];
  if (!occurrence) {
    return `notification-delivery outcome: definition "${REMINDER_TITLE}" materialized no occurrence to deliver against`;
  }

  const inspection = await service.inspectReminder("occurrence", occurrence.id);
  const attempts = inspection.attempts ?? [];

  // 1. The deliverable channel delivered more than once: the plan step AND the
  //    subsequent escalation step. This proves real multi-step sequenced delivery,
  //    not a single nudge.
  const deliveredInApp = attempts.filter(
    (attempt) =>
      attempt.channel === "in_app" &&
      DELIVERED_OUTCOMES.includes(attempt.outcome),
  );
  if (deliveredInApp.length < 2) {
    return `notification-delivery outcome: expected >= 2 delivered in_app attempts (plan + escalation), saw ${deliveredInApp.length} of attempts [${attempts
      .map((a) => `${a.channel}:${a.outcome}`)
      .join(", ")}]`;
  }

  // 2. The plan fanned out across channels: both other channels were genuinely
  //    ATTEMPTED on their own channel (their outcome reflects the real,
  //    connector-less dispatch result — not a routing claim).
  const attemptedChannels = new Set(attempts.map((attempt) => attempt.channel));
  for (const channel of ["discord", "telegram"]) {
    if (!attemptedChannels.has(channel)) {
      return `notification-delivery outcome: expected a dispatch attempt on "${channel}", saw channels [${[
        ...attemptedChannels,
      ].join(", ")}]`;
    }
  }

  // 3. A durable delivery audit was written for this occurrence.
  const hasDeliveredAudit = (inspection.audits ?? []).some(
    (audit) => audit.type === "reminder_delivered",
  );
  if (!hasDeliveredAudit) {
    return `notification-delivery outcome: no persisted "reminder_delivered" audit for the occurrence`;
  }

  return undefined;
}

function assertApiBody(options: {
  includesAll?: ReadonlyArray<string>;
  excludes?: ReadonlyArray<string>;
}): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const serialized =
      typeof body === "string" ? body : JSON.stringify(body ?? "");
    for (const needle of options.includesAll ?? []) {
      if (!serialized.includes(needle)) {
        return `expected body to include "${needle}"`;
      }
    }
    for (const needle of options.excludes ?? []) {
      if (serialized.includes(needle)) {
        return `expected body to exclude "${needle}"`;
      }
    }
  };
}

export default scenario({
  lane: "live-only",
  id: "notification-delivery-multichannel-outcome",
  title:
    "Notification delivery: a multi-channel reminder plan fans out, delivers in_app twice (plan + escalation), and persists the per-channel result",
  domain: "reminders",
  tags: [
    "lifeops",
    "reminders",
    "reminder_dispatch",
    "notification",
    "outcome",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Notification Delivery Multi-Channel",
    },
  ],
  turns: [
    // Seed channel policies so the discord/telegram steps reach the dispatcher
    // (allowReminders + allowEscalation) and resolve a runtime target
    // (metadata.roomId) instead of short-circuiting as blocked_policy.
    {
      kind: "api",
      name: "seed discord channel policy",
      method: "POST",
      path: "/api/lifeops/channel-policies",
      body: {
        channelType: "discord",
        channelRef: "discord:owner-dm",
        allowReminders: true,
        allowEscalation: true,
        metadata: { roomId: "discord-owner-room", source: "discord" },
      },
      expectedStatus: 201,
      assertResponse: assertApiBody({ includesAll: ["discord"] }),
    },
    {
      kind: "api",
      name: "seed telegram channel policy",
      method: "POST",
      path: "/api/lifeops/channel-policies",
      body: {
        channelType: "telegram",
        channelRef: "telegram:owner-dm",
        allowReminders: true,
        allowEscalation: true,
        metadata: { roomId: "telegram-owner-room", source: "telegram" },
      },
      expectedStatus: 201,
      assertResponse: assertApiBody({ includesAll: ["telegram"] }),
    },
    // Seed a critical (priority 1) task with a multi-step, multi-channel
    // reminderPlan. priority 1 -> critical urgency, so every channel passes the
    // urgency gate. visibilityLeadMinutes opens the relevance window well before
    // dueAt, so all steps within the window become due when processed at
    // {{now+10m}} (same mechanics the template relies on). The escalation step
    // is a second in_app step at a subsequent offset.
    {
      kind: "api",
      name: "seed multi-channel reminder plan",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: REMINDER_TITLE,
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+10m}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            { channel: "in_app", offsetMinutes: 0, label: "In-app reminder" },
            { channel: "discord", offsetMinutes: 5, label: "Discord nudge" },
            { channel: "telegram", offsetMinutes: 10, label: "Telegram nudge" },
            {
              channel: "in_app",
              offsetMinutes: 30,
              label: "In-app escalation",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    // Process at due time: every step in the relevance window fires in one pass.
    // The deliverable in_app channel is delivered; the discord/telegram steps
    // are attempted on their channel. Assert the in_app delivery AND that the
    // other channels appear as processed attempts in the response.
    {
      kind: "api",
      name: "process multi-channel reminder",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+45m}}",
        limit: 25,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["delivered", "in_app", "discord", "telegram"],
      }),
    },
    // Read the persisted attempts + audits back, occurrence-scoped. The
    // delivered in_app attempts and the reminder_delivered audit must be
    // durably recorded (not just present in the transient process response).
    {
      kind: "api",
      name: "inspect persisted multi-channel delivery",
      method: "GET",
      path: "/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:Multi-channel meds reminder}}",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: [
          "delivered",
          "in_app",
          "discord",
          "telegram",
          "reminder_delivered",
        ],
      }),
    },
  ],
  finalChecks: [
    // Durable artifact assertion: the multi-step plan persisted with a reminder
    // plan and the right cadence.
    {
      type: "definitionCountDelta",
      title: REMINDER_TITLE,
      delta: 1,
      cadenceKind: "once",
      requireReminderPlan: true,
    },
    // Outcome assertion read back from the persisted reminder attempts/audits:
    // >= 2 delivered in_app attempts (plan + escalation), both other channels
    // attempted, and a reminder_delivered audit. This is the delivery RESULT,
    // not routing.
    {
      type: "custom",
      name: "persisted delivery: in_app delivered twice (plan + escalation), discord + telegram fanned out, reminder_delivered audit written",
      predicate: assertPersistedDelivery,
    },
  ],
});
