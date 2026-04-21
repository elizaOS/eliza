import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import {
  normalizeLifeOpsOwnerProfilePatch,
  persistConfiguredOwnerName,
  updateLifeOpsOwnerProfile,
} from "../lifeops/owner-profile.js";
import { hasOwnerAccess } from "@elizaos/agent/security";

type OwnerProfileParameters = {
  name?: string;
  relationshipStatus?: string;
  partnerName?: string;
  orientation?: string;
  gender?: string;
  age?: string;
  location?: string;
  travelBookingPreferences?: string;
};

export const updateOwnerProfileAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "UPDATE_OWNER_PROFILE",
  similes: [
    "SAVE_OWNER_PROFILE",
    "SET_OWNER_PROFILE",
    "UPDATE_USER_PROFILE",
    "SAVE_USER_PROFILE",
    "REMEMBER_ABOUT_ME",
    "SAVE_ABOUT_ME",
    "SAVE_MY_LOCATION",
    "SAVE_MY_NAME",
    "SAVE_STABLE_FACTS",
    "REMEMBER_MY_PREFERENCES",
    "REMEMBER_TRAVEL_PREFERENCES",
    "SAVE_TRAVEL_PREFERENCES",
    "TRAVEL_PROFILE",
    "BOOKING_PREFERENCES",
    "CAPTURE_TRAVEL_PREFERENCES",
    "CAPTURE_BOOKING_PREFERENCES",
  ],
  tags: [
    "always-include",
    "travel preferences",
    "flight preferences",
    "hotel preferences",
    "booking preferences",
    "owner profile",
  ],
  description:
    "Silently persist stable, owner-only LifeOps profile details when the canonical owner clearly states or confirms them. " +
    "Use only for the owner, never for other contacts, and do not ask follow-up questions just to fill these fields. " +
    "This includes durable travel-booking preferences or a reusable travel-preference checklist when the owner wants those preferences remembered for future bookings. " +
    "Requests like 'set up a list of my flight and hotel preferences so you do not have to ask every time' belong here even when the action still needs to gather the actual preference list. " +
    "Do not use this for todos, goals, reminders, temporary plans, or live task state.",
  descriptionCompressed:
    "Persist stable owner facts and reusable preferences when stated or confirmed. Owner only.",
  suppressPostActionContinuation: true,

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
    const patch = normalizeLifeOpsOwnerProfilePatch(params ?? {});

    if (Object.keys(patch).length === 0) {
      return {
        text: "Tell me the stable owner detail you want saved, such as your preferred name, location, relationship status, or reusable travel preferences.",
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

      const updatedFields = Object.keys(patch);
      const text =
        updatedFields.length === 1
          ? `Updated ${updatedFields[0]}.`
          : `Updated ${updatedFields.length} owner profile fields: ${updatedFields.join(", ")}.`;
      return {
        text,
        success: true,
        data: {
          profile,
          updatedFields,
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
    {
      name: "travelBookingPreferences",
      description:
        "Reusable flight and hotel preference checklist or summary to remember for future bookings.",

      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remember that my name is Shaw and I'm based in Los Angeles.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Stored your stable owner details so I can reuse them in future LifeOps workflows.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Set up a list of my flight and hotel preferences so you don't have to ask every time.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll store a reusable travel-preference checklist on your owner profile covering flight class, seat, luggage, hotel budget, distance tolerance, and trip-extension preference so future booking flows can reuse it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remember that I prefer aisle seats, carry-on only, moderate hotels close to the venue, and I'm open to staying an extra night if it makes the trip easier.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Stored your travel-booking preferences on the owner profile for future flight and hotel bookings.",
        },
      },
    ],
  ] as ActionExample[][],
};
