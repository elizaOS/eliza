import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  UUID,
} from "@elizaos/core";
import { asUUID, logger } from "@elizaos/core";
import {
  type ContactInfo,
  getRelationshipsServiceLike,
  type RelationshipsServiceLike,
} from "../followup-tracker.js";

interface MarkFollowupDoneParams {
  contactId?: unknown;
  contactName?: unknown;
  note?: unknown;
}

interface ContactMatch {
  contact: ContactInfo;
  displayName: string;
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

async function findByName(
  runtime: IAgentRuntime,
  service: RelationshipsServiceLike,
  rawName: string,
): Promise<ContactMatch[]> {
  const needle = rawName.trim().toLowerCase();
  if (needle.length === 0) return [];
  const contacts = await service.searchContacts({});
  const matches: ContactMatch[] = [];
  for (const contact of contacts) {
    const displayName = await resolveDisplayName(runtime, contact);
    if (displayName.toLowerCase().includes(needle)) {
      matches.push({ contact, displayName });
    }
  }
  return matches;
}

export const markFollowupDoneAction: Action = {
  name: "MARK_FOLLOWUP_DONE",
  similes: [
    "FOLLOWED_UP",
    "FOLLOWUP_DONE",
    "CONTACTED",
    "MARK_CONTACTED",
    "RECORD_INTERACTION",
  ],
  description:
    "Mark a contact as already followed-up-with (updates lastContactedAt to now). " +
    "Use this only when the interaction already happened, not for future reminders. " +
    "Requires either an explicit contactId (UUID) or an unambiguous contactName. " +
    "Ambiguous names return a clarifying response without modifying any contact.",
  contexts: ["contacts", "tasks", "calendar", "messaging"],
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options?: HandlerOptions,
  ) => {
    const params = (options?.parameters ?? {}) as MarkFollowupDoneParams;
    const contactId =
      typeof params.contactId === "string" && params.contactId.length > 0
        ? params.contactId
        : null;
    const contactName =
      typeof params.contactName === "string" ? params.contactName : "";
    const note = typeof params.note === "string" ? params.note : undefined;

    const service = getRelationshipsServiceLike(runtime);
    if (!service) {
      return {
        success: false,
        text: "Cannot mark follow-up: RelationshipsService is not available.",
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
      const matches = await findByName(runtime, service, contactName);
      if (matches.length === 0) {
        return {
          success: false,
          text: `No contact found matching "${contactName}".`,
        };
      }
      if (matches.length > 1) {
        const candidateNames = matches
          .map((m) => `${m.displayName} (${m.contact.entityId})`)
          .join(", ");
        return {
          success: false,
          text: `Ambiguous contact name "${contactName}" — matches ${matches.length} contacts: ${candidateNames}. Please specify contactId.`,
          data: {
            ambiguous: true,
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
          text: `No contact found matching "${contactName}".`,
        };
      }
      resolvedContact = match.contact;
      resolvedDisplayName = match.displayName;
    } else {
      return {
        success: false,
        text: "MARK_FOLLOWUP_DONE requires either contactId or contactName.",
      };
    }

    const nowIso = new Date().toISOString();
    const nextFields: Record<string, string> = {
      ...(resolvedContact.customFields as Record<string, string>),
      lastContactedAt: nowIso,
    };
    if (note) {
      nextFields.lastFollowupNote = note;
    }
    await service.updateContact(resolvedContact.entityId, {
      customFields: nextFields,
    });

    logger.info(
      `[MARK_FOLLOWUP_DONE] Marked ${resolvedDisplayName} (${resolvedContact.entityId}) as contacted at ${nowIso}`,
    );

    return {
      success: true,
      text: `Marked ${resolvedDisplayName} as followed up at ${nowIso}.`,
      data: {
        entityId: String(resolvedContact.entityId),
        displayName: resolvedDisplayName,
        lastContactedAt: nowIso,
      },
    };
  },
  parameters: [
    {
      name: "contactId",
      description:
        "UUID of the contact. Preferred when known — eliminates name ambiguity.",
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
      name: "note",
      description: "Optional note about the interaction.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "I just talked to Alice, mark it done" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Marked Alice Chen as followed up at ...",
          action: "MARK_FOLLOWUP_DONE",
        },
      },
    ],
  ] as ActionExample[][],
};
