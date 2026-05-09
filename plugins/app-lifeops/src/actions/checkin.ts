import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { CheckinService } from "../lifeops/checkin/checkin-service.js";
import type { CheckinKind } from "../lifeops/checkin/types.js";
import { LifeOpsService } from "../lifeops/service.js";
import { hasLifeOpsAccess } from "../lifeops/access.js";

type CheckinParams = {
  kind?: CheckinKind | string;
  subaction?: CheckinKind | "run" | string;
  timezone?: string;
};

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeKind(value: unknown, text: string): CheckinKind {
  const explicit = stringParam(value)?.toLowerCase();
  if (explicit === "night" || explicit === "evening") {
    return "night";
  }
  if (explicit === "morning") {
    return "morning";
  }
  return /\b(?:night|evening|end[-\s]?of[-\s]?day|bedtime)\b/iu.test(text)
    ? "night"
    : "morning";
}

export const checkinAction: Action = {
  name: "CHECKIN",
  similes: [
    "CHECK_IN",
    "LIFE_CHECK_IN",
    "MORNING_CHECKIN",
    "MORNING_CHECK_IN",
    "NIGHT_CHECKIN",
    "NIGHT_CHECK_IN",
    "RUN_CHECKIN",
    "RUN_MORNING_CHECKIN",
    "RUN_NIGHT_CHECKIN",
    "DAILY_BRIEF",
  ],
  description:
    "Owner-only. Run a LifeOps morning or night check-in now by assembling the owner's todos, habits, goals, inbox, calendar, and recent signals into a briefing.",
  descriptionCompressed:
    "run owner LifeOps check-in now: kind morning|night; returns briefing summary",
  routingHint:
    "morning/night/daily check-in requests -> CHECKIN; never invent AUTOMATION_RUN",
  contexts: ["tasks", "health", "automation", "calendar", "email"],
  roleGate: { minRole: "OWNER" },
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "kind",
      description: "morning or night. Infer from the user request when omitted.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "timezone",
      description: "Optional IANA timezone override.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "run my morning check-in" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Morning check-in: ...",
          action: "CHECKIN",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "give me my night check-in" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Night check-in: ...",
          action: "CHECKIN",
        },
      },
    ],
  ] as ActionExample[][],
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Check-ins are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as CheckinParams;
    const text = messageText(message);
    const kind = normalizeKind(params.kind ?? params.subaction, text);
    const timezone = stringParam(params.timezone) ?? resolveDefaultTimeZone();
    const sources = new LifeOpsService(runtime);
    const service = new CheckinService(runtime, { sources });
    const report =
      kind === "night"
        ? await service.runNightCheckin({ timezone })
        : await service.runMorningCheckin({ timezone });

    await callback?.({
      text: report.summaryText,
      data: report as unknown as Parameters<
        NonNullable<typeof callback>
      >[0]["data"],
    });

    return {
      text: report.summaryText,
      success: true,
      data: report as unknown as ActionResult["data"],
    };
  },
};
