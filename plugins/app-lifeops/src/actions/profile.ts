import type {
  Action,
  ActionExample,
  ActionParameterSchema,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import type {
  LifeOpsDomain,
  LifeOpsReminderStep,
  SetLifeOpsReminderPreferenceRequest,
} from "../contracts/index.js";
import {
  normalizeLifeOpsOwnerProfilePatch,
  persistConfiguredOwnerName,
  updateLifeOpsOwnerProfile,
} from "../lifeops/owner-profile.js";
import { LifeOpsService } from "../lifeops/service.js";
import { extractReminderIntensityWithLlm } from "./lib/extract-task-plan.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";
import { resolveDefinitionFromIntent } from "./life.js";

type ProfileSubaction =
  | "save"
  | "set"
  | "capture_phone"
  | "set_reminder_preference"
  | "configure_escalation";

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

type ProfileSetReminderPreferenceParams = {
  intensity?: "minimal" | "normal" | "persistent" | "high_priority_only";
  target?: string;
  intent?: string;
  details?: Record<string, unknown>;
};

type ProfileConfigureEscalationParams = {
  target?: string;
  timeoutMinutes?: number;
  callAfterMinutes?: number;
  details?: Record<string, unknown>;
};

type ProfileParams = {
  subaction?: ProfileSubaction;
} & ProfileSaveParams &
  Partial<ProfileCapturePhoneParams> &
  ProfileSetReminderPreferenceParams &
  ProfileConfigureEscalationParams;

const SUBACTIONS = {
  save: {
    description:
      "Persist stable owner facts: name, location, gender, age, relationship status, travel-booking preferences.",
    descriptionCompressed:
      "persist stable owner fact: name location gender age relationship-status travel-booking-prefs",
    required: [],
    optional: [
      "name",
      "location",
      "gender",
      "age",
      "relationshipStatus",
      "travelBookingPreferences",
    ],
  },
  set: {
    description:
      "Compatibility alias for save. Persist stable owner facts or reusable preferences.",
    descriptionCompressed:
      "alias save owner profile fact/preference; normalize key/value when present",
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
  set_reminder_preference: {
    description:
      "Set reminder intensity (minimal | normal | persistent | high_priority_only); optional per-definition target.",
    descriptionCompressed:
      "set reminder intensity: minimal|normal|persistent|high_priority_only",
    required: ["intensity"],
    optional: ["target", "intent", "details"],
  },
  configure_escalation: {
    description:
      "Set escalation rules (timeoutMinutes, callAfterMinutes) for a definition or globally.",
    descriptionCompressed:
      "set escalation rules: timeout-minutes call-after-no-response etc",
    required: [],
    optional: ["target", "timeoutMinutes", "callAfterMinutes", "details"],
  },
} as const satisfies SubactionsMap<ProfileSubaction>;

function detailRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function detailString(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function _detailBoolean(
  source: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function detailArray(
  source: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  const value = source?.[key];
  return Array.isArray(value) ? value : undefined;
}

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
  if (normalized.subaction === "set") {
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

async function handleSave(
  runtime: IAgentRuntime,
  params: ProfileParams,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const patch = normalizeLifeOpsOwnerProfilePatch(params);
  if (Object.keys(patch).length === 0) {
    return {
      text: "Tell me the stable owner detail you want saved, such as your preferred name, location, relationship status, or reusable travel preferences.",
      success: false,
      data: { error: "NO_FIELDS" },
    };
  }
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
    data: { profile, updatedFields, nameSyncSaved },
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

async function handleSetReminderPreference(
  runtime: IAgentRuntime,
  params: ProfileParams,
  message: Memory,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const details = detailRecord(params.details);
  const intent =
    params.intent?.trim() ||
    (typeof message.content?.text === "string"
      ? message.content.text.trim()
      : "");

  let intensity: SetLifeOpsReminderPreferenceRequest["intensity"] | "unknown" =
    params.intensity ?? "unknown";
  if (intensity === "unknown") {
    const plan = await extractReminderIntensityWithLlm({ runtime, intent });
    intensity = plan.intensity;
  }
  if (intensity === "unknown") {
    return {
      success: false,
      text: "I need to know whether you want reminders minimal, normal, persistent, or high priority only.",
    };
  }

  const service = new LifeOpsService(runtime);
  const domain = detailString(details, "domain") as LifeOpsDomain | undefined;
  const target = await resolveDefinitionFromIntent(
    service,
    params.target,
    intent,
    domain,
  );
  const request: SetLifeOpsReminderPreferenceRequest = {
    intensity,
    definitionId: target?.definition.id ?? null,
    note: intent,
  };
  const preference = await service.setReminderPreference(request);
  const intensityLabel =
    intensity === "high_priority_only"
      ? "high priority only"
      : preference.effective.intensity;
  if (target) {
    return {
      success: true,
      text: `Reminder intensity for "${target.definition.title}" is now ${intensityLabel}.`,
      data: { preference },
    };
  }
  return {
    success: true,
    text: `Global LifeOps reminders are now ${intensityLabel}.`,
    data: { preference },
  };
}

async function handleConfigureEscalation(
  runtime: IAgentRuntime,
  params: ProfileParams,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const details = detailRecord(params.details);
  const service = new LifeOpsService(runtime);
  const domain = detailString(details, "domain") as LifeOpsDomain | undefined;

  // Target a specific definition when supplied; otherwise treat as a
  // global escalation profile-update (currently no-op until a global
  // escalation contract exists — return a structured ack).
  if (!params.target) {
    return {
      success: true,
      text: "No target supplied; global escalation defaults are unchanged.",
      data: {
        timeoutMinutes: params.timeoutMinutes ?? null,
        callAfterMinutes: params.callAfterMinutes ?? null,
      },
    };
  }
  const target = await resolveDefinitionFromIntent(
    service,
    params.target,
    params.target,
    domain,
  );
  if (!target) {
    return {
      success: false,
      text: "I could not find that item to configure its escalation.",
    };
  }
  const ownership =
    target.definition.domain === "agent_ops"
      ? { domain: "agent_ops" as const, subjectType: "agent" as const }
      : { domain: "user_lifeops" as const, subjectType: "owner" as const };
  const rawSteps =
    detailArray(details, "steps") ?? detailArray(details, "escalationSteps");
  const steps: LifeOpsReminderStep[] = rawSteps
    ? rawSteps
        .filter(
          (s): s is Record<string, unknown> =>
            typeof s === "object" && s !== null,
        )
        .map((s) => ({
          channel: String(
            s.channel ?? "in_app",
          ) as LifeOpsReminderStep["channel"],
          offsetMinutes:
            typeof s.offsetMinutes === "number" ? s.offsetMinutes : 0,
          label:
            typeof s.label === "string"
              ? s.label
              : String(s.channel ?? "reminder"),
        }))
    : [{ channel: "in_app", offsetMinutes: 0, label: "In-app reminder" }];
  const updated = await service.updateDefinition(target.definition.id, {
    ownership,
    reminderPlan: { steps },
  });
  const summary = steps
    .map((s) => `${s.channel} at +${s.offsetMinutes}m`)
    .join(", ");
  return {
    success: true,
    text: `Updated reminder plan for "${updated.definition.title}": ${summary}.`,
    data: { updated },
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
    "CONFIGURE_ESCALATION",
    "SET_REMINDER_INTENSITY",
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
    "Owner-only. Persist stable owner facts and preferences: name, location, gender, age, relationship status, travel-booking preferences (save subaction); phone number (capture_phone); reminder intensity (set_reminder_preference); escalation rules (configure_escalation). All operations are durable owner-scoped state.",
  descriptionCompressed:
    "persist owner state: save(name,location,age,prefs) + capture_phone(number) + set_reminder_preference(intensity) + configure_escalation(rules)",
  routingHint:
    'durable owner facts, reusable preferences, travel/booking preferences ("remember I prefer aisle seats", "save my hotel preferences") -> PROFILE; never use extraction/memory side effects/REPLY',
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
      case "set":
        return handleSave(runtime, { ...normalizedRawParams, ...params });
      case "capture_phone":
        return handleCapturePhone(params, runtime);
      case "set_reminder_preference":
        return handleSetReminderPreference(runtime, params, message);
      case "configure_escalation":
        return handleConfigureEscalation(runtime, params);
    }
  },

  parameters: [
    {
      name: "subaction",
      description:
        "Which profile operation to perform: save, set, capture_phone, set_reminder_preference, or configure_escalation.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "save",
          "set",
          "capture_phone",
          "set_reminder_preference",
          "configure_escalation",
        ],
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
    {
      name: "intensity",
      description:
        "Reminder intensity level: minimal, normal, persistent, or high_priority_only.",
      schema: {
        type: "string" as const,
        enum: ["minimal", "normal", "persistent", "high_priority_only"],
      },
    },
    {
      name: "target",
      description:
        "Optional definition name/ID for set_reminder_preference or configure_escalation.",
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Free-form intent text for the reminder-preference operation.",
      schema: { type: "string" as const },
    },
    {
      name: "timeoutMinutes",
      description:
        "Escalation timeout in minutes (used by configure_escalation).",
      schema: { type: "number" as const },
    },
    {
      name: "callAfterMinutes",
      description:
        "Minutes before escalating to a voice call (used by configure_escalation).",
      schema: { type: "number" as const },
    },
    {
      name: "details",
      description:
        "Structured data when needed: domain (user_lifeops/agent_ops), steps escalation list, etc.",
      schema: { type: "object" as const },
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
    [
      {
        name: "{{name1}}",
        content: {
          text: "less reminders please",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Global LifeOps reminders are now minimal.",
        },
      },
    ],
  ] as ActionExample[][],
};
