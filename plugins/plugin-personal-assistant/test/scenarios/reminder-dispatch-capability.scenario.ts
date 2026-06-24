import { scenario } from "@elizaos/scenario-runner/schema";

function assertApiBody(options: {
  includesAll?: ReadonlyArray<string>;
}): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const serialized =
      typeof body === "string" ? body : JSON.stringify(body ?? "");
    for (const needle of options.includesAll ?? []) {
      if (!serialized.includes(needle)) {
        return `expected body to include "${needle}"`;
      }
    }
  };
}

/**
 * Behavior scenario for the `reminder_dispatch` LifeOps capability.
 *
 * When a scheduled reminder fires, the reminders mixin
 * (`buildReminderDispatchPrompt` in
 * `plugins/plugin-personal-assistant/src/lifeops/service-mixin-reminders.ts`)
 * composes the natural-language nudge the owner actually receives. Its
 * instruction body is the GEPA-optimizable `reminder_dispatch` prompt:
 * `REMINDER_DISPATCH_INSTRUCTIONS` is the wired baseline that
 * `resolveOptimizedPromptForRuntime` swaps for a registered
 * `reminder_dispatch` artifact.
 *
 * Unlike a chat-turn planner capability, `reminder_dispatch` runs on the
 * delivery path, so this scenario seeds a due reminder definition and drives
 * `POST /api/lifeops/reminders/process` to fire it. The delivery assertion
 * (`delivered` on the `in_app` channel) confirms the dispatch path — and the
 * prompt that authors the reminder text — executed, so a regression in the
 * wired prompt or the firing pipeline surfaces as a failing scenario. It
 * mirrors `reminder.lifecycle.dismiss` but is scoped to the reminder-dispatch
 * capability.
 */
export default scenario({
  lane: "live-only",
  id: "reminder-dispatch-capability",
  title: "Reminder dispatch capability fires a due reminder on the delivery path",
  domain: "reminders",
  tags: ["lifeops", "reminders", "reminder_dispatch", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Reminder Dispatch Capability",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed due reminder",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Call mom",
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
            {
              channel: "in_app",
              offsetMinutes: 0,
              label: "In-app reminder",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process and dispatch reminder",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+10m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
  ],
});
