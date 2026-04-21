import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent/security";
import { LifeOpsService } from "../lifeops/service.js";

const ACTION_NAME = "DOSSIER";

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

export const dossierAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "GENERATE_DOSSIER",
    "PREMEETING_BRIEFING",
    "MEETING_BRIEFING",
    "PREPARE_FOR_MEETING",
    "BRIEF_ME",
    "BACKGROUND_BRIEF",
    "PERSON_BACKGROUND",
    "NEXT_MEETING_BRIEF",
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
    "Generate a pre-meeting or person-background briefing dossier with context about attendees, recent interactions, and upcoming event details. " +
    "Use this for requests like 'pull up a dossier on Satya Nadella', 'give me the background on the person I'm meeting next: Julia Chen', or 'brief me for my next meeting'. " +
    "If the user explicitly wants a brief, backgrounder, prep sheet, or dossier, use this action instead of replying from ENTITIES, FACTS, or memory alone.",
  descriptionCompressed:
    "Pre-meeting briefing dossier with attendees, recent context, and event details. Admin only.",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => hasAdminAccess(runtime, message),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner or admin may generate dossiers.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as DossierActionParams;

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

    if (typeof (service as unknown as { generateDossier?: unknown }).generateDossier !== "function") {
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
