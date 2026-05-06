import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { LifeOpsService } from "../lifeops/service.js";
import { runLifeOpsToonModel } from "./lifeops-google-helpers.js";

const ACTION_NAME = "OWNER_DOSSIER";

type DossierActionParams = {
  intent?: string;
  calendarEventId?: string;
  subject?: string;
  attendeeHandles?: string[] | string;
  generatedForAt?: string;
};

function extractText(message: Memory): string {
  const text = (message?.content as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : "";
}

function coerceHandles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  return trimmed;
}

function paramsAsToon(params: DossierActionParams): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        lines.push(`${key}[${index}]: ${String(entry)}`);
      });
      continue;
    }
    if (value !== undefined && value !== null && value !== "") {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.join("\n");
}

async function resolveDossierParamsWithToon(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  rawParams: DossierActionParams;
}): Promise<DossierActionParams> {
  const existingSubject =
    nonEmptyString(args.rawParams.subject) ??
    nonEmptyString(args.rawParams.intent);
  if (existingSubject) {
    return args.rawParams;
  }

  const currentMessage = extractText(args.message).trim();
  const prompt = [
    "Extract DOSSIER action parameters from the current user request.",
    "Return TOON only with exactly these fields:",
    "subject: meeting title, person name, topic, or null",
    "calendarEventId: explicit calendar event id, or null",
    "attendeeHandles: list of attendee handles/emails, empty when none",
    "generatedForAt: ISO timestamp or natural date/time phrase, or null",
    "",
    "Rules:",
    "- Use only details stated or clearly implied by the request.",
    "- Prefer the person, meeting, or topic the user wants briefed as subject.",
    "- Do not invent attendee handles or event ids.",
    "- Return only TOON; no prose, markdown, JSON, or code fences.",
    "",
    "Already supplied parameters:",
    paramsAsToon(args.rawParams) || "(none)",
    "Current request:",
    currentMessage || "(empty)",
  ].join("\n");

  const result = await runLifeOpsToonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "OWNER_DOSSIER.extract_params",
    failureMessage: "Dossier parameter extraction model call failed",
    source: "action:dossier",
    modelType: ModelType.TEXT_SMALL,
    purpose: "action",
  });
  const parsed = result?.parsed ?? {};
  return {
    intent: nonEmptyString(parsed.intent) ?? args.rawParams.intent,
    calendarEventId:
      args.rawParams.calendarEventId ?? nonEmptyString(parsed.calendarEventId),
    subject: args.rawParams.subject ?? nonEmptyString(parsed.subject),
    attendeeHandles:
      args.rawParams.attendeeHandles ?? coerceHandles(parsed.attendeeHandles),
    generatedForAt:
      args.rawParams.generatedForAt ?? nonEmptyString(parsed.generatedForAt),
  };
}

export const dossierAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "MEETING_BRIEFING",
    "PREMEETING_BRIEF",
    "BRIEF_ME",
    "BACKGROUND_BRIEF",
    "PERSON_BACKGROUND",
    "WHO_AM_I_MEETING",
  ],
  tags: [
    "always-include",
    "dossier",
    "briefing",
    "next meeting",
    "next event",
    "meeting prep",
  ],
  description:
    "Generate a pre-meeting or person-background briefing dossier with context about attendees, recent interactions, and upcoming event details.",
  descriptionCompressed:
    "pre-meeting briefing dossier attendees recent context event details owner",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => hasOwnerAccess(runtime, message),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may generate dossiers.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as DossierActionParams;
    const params = await resolveDossierParamsWithToon({
      runtime,
      message,
      state,
      rawParams,
    });

    const subject =
      (params.subject && params.subject.trim()) ||
      (params.intent && params.intent.trim()) ||
      extractText(message).trim();

    if (!subject) {
      return {
        text: "Please provide a subject or intent for the dossier.",
        success: false,
        values: { success: false, error: "MISSING_SUBJECT" },
        data: { actionName: ACTION_NAME },
      };
    }

    const service = new LifeOpsService(runtime);

    if (
      typeof (service as unknown as { generateDossier?: unknown })
        .generateDossier !== "function"
    ) {
      return {
        text: "LifeOps service is unavailable; cannot generate dossier.",
        success: false,
        values: { success: false, error: "SERVICE_UNAVAILABLE" },
        data: { actionName: ACTION_NAME },
      };
    }

    const dossier = await service.generateDossier({
      subject,
      calendarEventId: params.calendarEventId ?? null,
      attendeeHandles: coerceHandles(params.attendeeHandles),
      generatedForAt: params.generatedForAt,
    });

    return {
      text: dossier.contentMd || `Dossier generated for "${subject}".`,
      success: true,
      values: {
        success: true,
        dossierId: dossier.id,
        subject: dossier.subject,
      },
      data: {
        actionName: ACTION_NAME,
        dossier,
      },
    };
  },

  parameters: [
    {
      name: "intent",
      description:
        'Natural language request. Examples: "brief me for my 2pm with Alice", "prep me for tomorrow\'s board meeting".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "calendarEventId",
      description:
        "Optional calendar event id to pull event details (title, time, location, attendees).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "subject",
      description:
        "Subject line for the dossier (e.g. meeting title or topic).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "attendeeHandles",
      description:
        "List of attendee handles/emails to look up in the relationships table.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "generatedForAt",
      description:
        "ISO timestamp the dossier is generated for (defaults to now).",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Pull up a dossier on Satya Nadella" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Satya Nadella Briefing\n\n## Summary\n...",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Give me the background on the person I'm meeting next: Julia Chen",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Julia Chen Briefing\n\n## Summary\n...\n## Recent Context\n...",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Brief me for my 2pm meeting with Alice" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Meeting Briefing — 2pm with Alice\n\n## Summary\n...",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Generate a dossier for tomorrow's board sync" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Board Sync Briefing\n\n## Who's Attending\n...",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Prep me for the product review" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Product Review Briefing\n\n## Summary\n...\n## Suggested Talking Points\n...",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Give me the dossier for my next meeting or event." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Meeting Briefing\n\n## Summary\nHere's the dossier for your next meeting or event, including the people, logistics, and recent context.",
        },
      },
    ],
  ] as ActionExample[][],
};
