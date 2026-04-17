import type { Action, HandlerOptions } from "@elizaos/core";
import {
  normalizeLifeOpsOwnerProfilePatch,
  persistConfiguredOwnerName,
  updateLifeOpsOwnerProfile,
} from "../lifeops/owner-profile.js";
import { hasOwnerAccess } from "@elizaos/agent/security/access";

type OwnerProfileParameters = {
  name?: string;
  relationshipStatus?: string;
  partnerName?: string;
  orientation?: string;
  gender?: string;
  age?: string;
  location?: string;
};

function extractOwnerProfilePatchFromText(
  text: string | undefined,
): OwnerProfileParameters {
  if (!text) {
    return {};
  }

  const patch: OwnerProfileParameters = {};
  const readMatch = (pattern: RegExp): string | undefined => {
    const match = text.match(pattern);
    return match?.[1]?.trim();
  };

  patch.name = readMatch(/\bname\s*[:=]\s*([^,.;\n]+)/i);
  patch.relationshipStatus = readMatch(
    /\brelationship(?:\s+status)?\s*[:=]\s*([^,.;\n]+)/i,
  );
  patch.partnerName = readMatch(/\bpartner(?:\s+name)?\s*[:=]\s*([^,.;\n]+)/i);
  patch.orientation = readMatch(/\borientation\s*[:=]\s*([^,.;\n]+)/i);
  patch.gender = readMatch(/\bgender\s*[:=]\s*([^,.;\n]+)/i);
  patch.age =
    readMatch(/\bage\s*[:=]\s*(\d{1,3})\b/i) ??
    readMatch(/\bi(?: am|'m)\s+(\d{1,3})\s+years?\s+old\b/i) ??
    readMatch(/\bmy age is\s+(\d{1,3})\b/i);
  patch.location =
    readMatch(/\blocation\s*[:=]\s*([^,.;\n]+)/i) ??
    readMatch(/\bi live in\s+([^,.;\n]+)/i);

  return patch;
}

export const updateOwnerProfileAction: Action = {
  name: "UPDATE_OWNER_PROFILE",
  similes: [
    "SAVE_OWNER_PROFILE",
    "SET_OWNER_PROFILE",
    "UPDATE_USER_PROFILE",
    "SAVE_USER_PROFILE",
  ],
  description:
    "Silently persist stable, owner-only LifeOps profile details when the canonical owner clearly states or confirms them. " +
    "Use only for the owner, never for other contacts, and do not ask follow-up questions just to fill these fields.",
  descriptionCompressed: "Persist stable owner profile details when stated/confirmed. Owner only.",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        data: { error: "PERMISSION_DENIED" },
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters as
      | OwnerProfileParameters
      | undefined;
    const content = message.content as Record<string, unknown> | undefined;
    const extractedFromText = extractOwnerProfilePatchFromText(
      typeof content?.text === "string" ? content.text : undefined,
    );
    const patch = normalizeLifeOpsOwnerProfilePatch({
      ...extractedFromText,
      ...(params ?? {}),
    });

    if (Object.keys(patch).length === 0) {
      return {
        text: "",
        success: false,
        data: { error: "NO_FIELDS" },
      };
    }

    try {
      const profile = await updateLifeOpsOwnerProfile(runtime, patch);
      if (!profile) {
        return {
          text: "",
          success: false,
          data: { error: "PROFILE_UPDATE_FAILED" },
        };
      }

      const nameSyncSaved =
        typeof patch.name === "string"
          ? await persistConfiguredOwnerName(patch.name)
          : null;

      return {
        text: "",
        success: true,
        data: {
          profile,
          updatedFields: Object.keys(patch),
          nameSyncSaved,
        },
      };
    } catch (error) {
      return {
        text: "",
        success: false,
        data: {
          error: "PROFILE_UPDATE_FAILED",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },

  parameters: [
    {
      name: "name",
      description: "The owner's preferred name.",

      schema: { type: "string" as const },
    },
    {
      name: "relationshipStatus",
      description:
        "Relationship status such as single, partnered, married, or n/a.",

      schema: { type: "string" as const },
    },
    {
      name: "partnerName",
      description: "Partner's name when known, otherwise omit or use n/a.",

      schema: { type: "string" as const },
    },
    {
      name: "orientation",
      description: "Owner orientation when clearly stated.",

      schema: { type: "string" as const },
    },
    {
      name: "gender",
      description: "Owner gender when clearly stated.",

      schema: { type: "string" as const },
    },
    {
      name: "age",
      description: "Owner age or stable age descriptor when clearly stated.",

      schema: { type: "string" as const },
    },
    {
      name: "location",
      description: "Owner location when clearly stated.",

      schema: { type: "string" as const },
    },
  ],
};
