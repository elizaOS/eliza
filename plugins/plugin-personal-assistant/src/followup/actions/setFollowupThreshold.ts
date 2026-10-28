/**
 * SET_FOLLOWUP_THRESHOLD action — sets the per-contact follow-up interval (in
 * days) that governs when a relationship counts as overdue, persisting it via
 * the RelationshipsService for the tracker to read on its next tick.
 */
import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  UUID,
} from "@elizaos/core";
import {
  asUUID,
  describeUserReference,
  logger,
  userReferenceLogView,
} from "@elizaos/core";
import {
  type ContactInfo,
  getRelationshipsServiceLike,
} from "../followup-tracker.js";

// Blob-safe rendering rationale lives in core's utils/reference-echo.ts.
const describeContactName = (name: string): string =>
  describeUserReference(name, "that contact");

interface SetFollowupThresholdParams {
  contactId?: unknown;
  contactName?: unknown;
  thresholdDays?: unknown;
}

// Han/Kana/Hangul letters do not count as word characters so names can abut
// particles ("김민준은"). Mirrors the whole-word matcher merged for app-block
// (#35709) in this plugin.
const WORD_CHAR_SOURCE =
  "(?:(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])[\\p{L}\\p{M}\\p{N}])";

function includesWholePhrase(text: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const body = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(
    `(?<!${WORD_CHAR_SOURCE})${body}(?!${WORD_CHAR_SOURCE})`,
    "iu",
  ).test(text);
}

async function resolveDisplayName(
  runtime: IAgentRuntime,
  contact: ContactInfo,
): Promise<string> {
  const explicit = contact.customFields.displayName;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const entity = await runtime.getEntityById(contact.entityId);
  return entity?.names?.[0] ?? String(contact.entityId);
}

export const setFollowupThresholdAction: Action = {
  name: "SET_FOLLOWUP_THRESHOLD",
  similes: [
    "FOLLOWUP_RULE",
    "CHANGE_FOLLOWUP_INTERVAL",
    "SET_CONTACT_FREQUENCY_DAYS",
    // PRD action-catalog alias.
    "FOLLOWUP_CREATE_RULE",
  ],
  description:
    "Set a recurring follow-up cadence threshold (in days) for a specific contact. " +
    "Use this for durable rules like 'every 14 days', not one-off reminders like 'next week'. " +
    "Requires a positive integer threshold and either contactId or an unambiguous contactName.",
  contexts: ["contacts", "tasks", "calendar", "settings"],
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options?: HandlerOptions,
  ) => {
    const params = (options?.parameters ?? {}) as SetFollowupThresholdParams;
    const contactId =
      typeof params.contactId === "string" && params.contactId.length > 0
        ? params.contactId
        : null;
    const contactName =
      typeof params.contactName === "string" ? params.contactName : "";
    const rawThreshold = params.thresholdDays;
    const thresholdDays =
      typeof rawThreshold === "number"
        ? rawThreshold
        : typeof rawThreshold === "string"
          ? Number(rawThreshold)
          : Number.NaN;

    if (!Number.isInteger(thresholdDays) || thresholdDays < 1) {
      return {
        success: false,
        text: "SET_FOLLOWUP_THRESHOLD requires a positive integer thresholdDays.",
      };
    }

    const service = getRelationshipsServiceLike(runtime);
    if (!service) {
      return {
        success: false,
        text: "Cannot set follow-up threshold: RelationshipsService is not available.",
      };
    }

    let resolvedContact: ContactInfo | null = null;
    let resolvedDisplayName = "";

    if (contactId) {
      let typedId: UUID;
      try {
        typedId = asUUID(contactId);
      } catch {
        return {
          success: false,
          text: `Invalid contactId: ${contactId}. Must be a UUID.`,
        };
      }
      resolvedContact = await service.getContact(typedId);
      if (!resolvedContact) {
        return {
          success: false,
          text: `No contact found with id ${contactId}.`,
        };
      }
      resolvedDisplayName = await resolveDisplayName(runtime, resolvedContact);
    } else if (contactName.trim().length > 0) {
      const needle = contactName.trim().toLowerCase();
      const contacts = await service.searchContacts({});
      const substringMatches: Array<{
        contact: ContactInfo;
        displayName: string;
      }> = [];
      const wholeWordMatches: Array<{
        contact: ContactInfo;
        displayName: string;
      }> = [];
      for (const contact of contacts) {
        const displayName = await resolveDisplayName(runtime, contact);
        if (displayName.toLowerCase().includes(needle)) {
          const match = { contact, displayName };
          substringMatches.push(match);
          if (includesWholePhrase(displayName, needle)) {
            wholeWordMatches.push(match);
          }
        }
      }
      // A whole-word hit outranks substring hits ("Ann" names Ann Lee, not
      // Joanne Park), mirroring merged #35741/#35729; the substring tier
      // stays for genuine fragments ("Joann") when no whole-word hit exists.
      const matches =
        wholeWordMatches.length > 0 ? wholeWordMatches : substringMatches;
      if (matches.length === 0) {
        return {
          success: false,
          text: `No contact found matching ${describeContactName(contactName)}.`,
          data: { contactName: userReferenceLogView(contactName) },
        };
      }
      if (matches.length > 1) {
        const candidateNames = matches
          .map((m) => `${m.displayName} (${m.contact.entityId})`)
          .join(", ");
        return {
          success: false,
          text: `Ambiguous contact name ${describeContactName(contactName)} — matches ${matches.length} contacts: ${candidateNames}. Please specify contactId.`,
          data: {
            ambiguous: true,
            contactName: userReferenceLogView(contactName),
            candidates: matches.map((m) => ({
              entityId: String(m.contact.entityId),
              displayName: m.displayName,
            })),
          },
        };
      }
      const match = matches[0];
      if (!match) {
        return {
          success: false,
          text: `No contact found matching ${describeContactName(contactName)}.`,
          data: { contactName: userReferenceLogView(contactName) },
        };
      }
      resolvedContact = match.contact;
      resolvedDisplayName = match.displayName;
    } else {
      return {
        success: false,
        text: "SET_FOLLOWUP_THRESHOLD requires either contactId or contactName.",
      };
    }

    const nextFields: Record<string, string | number> = {
      ...(resolvedContact.customFields as Record<string, string | number>),
      followupThresholdDays: thresholdDays,
    };
    await service.updateContact(resolvedContact.entityId, {
      customFields: nextFields,
    });

    logger.info(
      `[SET_FOLLOWUP_THRESHOLD] Set ${resolvedDisplayName} (${resolvedContact.entityId}) threshold to ${thresholdDays} days`,
    );

    return {
      success: true,
      text: `Set follow-up threshold for ${resolvedDisplayName} to ${thresholdDays} days.`,
      data: {
        entityId: String(resolvedContact.entityId),
        displayName: resolvedDisplayName,
        thresholdDays: thresholdDays,
      },
    };
  },
  parameters: [
    {
      name: "contactId",
      description: "UUID of the contact. Preferred when known.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "contactName",
      description:
        "Human-readable contact name. Must be unambiguous across stored contacts.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "thresholdDays",
      description:
        "Whole number of days (1 or more) after last contact before this contact is considered overdue.",
      required: true,
      schema: { type: "integer" as const, minimum: 1 },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Remind me to follow up with Dana every 14 days" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Set follow-up threshold for Dana Park to 14 days.",
          action: "SET_FOLLOWUP_THRESHOLD",
        },
      },
    ],
  ] as ActionExample[][],
};
