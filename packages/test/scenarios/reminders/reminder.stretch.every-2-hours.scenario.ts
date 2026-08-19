/** Proves the two-phase preview and confirmed persistence of a two-hour stretch reminder. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "reminder.stretch.every-2-hours",
  title: "Stretch every two hours during the day",
  domain: "reminders",
  evidenceScope: "domain-contract",
  tags: ["lifeops", "reminders", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "Reminders Stretch Every 2 Hours",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "stretch interval preview",
      text: "Remind me to stretch every 2 hours while I'm working.",
      responseIncludesAny: ["stretch", "2 hour", "two hour"],
      responseExcludes: ["saved", "created", "all set", "i've set"],
    },
    {
      kind: "message",
      name: "stretch interval confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "stretch"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "stretch-preview-is-not-persisted",
      predicate: (ctx) => {
        const preview = ctx.turns?.find(
          (turn) => turn.name === "stretch interval preview",
        );
        const life = preview?.actionsCalled.find(
          (action) => action.actionName === "LIFE",
        );
        if (!life) return "expected LIFE to produce a preview";
        const data =
          life.result?.data && typeof life.result.data === "object"
            ? (life.result.data as Record<string, unknown>)
            : null;
        if (
          data?.requiresConfirmation !== true ||
          (data.saved !== false && data.deferred !== true)
        ) {
          return `expected a deferred confirmation preview, saw ${JSON.stringify(data)}`;
        }
        if (data.definition !== undefined) {
          return "preview turn returned a persisted definition";
        }
      },
    },
    {
      type: "definitionCountDelta",
      title: "Stretch",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 120,
      requireReminderPlan: true,
    },
  ],
});
