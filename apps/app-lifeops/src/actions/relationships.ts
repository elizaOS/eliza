/**
 * LifeOps relationships action — Rolodex management.
 *
 * Subactions: list_contacts, add_contact, log_interaction, add_follow_up,
 * complete_follow_up, follow_up_list, days_since.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import type {
  LifeOpsFollowUpStatus,
  LifeOpsMessageChannel,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_MESSAGE_CHANNELS } from "@elizaos/shared/contracts/lifeops";
import { LifeOpsService } from "../lifeops/service.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";

type Subaction =
  | "list_contacts"
  | "add_contact"
  | "log_interaction"
  | "add_follow_up"
  | "complete_follow_up"
  | "follow_up_list"
  | "days_since";

type RelationshipParameters = {
  subaction?: Subaction;
  intent?: string;
  name?: string;
  channel?: LifeOpsMessageChannel;
  handle?: string;
  email?: string;
  phone?: string;
  notes?: string;
  relationshipId?: string;
  followUpId?: string;
  reason?: string;
  dueAt?: string;
  confirmed?: boolean;
};

function getParams(
  options: HandlerOptions | undefined,
): RelationshipParameters {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | RelationshipParameters
    | undefined;
  return params ?? {};
}

function messageText(message: Memory): string {
  return (message?.content?.text ?? "").toString();
}

const RELATIONSHIP_SUBACTIONS: readonly Subaction[] = [
  "list_contacts",
  "add_contact",
  "log_interaction",
  "add_follow_up",
  "complete_follow_up",
  "follow_up_list",
  "days_since",
];

function normalizeRelationshipSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (RELATIONSHIP_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as Subaction)
    : null;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type RelationshipLlmPlan = {
  subaction: Subaction | null;
  shouldAct: boolean | null;
  response?: string;
};

async function resolveRelationshipPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: RelationshipParameters;
}): Promise<RelationshipLlmPlan> {
  if (typeof args.runtime.useModel !== "function") {
    return { subaction: null, shouldAct: null };
  }

  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 6,
    })
  ).join("\n");
  const currentMessage =
    typeof args.message.content?.text === "string"
      ? args.message.content.text
      : "";
  const prompt = [
    "Plan the RELATIONSHIP (Rolodex) subaction for this request.",
    "The user may speak in any language.",
    "Return ONLY valid JSON with exactly these fields:",
    '{"subaction":"list_contacts"|"add_contact"|"log_interaction"|"add_follow_up"|"complete_follow_up"|"follow_up_list"|"days_since"|null,"shouldAct":true|false,"response":"string|null"}',
    "",
    "Choose list_contacts when the user wants to see, browse, list, or recall who is in the Rolodex.",
    "Choose add_contact when the user wants to remember a new person, store a handle, or add them to the contact list.",
    "Choose log_interaction when the user reports a past conversation, call, meeting, or message they had with a known contact.",
    "Choose add_follow_up when the user wants to schedule a future reminder to reach out to a contact.",
    "Choose complete_follow_up when the user marks an existing follow-up as done or finished.",
    "Choose follow_up_list when the user asks what follow-ups are pending or due.",
    "Choose days_since when the user asks how long it has been since they last talked to or contacted a person.",
    "Set shouldAct=false only when the request is too vague to safely choose any of the seven subactions.",
    "When shouldAct=false, response must be a short clarifying question in the user's language.",
    "",
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Structured parameters: ${JSON.stringify(args.params)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
    if (!parsed) {
      return { subaction: null, shouldAct: null };
    }
    return {
      subaction: normalizeRelationshipSubaction(parsed.subaction),
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:relationships",
        error: error instanceof Error ? error.message : String(error),
      },
      "Relationship planning model call failed",
    );
    return { subaction: null, shouldAct: null };
  }
}

function formatRelationshipLine(rel: {
  name: string;
  primaryChannel: string;
  primaryHandle: string;
  lastContactedAt: string | null;
}): string {
  const last = rel.lastContactedAt
    ? ` — last contacted ${rel.lastContactedAt}`
    : " — no contact logged";
  return `- ${rel.name} (${rel.primaryChannel}: ${rel.primaryHandle})${last}`;
}

export const relationshipAction: Action = {
  name: "RELATIONSHIP",
  similes: [
    "CONTACT",
    "ROLODEX",
    "FOLLOW_UP",
    "LOG_INTERACTION",
    "ADD_CONTACT",
  ],
  description:
    "Manage contacts, relationships, and follow-ups. Subactions: list_contacts, add_contact, log_interaction, add_follow_up, complete_follow_up, follow_up_list, days_since.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text =
        "Relationship management is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const body = messageText(message);
    const explicitSubaction = normalizeRelationshipSubaction(params.subaction);
    let subaction: Subaction | null = explicitSubaction;
    if (!subaction) {
      const intent = (params.intent ?? body).trim();
      const plan = await resolveRelationshipPlanWithLlm({
        runtime,
        message,
        state,
        intent,
        params,
      });
      subaction = plan.subaction;
      if (plan.shouldAct === false || !subaction) {
        const text =
          plan.response ??
          "Tell me whether you want to list contacts, add a contact, log an interaction, schedule a follow-up, complete a follow-up, list follow-ups, or check days since last contact.";
        await callback?.({ text });
        return {
          text,
          success: true,
          data: {
            noop: true,
            suggestedSubaction: subaction,
          },
        };
      }
    }
    const service = new LifeOpsService(runtime);

    if (subaction === "list_contacts") {
      const contacts = await service.listRelationships({ limit: 50 });
      const text =
        contacts.length === 0
          ? "You have no contacts in your Rolodex yet."
          : `You have ${contacts.length} contact${contacts.length === 1 ? "" : "s"}:\n${contacts.map(formatRelationshipLine).join("\n")}`;
      await callback?.({ text, source: "action", action: "RELATIONSHIP" });
      return {
        text,
        success: true,
        data: { subaction, contacts },
      };
    }

    if (subaction === "add_contact") {
      const name = params.name;
      const channel = params.channel;
      const handle = params.handle;
      if (!name || !channel || !handle) {
        const text =
          "To add a contact I need at least a name, a primary channel, and a handle.";
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { subaction, error: "MISSING_FIELDS" },
        };
      }
      if (!LIFEOPS_MESSAGE_CHANNELS.includes(channel)) {
        const text = `Unknown channel '${channel}'. Supported: ${LIFEOPS_MESSAGE_CHANNELS.join(", ")}.`;
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { subaction, error: "INVALID_CHANNEL" },
        };
      }
      const rel = await service.upsertRelationship({
        name,
        primaryChannel: channel,
        primaryHandle: handle,
        email: params.email ?? null,
        phone: params.phone ?? null,
        notes: params.notes ?? "",
        tags: [],
        relationshipType: "contact",
        lastContactedAt: null,
        metadata: {},
      });
      const text = `Added ${rel.name} (${rel.primaryChannel}: ${rel.primaryHandle}) to your Rolodex.`;
      await callback?.({ text, source: "action", action: "RELATIONSHIP" });
      return {
        text,
        success: true,
        data: { subaction, relationship: rel },
      };
    }

    if (subaction === "log_interaction") {
      const relationshipId = params.relationshipId;
      if (!relationshipId) {
        const text = "I need the contact's relationshipId to log an interaction.";
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { subaction, error: "MISSING_RELATIONSHIP_ID" },
        };
      }
      const rel = await service.getRelationship(relationshipId);
      if (!rel) {
        const text = `No contact found with id ${relationshipId}.`;
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { subaction, error: "NOT_FOUND" },
        };
      }
      const channel = params.channel ?? rel.primaryChannel;
      const interaction = await service.logInteraction({
        relationshipId,
        channel,
        direction: "outbound",
        summary: params.notes ?? params.reason ?? "",
        occurredAt: new Date().toISOString(),
        metadata: {},
      });
      const text = `Logged interaction with ${rel.name} on ${channel}.`;
      await callback?.({ text, source: "action", action: "RELATIONSHIP" });
      return {
        text,
        success: true,
        data: { subaction, interaction },
      };
    }

    if (subaction === "add_follow_up") {
      const relationshipId = params.relationshipId;
      const dueAt = params.dueAt;
      const reason = params.reason ?? params.notes ?? "";
      if (!relationshipId || !dueAt) {
        const text = "I need a contact relationshipId and a dueAt to schedule a follow-up.";
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { subaction, error: "MISSING_FIELDS" },
        };
      }
      const followUp = await service.createFollowUp({
        relationshipId,
        dueAt,
        reason,
        priority: 3,
        draft: null,
        completedAt: null,
        metadata: {},
      });
      const text = `Scheduled follow-up for ${dueAt}: ${reason || "(no reason)"}.`;
      await callback?.({ text, source: "action", action: "RELATIONSHIP" });
      return {
        text,
        success: true,
        data: { subaction, followUp },
      };
    }

    if (subaction === "complete_follow_up") {
      const followUpId = params.followUpId;
      if (!followUpId) {
        const text = "I need the followUpId to complete.";
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { subaction, error: "MISSING_FOLLOW_UP_ID" },
        };
      }
      await service.completeFollowUp(followUpId);
      const text = `Marked follow-up ${followUpId} as completed.`;
      await callback?.({ text, source: "action", action: "RELATIONSHIP" });
      return {
        text,
        success: true,
        data: { subaction, followUpId },
      };
    }

    if (subaction === "follow_up_list") {
      const queue = await service.getDailyFollowUpQueue({ limit: 50 });
      const text =
        queue.length === 0
          ? "No follow-ups due today."
          : `You have ${queue.length} follow-up${queue.length === 1 ? "" : "s"} due:\n${queue
              .map(
                (fu) =>
                  `- ${fu.dueAt} — ${fu.reason} (id: ${fu.id})`,
              )
              .join("\n")}`;
      await callback?.({ text, source: "action", action: "RELATIONSHIP" });
      return {
        text,
        success: true,
        data: { subaction, followUps: queue },
      };
    }

    if (subaction === "days_since") {
      const relationshipId = params.relationshipId;
      if (!relationshipId) {
        const text = "I need a relationshipId to check last contact.";
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { subaction, error: "MISSING_RELATIONSHIP_ID" },
        };
      }
      const rel = await service.getRelationship(relationshipId);
      const days = await service.getDaysSinceContact(relationshipId);
      const text =
        days === null
          ? `No contact has been logged with ${rel?.name ?? relationshipId}.`
          : `It has been ${days} day${days === 1 ? "" : "s"} since you contacted ${rel?.name ?? relationshipId}.`;
      await callback?.({ text, source: "action", action: "RELATIONSHIP" });
      return {
        text,
        success: true,
        data: { subaction, relationshipId, days },
      };
    }

    const text = `Unknown relationship subaction: ${subaction}.`;
    await callback?.({ text });
    return {
      text,
      success: false,
      data: { error: "UNKNOWN_SUBACTION", subaction },
    };
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Which relationship operation to run: list_contacts, add_contact, log_interaction, add_follow_up, complete_follow_up, follow_up_list, days_since.",
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description: "Free-form user intent used to infer subaction when not set.",
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description: "Contact display name.",
      schema: { type: "string" as const },
    },
    {
      name: "channel",
      description:
        "Primary channel for the contact (email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp, x_dm).",
      schema: { type: "string" as const },
    },
    {
      name: "handle",
      description: "Primary handle/address on the chosen channel.",
      schema: { type: "string" as const },
    },
    {
      name: "email",
      description: "Optional email address for the contact.",
      schema: { type: "string" as const },
    },
    {
      name: "phone",
      description: "Optional phone number for the contact.",
      schema: { type: "string" as const },
    },
    {
      name: "notes",
      description: "Free-form notes or interaction summary.",
      schema: { type: "string" as const },
    },
    {
      name: "relationshipId",
      description: "Target relationship id.",
      schema: { type: "string" as const },
    },
    {
      name: "followUpId",
      description: "Target follow-up id.",
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Reason or purpose for a follow-up.",
      schema: { type: "string" as const },
    },
    {
      name: "dueAt",
      description: "ISO-8601 due time for a follow-up.",
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Optional explicit confirmation flag.",
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me my contacts." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 3 contacts: ...",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Add Alice to my Rolodex, her Telegram handle is @alice.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Added Alice (telegram: @alice) to your Rolodex.",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Log that I spoke with Bob today about the project.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Logged interaction with Bob on telegram.",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remind me to follow up with Carol next Monday about the contract.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Scheduled follow-up for 2026-04-20T09:00:00Z: the contract.",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What follow-ups do I have today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 2 follow-ups due: ...",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "How long has it been since I talked to Dan?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "It has been 14 days since you contacted Dan.",
          action: "RELATIONSHIP",
        },
      },
    ],
  ],
};
