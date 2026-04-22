/**
 * T7f — GENERATE_DOSSIER action.
 *
 * Thin transport adapter that resolves dependencies from the runtime and
 * delegates to {@link DossierService}. The action owns no business logic.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent";
import { LifeOpsService } from "../lifeops/service.js";
import {
  DossierService,
  getRelationshipsServiceLike,
  type CalendarFeedProviderLike,
  type DossierResult,
} from "./service.js";

type GenerateDossierParams = {
  eventId?: string;
  eventTitleFuzzy?: string;
  windowDays?: number;
};

export const generateDossierAction: Action = {
  name: "GENERATE_DOSSIER",
  similes: [
    "MEETING_DOSSIER_BY_EVENT",
    "EVENT_DOSSIER",
    "GENERATE_DOSSIER_FROM_EVENT",
  ],
  description:
    "Low-level event-specific dossier generation for an already identified calendar event. " +
    "Use this only when the event id or fuzzy event title is already known from a prior workflow. " +
    "Prefer DOSSIER for generic user requests like 'brief me', 'background on the person I'm meeting', or 'prep me for my next meeting'.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as GenerateDossierParams;

    const needle =
      (params.eventId && params.eventId.trim()) ||
      (params.eventTitleFuzzy && params.eventTitleFuzzy.trim()) ||
      "";
    if (!needle) {
      return {
        text: "GENERATE_DOSSIER requires eventId or eventTitleFuzzy.",
        success: false,
        values: { success: false, error: "MISSING_EVENT_REF" },
        data: { actionName: "GENERATE_DOSSIER" },
      };
    }

    const lifeOps = new LifeOpsService(runtime);
    const calendar: CalendarFeedProviderLike = {
      getCalendarFeed: lifeOps.getCalendarFeed.bind(lifeOps),
    };
    const relationships = getRelationshipsServiceLike(runtime);
    const service = new DossierService(runtime, {
      calendar,
      relationships,
      gmail: null,
    });

    const result: DossierResult = await service.generateDossier(
      needle,
      params.windowDays,
    );
    return {
      text: result.text,
      success: true,
      values: { success: true, eventId: result.data.eventId },
      data: { actionName: "GENERATE_DOSSIER", ...result },
    };
  },
  parameters: [
    {
      name: "eventId",
      description: "Calendar event id. Mutually optional with eventTitleFuzzy.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "eventTitleFuzzy",
      description:
        "Fuzzy title match used when eventId is unknown (e.g. 'my 3pm').",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "windowDays",
      description: "Context window in days (default 7).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Generate a dossier for event 'Board sync tomorrow'" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Meeting Dossier — Board sync tomorrow\n...",
          action: "GENERATE_DOSSIER",
        },
      },
    ],
  ] as ActionExample[][],
};
