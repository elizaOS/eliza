import { hasAdminAccess, hasOwnerAccess } from "@elizaos/agent";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import { LifeOpsService } from "../lifeops/service.js";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioVoiceCall,
  type TwilioDeliveryResult,
} from "../lifeops/twilio.js";

const ACTION_NAME = "TWILIO_VOICE_CALL";

type TwilioCallParameters = {
  to?: string;
  message?: string;
  confirmed?: boolean;
};

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceBool(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

const E164_RE = /^\+[1-9]\d{1,14}$/;

const PLACEHOLDER_555_RE = /^\+?1?[-\s]?\(?5{3}\)?[-\s]?5{3}[-\s]?5{4}$/;

function isE164(value: string): boolean {
  return E164_RE.test(value);
}

function isPlaceholderOrNonNumeric(value: string): boolean {
  if (PLACEHOLDER_555_RE.test(value)) return true;
  // any letter indicates a natural-language phrase like "owner's cable company"
  if (/[a-zA-Z]/.test(value)) return true;
  return false;
}

function invalidPhoneResult(
  to: string,
  contact: string | undefined,
  actionName: string,
  errorCode: "INVALID_PHONE_NUMBER" | "PLACEHOLDER_PHONE_NUMBER",
): ActionResult {
  const subject = contact ?? "this contact";
  const text =
    errorCode === "PLACEHOLDER_PHONE_NUMBER"
      ? `"${to}" looks like a placeholder phone number. Please share the real E.164 number (e.g. +15551234567) for ${subject} before I can place the call.`
      : `I need a valid phone number in E.164 format (e.g. +15551234567) to place the call. Please confirm the number for ${subject}.`;
  return {
    text,
    success: false,
    values: { success: false, error: errorCode, to, contact: contact ?? null },
    data: { actionName, error: errorCode, to, contact: contact ?? null },
  };
}

export const twilioCallAction: Action = {
  name: ACTION_NAME,
  similes: [
    "CALL_ME",
    "PLACE_CALL",
    "VOICE_CALL",
    "TWILIO_CALL",
    "CALL_DENTIST",
    "PHONE_SUPPORT",
  ],
  description:
    "Place a voice call via Twilio. Use only for urgent escalations or " +
    "explicit voice-call requests from the owner. Use this for real phone " +
    "calls, not for calendar-only rescheduling or advice. Always drafts first; the " +
    "caller must pass confirmed: true to actually dial.",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (!readTwilioCredentialsFromEnv()) return false;
    return hasAdminAccess(runtime, message);
  },

  parameters: [
    {
      name: "to",
      description:
        "Destination phone number in E.164 format (e.g. +15551234567).",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "message",
      description:
        "Plaintext message to speak via TwiML. Will be XML-escaped before dispatch.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Set to true when the owner has explicitly confirmed the call should be placed.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Call me at +15551234567 and say the build is done" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft voice call to +15551234567:\n\n"The build is done."\n\nSay "confirm" to place the call.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "confirm" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Placing voice call to +15551234567." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Urgent: call +15550000000 and say the server is on fire",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft voice call to +15550000000:\n\n"The server is on fire."\n\nSay "confirm" to place the call.',
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner or admin may place voice calls.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const credentials = readTwilioCredentialsFromEnv();
    if (!credentials) {
      return {
        text: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
        success: false,
        values: { success: false, error: "TWILIO_NOT_CONFIGURED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as TwilioCallParameters;
    const to = coerceString(params.to);
    const messageBody = coerceString(params.message);
    const confirmed = coerceBool(params.confirmed);

    if (!to) {
      return {
        text: "Missing required parameter: to (E.164 phone number).",
        success: false,
        values: { success: false, error: "MISSING_TO" },
        data: { actionName: ACTION_NAME },
      };
    }
    if (isPlaceholderOrNonNumeric(to)) {
      return invalidPhoneResult(
        to,
        undefined,
        ACTION_NAME,
        "PLACEHOLDER_PHONE_NUMBER",
      );
    }
    if (!isE164(to)) {
      return invalidPhoneResult(
        to,
        undefined,
        ACTION_NAME,
        "INVALID_PHONE_NUMBER",
      );
    }
    if (!messageBody) {
      return {
        text: "Missing required parameter: message.",
        success: false,
        values: { success: false, error: "MISSING_MESSAGE" },
        data: { actionName: ACTION_NAME },
      };
    }

    if (!confirmed) {
      return {
        text: `Draft voice call to ${to}:\n\n"${messageBody}"\n\nSay "confirm" or re-issue with confirmed: true to place the call.`,
        // The call was NOT placed — this is just a draft awaiting confirmation.
        success: false,
        values: {
          success: false,
          error: "DRAFT_REQUIRES_CONFIRMATION",
          draft: true,
          to,
          message: messageBody,
        },
        data: {
          actionName: ACTION_NAME,
          draft: true,
          to,
          message: messageBody,
        },
      };
    }

    const result = await sendTwilioVoiceCall({
      credentials,
      to,
      message: messageBody,
    });

    if (!result.ok) {
      return {
        text: `Voice call to ${to} failed: ${result.error ?? "unknown error"}.`,
        success: false,
        values: {
          success: false,
          error: result.error ?? "CALL_FAILED",
          status: result.status,
        },
        data: {
          actionName: ACTION_NAME,
          to,
          message: messageBody,
          status: result.status,
          retryCount: result.retryCount,
        },
      };
    }

    return {
      text: `Placed voice call to ${to}.`,
      success: true,
      values: {
        success: true,
        to,
        sid: result.sid ?? null,
      },
      data: {
        actionName: ACTION_NAME,
        to,
        message: messageBody,
        sid: result.sid ?? null,
        status: result.status,
        retryCount: result.retryCount,
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// T9e — CALL_USER / CALL_EXTERNAL with confirmation + allow-list gates.
//
// These are distinct from the generic TWILIO_VOICE_CALL action above:
//   - CALL_USER always dials the configured owner number (safety-fenced).
//   - CALL_EXTERNAL dials a third party only if it appears in the allow-list.
// Both require `confirmed: true` in parameters to actually dial.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_NUMBER_ENV_KEYS = [
  "MILADY_E2E_TWILIO_RECIPIENT",
  "TWILIO_OWNER_NUMBER",
] as const;
const EXTERNAL_ALLOWLIST_ENV_KEY = "TWILIO_CALL_EXTERNAL_ALLOWLIST";

type CallUserParameters = {
  confirmed?: boolean;
  message?: string;
};

type CallExternalParameters = {
  confirmed?: boolean;
  to?: string;
  message?: string;
  contact?: string;
};

type PendingCallDraft = {
  actionName: "CALL_USER" | "CALL_EXTERNAL";
  to?: string | null;
  message?: string | null;
  approvalTaskId?: string | null;
  createdAt: string;
};

function normalizeLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getPendingCallCacheKey(roomId: string, actionName: string): string {
  return `lifeops:twilio-call:pending:${actionName}:${roomId}`;
}

async function readPendingCallDraft(
  runtime: IAgentRuntime,
  roomId: string,
  actionName: "CALL_USER" | "CALL_EXTERNAL",
): Promise<PendingCallDraft | null> {
  if (typeof runtime.getCache !== "function") {
    return null;
  }
  return (
    (await runtime.getCache<PendingCallDraft>(
      getPendingCallCacheKey(roomId, actionName),
    )) ?? null
  );
}

async function writePendingCallDraft(
  runtime: IAgentRuntime,
  roomId: string,
  draft: PendingCallDraft,
): Promise<void> {
  if (typeof runtime.setCache !== "function") {
    return;
  }
  await runtime.setCache(
    getPendingCallCacheKey(roomId, draft.actionName),
    draft,
  );
}

async function clearPendingCallDraft(
  runtime: IAgentRuntime,
  roomId: string,
  actionName: "CALL_USER" | "CALL_EXTERNAL",
): Promise<void> {
  if (typeof runtime.deleteCache !== "function") {
    return;
  }
  await runtime.deleteCache(getPendingCallCacheKey(roomId, actionName));
}

async function enqueueCallApprovalRequest(args: {
  runtime: IAgentRuntime;
  message: Memory;
  actionName: "CALL_USER" | "CALL_EXTERNAL";
  to?: string;
  body: string;
}): Promise<string | null> {
  if (typeof args.runtime.createTask !== "function") {
    return null;
  }

  return await args.runtime.createTask({
    name: `${args.actionName}_${Date.now()}`,
    description:
      args.actionName === "CALL_USER"
        ? `Approve calling the owner${args.body ? ` with message: ${args.body}` : ""}.`
        : `Approve calling ${args.to ?? "the selected recipient"}${args.body ? ` with message: ${args.body}` : ""}.`,
    roomId: args.message.roomId,
    entityId: args.message.entityId,
    tags: ["AWAITING_CHOICE", "APPROVAL", args.actionName],
    metadata: {
      options: [
        { name: "confirm", description: "Place the call" },
        { name: "cancel", description: "Do not call" },
      ],
      approvalRequest: {
        timeoutMs: 24 * 60 * 60 * 1000,
        timeoutDefault: "cancel",
        createdAt: Date.now(),
        isAsync: true,
      },
      actionName: args.actionName,
      channel: "phone_call",
      payload: {
        to: args.to ?? null,
        message: args.body,
      },
    },
  });
}

function buildCallUserPolicyAcknowledgement(
  userText: string,
): ActionResult | null {
  const normalized = userText.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const isStandingEscalationPolicy =
    /\bif\b/u.test(normalized) &&
    /\b(?:stuck|blocked|jammed|jams|unblock|can't continue|cannot continue)\b/u.test(
      normalized,
    ) &&
    /\b(?:browser|computer|desktop|screen|remote workflow|on my machine)\b/u.test(
      normalized,
    ) &&
    /\b(?:call me|phone me|ring me|dial me)\b/u.test(normalized);

  if (!isStandingEscalationPolicy) {
    return null;
  }

  return {
    text: "If I get stuck in the browser or on your computer, I'll escalate by phone so you can jump in and unblock it. I will still require confirmation before placing an actual call.",
    success: true,
    values: {
      success: true,
      policyRecorded: true,
    },
    data: {
      actionName: "CALL_USER",
      policyRecorded: true,
      policyType: "stuck_computer_phone_escalation",
      channel: "phone_call",
    },
  };
}

function isE164PhoneNumber(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value.trim());
}

async function resolveExternalCallRecipient(args: {
  runtime: IAgentRuntime;
  providedTo?: string;
  messageText?: string;
}): Promise<{ to: string | null; matchedRelationshipId?: string | null }> {
  const explicit = args.providedTo?.trim();
  if (explicit) {
    if (isE164PhoneNumber(explicit)) {
      return { to: explicit, matchedRelationshipId: null };
    }
  }

  const service = new LifeOpsService(args.runtime);
  const relationships = await service.listRelationships({ limit: 200 });
  const haystack = normalizeLookup(
    [explicit ?? "", args.messageText ?? ""].join(" "),
  );
  if (!haystack) {
    return { to: null, matchedRelationshipId: null };
  }

  const candidates = relationships.filter(
    (relationship) =>
      typeof relationship.phone === "string" && relationship.phone,
  );
  for (const relationship of candidates) {
    const lookupValues = [
      relationship.name,
      relationship.primaryHandle,
      relationship.email ?? "",
      relationship.notes ?? "",
      ...relationship.tags,
    ]
      .map(normalizeLookup)
      .filter((value) => value.length > 0);

    const matched = lookupValues.some(
      (value) => haystack.includes(value) || value.includes(haystack),
    );
    if (matched && relationship.phone) {
      return {
        to: relationship.phone,
        matchedRelationshipId: relationship.id,
      };
    }
  }

  return { to: explicit ?? null, matchedRelationshipId: null };
}

function readOwnerNumber(
  runtime: { getSetting?: (key: string) => unknown } | undefined,
): string | null {
  for (const key of OWNER_NUMBER_ENV_KEYS) {
    const envVal = process.env[key]?.trim();
    if (envVal) return envVal;
    const setting = runtime?.getSetting?.(key);
    if (typeof setting === "string" && setting.trim().length > 0) {
      return setting.trim();
    }
  }
  return null;
}

function readExternalAllowList(
  runtime: { getSetting?: (key: string) => unknown } | undefined,
): string[] {
  const raw =
    process.env[EXTERNAL_ALLOWLIST_ENV_KEY] ??
    (() => {
      const s = runtime?.getSetting?.(EXTERNAL_ALLOWLIST_ENV_KEY);
      return typeof s === "string" ? s : undefined;
    })();
  const list = new Set<string>();
  if (raw) {
    for (const part of raw.split(/[\s,;]+/)) {
      const trimmed = part.trim();
      if (trimmed) list.add(trimmed);
    }
  }
  const owner = readOwnerNumber(runtime);
  if (owner) list.add(owner);
  return Array.from(list);
}

function normalizePhoneAllowListKey(value: string): string {
  return value.replace(/[^0-9+]/g, "").replace(/^\+/, "");
}

function deliveryToResult(
  delivery: TwilioDeliveryResult,
  to: string,
  actionName: string,
): ActionResult {
  return {
    text: delivery.ok ? `Placed call to ${to}.` : `Call to ${to} failed.`,
    success: delivery.ok,
    values: {
      success: delivery.ok,
      to,
      sid: delivery.sid ?? null,
    },
    data: {
      actionName,
      to,
      sid: delivery.sid ?? null,
      status: delivery.status,
      error: delivery.error,
      retryCount: delivery.retryCount ?? 0,
    },
  };
}

export const callUserAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "CALL_USER",
  similes: [
    "PHONE_USER",
    "CALL_OWNER",
    "DIAL_OWNER",
    "ESCALATE_TO_OWNER",
    "CALL_IF_STUCK",
  ],
  tags: [
    "always-include",
    "call me",
    "phone me",
    "stuck in browser",
    "unblock computer",
    "standing escalation policy",
    "call if stuck",
  ],
  description:
    "Place an outbound phone call to the agent owner via Twilio. Use this when the assistant is blocked and needs real-time help from the owner, or when the owner explicitly asks to be called. Standing policies like 'if you get stuck in the browser or on my computer, call me' belong here on the first turn; this action can record the escalation path and return a confirmation/intervention request instead of dialing immediately when confirmation is still required.",
  suppressPostActionContinuation: true,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "CALL_USER", error: "PERMISSION_DENIED" },
      };
    }

    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | CallUserParameters
        | undefined) ?? {};
    const policyAcknowledgement = buildCallUserPolicyAcknowledgement(
      typeof message.content?.text === "string" ? message.content.text : "",
    );
    if (policyAcknowledgement) {
      return policyAcknowledgement;
    }

    const pendingDraft = await readPendingCallDraft(
      runtime,
      message.roomId,
      "CALL_USER",
    );

    if (params.confirmed !== true) {
      logger.info({ action: "CALL_USER" }, "[CALL_USER] confirmation required");
      const spokenMessage =
        params.message?.trim() ||
        pendingDraft?.message?.trim() ||
        "Your agent is calling you.";
      const approvalTaskId = await enqueueCallApprovalRequest({
        runtime,
        message,
        actionName: "CALL_USER",
        body: spokenMessage,
      });
      await writePendingCallDraft(runtime, message.roomId, {
        actionName: "CALL_USER",
        to: readOwnerNumber(runtime),
        message: spokenMessage,
        approvalTaskId,
        createdAt: new Date().toISOString(),
      });
      return {
        text: "Please confirm before I place the call.",
        success: false,
        values: { success: false, requiresConfirmation: true },
        data: {
          actionName: "CALL_USER",
          requiresConfirmation: true,
          approvalTaskId,
        },
      };
    }

    const to = readOwnerNumber(runtime);
    if (!to) {
      logger.warn(
        { action: "CALL_USER" },
        "[CALL_USER] owner phone number not configured",
      );
      return {
        text: "",
        success: false,
        values: { success: false, error: "OWNER_NUMBER_NOT_CONFIGURED" },
        data: {
          actionName: "CALL_USER",
          error: "OWNER_NUMBER_NOT_CONFIGURED",
        },
      };
    }
    if (!isE164(to) || isPlaceholderOrNonNumeric(to)) {
      return invalidPhoneResult(
        to,
        "the owner",
        "CALL_USER",
        isPlaceholderOrNonNumeric(to)
          ? "PLACEHOLDER_PHONE_NUMBER"
          : "INVALID_PHONE_NUMBER",
      );
    }

    const credentials = readTwilioCredentialsFromEnv();
    if (!credentials) {
      return {
        text: "",
        success: false,
        values: { success: false, error: "TWILIO_NOT_CONFIGURED" },
        data: { actionName: "CALL_USER", error: "TWILIO_NOT_CONFIGURED" },
      };
    }

    const spokenMessage =
      params.message?.trim() ||
      pendingDraft?.message?.trim() ||
      "Your agent is calling you.";
    const delivery = await sendTwilioVoiceCall({
      credentials,
      to,
      message: spokenMessage,
    });
    const result = deliveryToResult(delivery, to, "CALL_USER");
    if (result.success) {
      await clearPendingCallDraft(runtime, message.roomId, "CALL_USER");
      if (
        pendingDraft?.approvalTaskId &&
        typeof runtime.deleteTask === "function"
      ) {
        await runtime.deleteTask(pendingDraft.approvalTaskId as never);
      }
    }
    return result;
  },

  parameters: [
    {
      name: "confirmed",
      description:
        "Must be true to actually place the call. Without it the action returns a confirmation request.",
      schema: { type: "boolean" as const },
    },
    {
      name: "message",
      description: "Spoken message played when the owner answers.",
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "If you get stuck in the browser or on my computer, call me and let me jump in to unblock it.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Understood. If I get stuck in the browser or on your computer, I'll draft a call to you so you can jump in and unblock it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Call me if the remote workflow jams again." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can call you if that workflow jams again. I'll ask for confirmation before dialing.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const callExternalAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "CALL_EXTERNAL",
  similes: [
    "PHONE_EXTERNAL",
    "DIAL_EXTERNAL",
    "CALL_THIRD_PARTY",
    "BOOK_BY_PHONE",
    "REBOOK_BY_PHONE",
    "CALL_DENTIST",
    "PHONE_CABLE_COMPANY",
    "CALL_SUPPORT",
    "RESCHEDULE_APPOINTMENT_BY_PHONE",
  ],
  tags: [
    "always-include",
    "book by phone",
    "rebook by phone",
    "call vendor",
    "call airline",
    "call dentist",
    "call doctor",
    "phone support",
    "call cable company",
    "reschedule appointment",
  ],
  description:
    "Place an outbound phone call to a third party via Twilio. Use this for approved booking, reschedule, outage, support, or escalation calls to vendors or counterparties. Examples: 'call the dentist and reschedule my appointment', 'phone my cable company and ask about the outage', 'call the airline', or 'call the hotel to rebook'. This action can draft the call, ask which saved contact to use, and then require confirmation before dialing. If the user wants a real phone call to a third party, prefer this action over OWNER_CALENDAR, LIFE, or OWNER_SEND_MESSAGE. The recipient must appear in the configured allow-list before the actual call is placed.",
  suppressPostActionContinuation: true,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "CALL_EXTERNAL", error: "PERMISSION_DENIED" },
      };
    }

    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | CallExternalParameters
        | undefined) ?? {};
    const pendingDraft = await readPendingCallDraft(
      runtime,
      message.roomId,
      "CALL_EXTERNAL",
    );
    const resolvedRecipient = await resolveExternalCallRecipient({
      runtime,
      providedTo: params.to ?? pendingDraft?.to ?? undefined,
      messageText:
        typeof message.content?.text === "string" ? message.content.text : "",
    });
    const to = resolvedRecipient.to?.trim();
    const contact: string | undefined = undefined;
    if (!to) {
      return {
        text: "Who should I call, or which saved contact/phone number should I use?",
        success: false,
        values: { success: false, error: "MISSING_RECIPIENT" },
        data: { actionName: "CALL_EXTERNAL", error: "MISSING_RECIPIENT" },
      };
    }
    if (isPlaceholderOrNonNumeric(to)) {
      return invalidPhoneResult(
        to,
        contact,
        "CALL_EXTERNAL",
        "PLACEHOLDER_PHONE_NUMBER",
      );
    }
    if (!isE164(to)) {
      return invalidPhoneResult(
        to,
        contact,
        "CALL_EXTERNAL",
        "INVALID_PHONE_NUMBER",
      );
    }

    if (params.confirmed !== true) {
      logger.info(
        { action: "CALL_EXTERNAL", to },
        "[CALL_EXTERNAL] confirmation required",
      );
      const spokenMessage =
        params.message?.trim() ||
        pendingDraft?.message?.trim() ||
        "This is a call from an automated assistant.";
      const approvalTaskId = await enqueueCallApprovalRequest({
        runtime,
        message,
        actionName: "CALL_EXTERNAL",
        to,
        body: spokenMessage,
      });
      await writePendingCallDraft(runtime, message.roomId, {
        actionName: "CALL_EXTERNAL",
        to,
        message: spokenMessage,
        approvalTaskId,
        createdAt: new Date().toISOString(),
      });
      return {
        text: `Please confirm before I call ${to}.`,
        success: false,
        values: { success: false, requiresConfirmation: true, to },
        data: {
          actionName: "CALL_EXTERNAL",
          requiresConfirmation: true,
          to,
          matchedRelationshipId:
            resolvedRecipient.matchedRelationshipId ?? null,
          approvalTaskId,
        },
      };
    }

    const allowList = readExternalAllowList(runtime);
    const normalizedTo = normalizePhoneAllowListKey(to);
    const isAllowed = allowList.some(
      (candidate) => normalizePhoneAllowListKey(candidate) === normalizedTo,
    );
    if (!isAllowed) {
      logger.warn(
        { action: "CALL_EXTERNAL", to },
        "[CALL_EXTERNAL] recipient not in allow-list",
      );
      return {
        text: "",
        success: false,
        values: { success: false, reason: "disallowed-recipient", to },
        data: {
          actionName: "CALL_EXTERNAL",
          reason: "disallowed-recipient",
          to,
          matchedRelationshipId:
            resolvedRecipient.matchedRelationshipId ?? null,
        },
      };
    }

    const credentials = readTwilioCredentialsFromEnv();
    if (!credentials) {
      return {
        text: "",
        success: false,
        values: { success: false, error: "TWILIO_NOT_CONFIGURED" },
        data: { actionName: "CALL_EXTERNAL", error: "TWILIO_NOT_CONFIGURED" },
      };
    }

    const spokenMessage =
      params.message?.trim() ||
      pendingDraft?.message?.trim() ||
      "This is a call from an automated assistant.";
    const delivery = await sendTwilioVoiceCall({
      credentials,
      to,
      message: spokenMessage,
    });
    const result = deliveryToResult(delivery, to, "CALL_EXTERNAL");
    if (result.success) {
      await clearPendingCallDraft(runtime, message.roomId, "CALL_EXTERNAL");
      if (pendingDraft?.approvalTaskId) {
        await runtime.deleteTask(pendingDraft.approvalTaskId as never);
      }
    }
    return result;
  },

  parameters: [
    {
      name: "confirmed",
      description: "Must be true to actually place the call.",
      schema: { type: "boolean" as const },
    },
    {
      name: "to",
      description:
        "E.164 phone number to call. Must appear in the external allow-list.",
      schema: { type: "string" as const },
    },
    {
      name: "message",
      description: "Spoken message played when the recipient answers.",
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "If needed, call the airline and help rebook the other thing.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can draft that external call. Tell me which saved contact or number to use, and I'll ask for confirmation before dialing.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I can go ahead and start booking the flights and hotel today if that's good with you.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can draft the booking calls and hold them behind your approval so nothing gets booked until you say yes.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Yes, go ahead and call the hotel and lock it in.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll prepare the hotel call. I still need the saved contact or phone number before I can place it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Call the dentist and reschedule my appointment.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can draft that call and hold it behind your approval. Tell me which saved contact or phone number to use, and I'll ask for confirmation before dialing.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Phone my cable company and ask about the outage.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can draft the support call. Tell me which saved contact or phone number to use, and I'll ask for confirmation before dialing.",
        },
      },
    ],
  ] as ActionExample[][],
};

// Exposed for tests.
export const __internal = {
  readOwnerNumber,
  readExternalAllowList,
};
