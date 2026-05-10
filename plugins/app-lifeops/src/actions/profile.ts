import type {
  Action,
  ActionExample,
  ActionParameterSchema,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  type OwnerFactProvenance,
  type OwnerFactsPatch,
  resolveOwnerFactStore,
} from "../lifeops/owner/fact-store.js";
import { normalizeLifeOpsOwnerProfilePatch } from "../lifeops/owner-profile.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";

type ProfileSubaction = "save" | "capture_phone";

type ProfileSaveParams = {
  key?: string;
  value?: unknown;
  name?: string;
  relationshipStatus?: string;
  partnerName?: string;
  orientation?: string;
  gender?: string;
  age?: string;
  location?: string;
  travelBookingPreferences?: string;
};

type ProfileCapturePhoneParams = {
  phoneNumber: string;
  allowSms?: boolean;
  allowVoice?: boolean;
};

type ProfileParams = {
  subaction?: ProfileSubaction;
} & ProfileSaveParams &
  Partial<ProfileCapturePhoneParams>;

// Wave-2 W2-A collapsed PROFILE.save ≡ PROFILE.set into a single
// canonical `save` subaction. The legacy `set` spelling is normalized
// onto `save` in `normalizePlannerProfileParams` so old callers keep
// resolving while the planner converges on a single name.
const SUBACTIONS = {
  save: {
    description:
      "Persist stable owner facts: name, location, gender, age, relationship status, travel-booking preferences. Also accepts the legacy planner alias `set` (canonicalized to `save`).",
    descriptionCompressed:
      "persist stable owner fact: name location gender age relationship-status travel-booking-prefs",
    required: [],
    optional: [
      "key",
      "value",
      "name",
      "location",
      "gender",
      "age",
      "relationshipStatus",
      "travelBookingPreferences",
    ],
  },
  capture_phone: {
    description:
      "Persist owner phone number for SMS or voice escalation routing.",
    descriptionCompressed:
      "persist owner phone number for SMS/escalation routing",
    required: ["phoneNumber"],
    optional: ["allowSms", "allowVoice"],
  },
} as const satisfies SubactionsMap<ProfileSubaction>;

function formatGenericProfileValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entryValue]) => entryValue !== undefined && entryValue !== null,
      )
      .map(([entryKey, entryValue]) => {
        const label = entryKey.replace(/[_-]+/g, " ");
        if (typeof entryValue === "boolean") {
          return entryValue ? label : `not ${label}`;
        }
        return `${label}: ${String(entryValue)}`;
      });
    return entries.length > 0 ? entries.join("; ") : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function normalizePlannerProfileParams(
  params: ProfileParams,
  message: Memory,
): ProfileParams {
  const normalized: ProfileParams = { ...params };
  // Wave-2 W2-A: collapse the legacy `set` alias onto the canonical
  // `save` subaction.
  if ((normalized.subaction as unknown) === "set") {
    normalized.subaction = "save";
  }

  const key = typeof params.key === "string" ? params.key.toLowerCase() : "";
  const text =
    typeof message.content?.text === "string" ? message.content.text : "";
  const looksLikeTravelPreference =
    /\b(?:travel|booking|flight|seat|hotel|venue|carry[-\s]?on)\b/i.test(key) ||
    /\b(?:travel|booking|flight|seat|hotel|venue|carry[-\s]?on)\b/i.test(text);
  if (!normalized.travelBookingPreferences && looksLikeTravelPreference) {
    normalized.travelBookingPreferences =
      formatGenericProfileValue(params.value) ||
      text.replace(/^\s*(?:remember\s+that|save|store)\s+/i, "").trim();
  }

  return normalized;
}

function makeProfileProvenance(intent: string): OwnerFactProvenance {
  const provenance: OwnerFactProvenance = {
    source: "profile_save",
    recordedAt: new Date().toISOString(),
  };
  if (intent.length > 0) {
    provenance.note = intent.slice(0, 200);
  }
  return provenance;
}

function legacyPatchToFactPatch(
  legacy: ReturnType<typeof normalizeLifeOpsOwnerProfilePatch>,
): OwnerFactsPatch {
  const patch: OwnerFactsPatch = {};
  if (typeof legacy.name === "string") patch.preferredName = legacy.name;
  if (typeof legacy.relationshipStatus === "string") {
    patch.relationshipStatus = legacy.relationshipStatus;
  }
  if (typeof legacy.partnerName === "string") {
    patch.partnerName = legacy.partnerName;
  }
  if (typeof legacy.orientation === "string") {
    patch.orientation = legacy.orientation;
  }
  if (typeof legacy.gender === "string") patch.gender = legacy.gender;
  if (typeof legacy.age === "string") patch.age = legacy.age;
  if (typeof legacy.location === "string") patch.location = legacy.location;
  if (typeof legacy.travelBookingPreferences === "string") {
    patch.travelBookingPreferences = legacy.travelBookingPreferences;
  }
  return patch;
}

async function handleSave(
  runtime: IAgentRuntime,
  params: ProfileParams,
  message: Memory,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const legacyPatch = normalizeLifeOpsOwnerProfilePatch(params);
  if (Object.keys(legacyPatch).length === 0) {
    return {
      text: "Tell me the stable owner detail you want saved, such as your preferred name, location, relationship status, or reusable travel preferences.",
      success: false,
      data: { error: "NO_FIELDS" },
    };
  }
  const factPatch = legacyPatchToFactPatch(legacyPatch);
  if (Object.keys(factPatch).length === 0) {
    return {
      text: "Tell me the stable owner detail you want saved, such as your preferred name, location, relationship status, or reusable travel preferences.",
      success: false,
      data: { error: "NO_FIELDS" },
    };
  }
  const intent =
    typeof message.content?.text === "string" ? message.content.text : "";
  const factStore = resolveOwnerFactStore(runtime);
  const facts = await factStore.update(
    factPatch,
    makeProfileProvenance(intent),
  );
  const updatedFields = Object.keys(factPatch);
  const text =
    updatedFields.length === 1
      ? `Updated ${updatedFields[0]}.`
      : `Updated ${updatedFields.length} owner profile fields: ${updatedFields.join(", ")}.`;
  return {
    text,
    success: true,
    data: { facts, updatedFields },
  };
}

async function handleCapturePhone(
  params: ProfileParams,
  runtime: IAgentRuntime,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const phoneNumber = params.phoneNumber;
  if (!phoneNumber) {
    return {
      success: false,
      text: "I need a phone number to set up SMS or voice contact.",
    };
  }
  const allowSms = params.allowSms ?? true;
  const allowVoice = params.allowVoice ?? false;
  const service = new LifeOpsService(runtime);
  const result = await service.capturePhoneConsent({
    phoneNumber,
    consentGiven: true,
    allowSms,
    allowVoice,
    privacyClass: "private",
  });
  const channels: string[] = [];
  if (allowSms) channels.push("SMS");
  if (allowVoice) channels.push("voice calls");
  return {
    success: true,
    text: `Phone number ${result.phoneNumber} saved. Enabled for: ${channels.join(" and ") || "reminders"}.`,
    data: { result },
  };
}

export const profileAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "PROFILE",
  similes: [
    "REMEMBER_ABOUT_ME",
    "SAVE_MY_NAME",
    "SAVE_MY_LOCATION",
    "SAVE_TRAVEL_PREFERENCES",
    "REMEMBER_PREFERENCES",
    "CAPTURE_PHONE",
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
    "Owner-only. Persist stable owner facts and preferences: name, location, gender, age, relationship status, travel-booking preferences (save subaction); phone number (capture_phone). Reminder intensity and escalation rules live on LIFE.policy_set_reminder / LIFE.policy_configure_escalation.",
  descriptionCompressed:
    "persist owner state: save(name,location,age,prefs) + capture_phone(number); reminder/escalation policy lives on LIFE.policy_*",
  routingHint:
    'durable owner facts, reusable preferences, travel/booking preferences ("remember I prefer aisle seats", "save my hotel preferences") -> PROFILE; reminder intensity / escalation rules -> LIFE.policy_*; never use extraction/memory side effects/REPLY',
  contexts: ["memory", "contacts", "tasks", "settings", "calendar"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  handler: async (runtime, message, state, options) => {
    const rawParams =
      ((options as HandlerOptions | undefined)?.parameters as ProfileParams) ??
      ({} as ProfileParams);
    const normalizedRawParams = normalizePlannerProfileParams(
      rawParams,
      message,
    );
    const normalizedOptions: HandlerOptions | undefined = options
      ? ({
          ...options,
          parameters: normalizedRawParams as HandlerOptions["parameters"],
        } as HandlerOptions)
      : ({
          parameters: normalizedRawParams as HandlerOptions["parameters"],
        } as HandlerOptions);
    const resolved = await resolveActionArgs<ProfileSubaction, ProfileParams>({
      runtime,
      message,
      state: state ?? undefined,
      options: normalizedOptions,
      actionName: "PROFILE",
      subactions: SUBACTIONS,
      defaultSubaction: "save",
    });

    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        data: {
          error: "MISSING_PROFILE_FIELDS",
          missing: resolved.missing,
        },
      };
    }

    const params = resolved.params;

    switch (resolved.subaction) {
      case "save":
        return handleSave(
          runtime,
          { ...normalizedRawParams, ...params },
          message,
        );
      case "capture_phone":
        return handleCapturePhone(params, runtime);
    }
  },

  parameters: [
    {
      name: "subaction",
      description:
        "Which profile operation to perform: save or capture_phone. The legacy `set` alias is canonicalized to `save`.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["save", "capture_phone"],
      },
    },
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
      description: "Partner's name when known.",
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
      description: "Reusable flight and hotel preference checklist or summary.",
      schema: { type: "string" as const },
    },
    {
      name: "key",
      description:
        "Compatibility alias for generic profile set calls. Prefer explicit fields such as travelBookingPreferences.",
      schema: { type: "string" as const },
    },
    {
      name: "value",
      description:
        "Compatibility value for generic profile set calls; normalized into explicit owner profile fields when possible.",
      schema: {
        type: "string" as const,
        anyOf: [
          { type: "string" as const },
          { type: "number" as const },
          { type: "boolean" as const },
          { type: "object" as const, additionalProperties: true },
        ],
      } as ActionParameterSchema,
    },
    {
      name: "phoneNumber",
      description: "Owner phone number for SMS/voice escalation routing.",
      schema: { type: "string" as const },
    },
    {
      name: "allowSms",
      description: "Allow SMS contact on the captured number.",
      schema: { type: "boolean" as const },
    },
    {
      name: "allowVoice",
      description: "Allow voice-call contact on the captured number.",
      schema: { type: "boolean" as const },
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
          text: "my number is 555-1234, you can text me there",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Phone number 555-1234 saved. Enabled for: SMS.",
        },
      },
    ],
  ] as ActionExample[][],
};
