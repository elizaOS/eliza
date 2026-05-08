import {
  type Action,
  type ActionExample,
  type ActionResult,
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
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";

const ACTION_NAME = "VOICE_CALL";

const OWNER_NUMBER_ENV_KEYS = [
  "ELIZA_E2E_TWILIO_RECIPIENT",
  "TWILIO_OWNER_NUMBER",
] as const;
const EXTERNAL_ALLOWLIST_ENV_KEY = "TWILIO_CALL_EXTERNAL_ALLOWLIST";

const E164_RE = /^\+[1-9]\d{1,14}$/;
const PLACEHOLDER_555_RE = /^\+?1?[-\s]?\(?5{3}\)?[-\s]?5{3}[-\s]?5{4}$/;

type VoiceCallSubaction = "place" | "call_owner" | "call_external";

interface VoiceCallParams {
  phoneNumber?: string;
  recipient?: string;
  bodyText?: string;
  confirmed?: boolean;
  reason?: string;
}

const SUBACTIONS: SubactionsMap<VoiceCallSubaction> = {
  place: {
    description:
      "Place a generic Twilio voice call to a specific E.164 phone number. Drafts first; requires confirmed:true to dispatch.",
    descriptionCompressed: "Twilio voice-call E.164 number draft-confirm",
    required: ["phoneNumber"],
    optional: ["bodyText", "confirmed"],
  },
  call_owner: {
    description:
      "Call the owner as an escalation when the agent is blocked. Acknowledges standing escalation policies and uses the approval queue.",
    descriptionCompressed:
      "call owner escalation agent-blocked standing-policy approval-queue draft-confirm",
    required: [],
    optional: ["bodyText", "confirmed", "reason"],
  },
  call_external: {
    description:
      "Call a third party. Recipient name resolved via relationships, then normalized against the allow-list. Uses the approval queue.",
    descriptionCompressed:
      "call third-party name->phone relationships allowlist-check approval-queue draft-confirm",
    required: ["recipient"],
    optional: ["bodyText", "confirmed", "reason"],
  },
};

type PendingCallActionName = "CALL_USER" | "CALL_EXTERNAL";

interface PendingCallDraft {
  actionName: PendingCallActionName;
  to?: string | null;
  message?: string | null;
  approvalTaskId?: string | null;
  createdAt: string;
}

function isE164(value: string): boolean {
  return E164_RE.test(value);
}

function isE164PhoneNumber(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value.trim());
}

function isPlaceholderOrNonNumeric(value: string): boolean {
  if (PLACEHOLDER_555_RE.test(value)) return true;
  if (/[a-zA-Z]/.test(value)) return true;
  return false;
}

function normalizeLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function isStandingOwnerCallPolicy(message: Memory): boolean {
  const text = normalizeLookup(messageText(message));
  if (!text) {
    return false;
  }
  const isConditional =
    /\b(if|when|whenever)\b/.test(text) ||
    /\bget stuck\b/.test(text) ||
    /\bblocked\b/.test(text);
  const mentionsCall = /\b(call|phone|dial)\b/.test(text);
  const mentionsBlockedWork =
    /\b(stuck|blocked|jam|jams|unblock)\b/.test(text) &&
    /\b(browser|computer|desktop|remote|workflow|machine)\b/.test(text);
  return isConditional && mentionsCall && mentionsBlockedWork;
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
      actionName: ACTION_NAME,
      subaction: "call_owner",
      policyRecorded: true,
      policyType: "stuck_computer_phone_escalation",
      channel: "phone_call",
    },
  };
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

function getPendingCallCacheKey(
  roomId: string,
  actionName: PendingCallActionName,
): string {
  return `lifeops:twilio-call:pending:${actionName}:${roomId}`;
}

async function readPendingCallDraft(
  runtime: IAgentRuntime,
  roomId: string,
  actionName: PendingCallActionName,
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
  actionName: PendingCallActionName,
): Promise<void> {
  if (typeof runtime.deleteCache !== "function") {
    return;
  }
  await runtime.deleteCache(getPendingCallCacheKey(roomId, actionName));
}

async function enqueueCallApprovalRequest(args: {
  runtime: IAgentRuntime;
  message: Memory;
  actionName: PendingCallActionName;
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

async function resolveExternalCallRecipient(args: {
  runtime: IAgentRuntime;
  providedTo?: string;
  messageText?: string;
}): Promise<{ to: string | null; matchedRelationshipId?: string | null }> {
  const explicit = args.providedTo?.trim();
  if (explicit && isE164PhoneNumber(explicit)) {
    return { to: explicit, matchedRelationshipId: null };
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

function deliveryToResult(
  delivery: TwilioDeliveryResult,
  to: string,
  subaction: VoiceCallSubaction,
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
      actionName: ACTION_NAME,
      subaction,
      to,
      sid: delivery.sid ?? null,
      status: delivery.status,
      error: delivery.error,
      retryCount: delivery.retryCount ?? 0,
    },
  };
}

function invalidPhoneResult(
  to: string,
  contact: string | undefined,
  subaction: VoiceCallSubaction,
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
    data: {
      actionName: ACTION_NAME,
      subaction,
      error: errorCode,
      to,
      contact: contact ?? null,
    },
  };
}

async function handlePlace(
  _runtime: IAgentRuntime,
  params: VoiceCallParams,
): Promise<ActionResult> {
  const credentials = readTwilioCredentialsFromEnv();
  if (!credentials) {
    return {
      text: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
      success: false,
      values: { success: false, error: "TWILIO_NOT_CONFIGURED" },
      data: { actionName: ACTION_NAME, subaction: "place" },
    };
  }

  const to = (params.phoneNumber ?? "").trim();
  if (!to) {
    return {
      text: "Missing required parameter: phoneNumber (E.164 phone number).",
      success: false,
      values: { success: false, error: "MISSING_TO" },
      data: { actionName: ACTION_NAME, subaction: "place" },
    };
  }
  if (isPlaceholderOrNonNumeric(to)) {
    return invalidPhoneResult(
      to,
      undefined,
      "place",
      "PLACEHOLDER_PHONE_NUMBER",
    );
  }
  if (!isE164(to)) {
    return invalidPhoneResult(to, undefined, "place", "INVALID_PHONE_NUMBER");
  }

  const messageBody = (params.bodyText ?? "").trim();
  if (!messageBody) {
    return {
      text: "Missing required parameter: bodyText.",
      success: false,
      values: { success: false, error: "MISSING_MESSAGE" },
      data: { actionName: ACTION_NAME, subaction: "place" },
    };
  }

  if (params.confirmed !== true) {
    return {
      text: `Draft voice call to ${to}:\n\n"${messageBody}"\n\nSay "confirm" or re-issue with confirmed: true to place the call.`,
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
        subaction: "place",
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
        subaction: "place",
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
    values: { success: true, to, sid: result.sid ?? null },
    data: {
      actionName: ACTION_NAME,
      subaction: "place",
      to,
      message: messageBody,
      sid: result.sid ?? null,
      status: result.status,
      retryCount: result.retryCount,
    },
  };
}

async function handleCallOwner(
  runtime: IAgentRuntime,
  message: Memory,
  params: VoiceCallParams,
): Promise<ActionResult> {
  const policyAcknowledgement = buildCallUserPolicyAcknowledgement(
    messageText(message),
  );
  if (policyAcknowledgement) {
    return policyAcknowledgement;
  }

  const pendingDraft = await readPendingCallDraft(
    runtime,
    message.roomId,
    "CALL_USER",
  );

  if (params.confirmed !== true && isStandingOwnerCallPolicy(message)) {
    return {
      text: "Recorded. If I get stuck in the browser or on your computer, I'll escalate by phone so you can jump in to unblock it.",
      success: true,
      values: {
        success: true,
        policyRecorded: true,
        channel: "phone_call",
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "call_owner",
        policyRecorded: true,
        channel: "phone_call",
      },
    };
  }

  if (params.confirmed !== true) {
    logger.info(
      { action: ACTION_NAME, subaction: "call_owner" },
      `[${ACTION_NAME}] confirmation required for call_owner`,
    );
    const spokenMessage =
      params.bodyText?.trim() ||
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
        actionName: ACTION_NAME,
        subaction: "call_owner",
        requiresConfirmation: true,
        approvalTaskId,
      },
    };
  }

  const to = readOwnerNumber(runtime);
  if (!to) {
    logger.warn(
      { action: ACTION_NAME, subaction: "call_owner" },
      `[${ACTION_NAME}] owner phone number not configured`,
    );
    return {
      text: "",
      success: false,
      values: { success: false, error: "OWNER_NUMBER_NOT_CONFIGURED" },
      data: {
        actionName: ACTION_NAME,
        subaction: "call_owner",
        error: "OWNER_NUMBER_NOT_CONFIGURED",
      },
    };
  }
  if (!isE164(to) || isPlaceholderOrNonNumeric(to)) {
    return invalidPhoneResult(
      to,
      "the owner",
      "call_owner",
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
      data: {
        actionName: ACTION_NAME,
        subaction: "call_owner",
        error: "TWILIO_NOT_CONFIGURED",
      },
    };
  }

  const spokenMessage =
    params.bodyText?.trim() ||
    pendingDraft?.message?.trim() ||
    "Your agent is calling you.";
  const delivery = await sendTwilioVoiceCall({
    credentials,
    to,
    message: spokenMessage,
  });
  const result = deliveryToResult(delivery, to, "call_owner");
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
}

async function handleCallExternal(
  runtime: IAgentRuntime,
  message: Memory,
  params: VoiceCallParams,
): Promise<ActionResult> {
  const pendingDraft = await readPendingCallDraft(
    runtime,
    message.roomId,
    "CALL_EXTERNAL",
  );
  const resolvedRecipient = await resolveExternalCallRecipient({
    runtime,
    providedTo: params.recipient ?? pendingDraft?.to ?? undefined,
    messageText: messageText(message),
  });
  const to = resolvedRecipient.to?.trim();
  if (!to) {
    return {
      text: "Who should I call, or which saved contact/phone number should I use?",
      success: false,
      values: {
        success: false,
        error: "MISSING_RECIPIENT",
        requiresConfirmation: true,
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "call_external",
        error: "MISSING_RECIPIENT",
        requiresConfirmation: true,
      },
    };
  }
  if (isPlaceholderOrNonNumeric(to)) {
    return invalidPhoneResult(
      to,
      undefined,
      "call_external",
      "PLACEHOLDER_PHONE_NUMBER",
    );
  }
  if (!isE164(to)) {
    return invalidPhoneResult(
      to,
      undefined,
      "call_external",
      "INVALID_PHONE_NUMBER",
    );
  }

  if (params.confirmed !== true) {
    logger.info(
      { action: ACTION_NAME, subaction: "call_external", to },
      `[${ACTION_NAME}] confirmation required for call_external`,
    );
    const spokenMessage =
      params.bodyText?.trim() ||
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
        actionName: ACTION_NAME,
        subaction: "call_external",
        requiresConfirmation: true,
        to,
        matchedRelationshipId: resolvedRecipient.matchedRelationshipId ?? null,
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
      { action: ACTION_NAME, subaction: "call_external", to },
      `[${ACTION_NAME}] recipient not in allow-list`,
    );
    return {
      text: "",
      success: false,
      values: { success: false, reason: "disallowed-recipient", to },
      data: {
        actionName: ACTION_NAME,
        subaction: "call_external",
        reason: "disallowed-recipient",
        to,
        matchedRelationshipId: resolvedRecipient.matchedRelationshipId ?? null,
      },
    };
  }

  const credentials = readTwilioCredentialsFromEnv();
  if (!credentials) {
    return {
      text: "",
      success: false,
      values: { success: false, error: "TWILIO_NOT_CONFIGURED" },
      data: {
        actionName: ACTION_NAME,
        subaction: "call_external",
        error: "TWILIO_NOT_CONFIGURED",
      },
    };
  }

  const spokenMessage =
    params.bodyText?.trim() ||
    pendingDraft?.message?.trim() ||
    "This is a call from an automated assistant.";
  const delivery = await sendTwilioVoiceCall({
    credentials,
    to,
    message: spokenMessage,
  });
  const result = deliveryToResult(delivery, to, "call_external");
  if (result.success) {
    await clearPendingCallDraft(runtime, message.roomId, "CALL_EXTERNAL");
    if (
      pendingDraft?.approvalTaskId &&
      typeof runtime.deleteTask === "function"
    ) {
      await runtime.deleteTask(pendingDraft.approvalTaskId as never);
    }
  }
  return result;
}

export const voiceCallAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  suppressPostActionContinuation: true,
  similes: [
    "VOICE_CALL",
    "PLACE_CALL",
    "CALL_ME",
    "ESCALATE_TO_USER",
    "CALL_THIRD_PARTY",
    "PHONE_SOMEONE",
  ],
  tags: [
    "always-include",
    "call me",
    "phone me",
    "stuck in browser",
    "unblock computer",
    "standing escalation policy",
    "call if stuck",
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
    "Owner-only. Place an outbound voice call via Twilio. Subactions: place (generic call to a phone number with confirmation), call_owner (call the owner — escalation when agent is blocked), call_external (call a third party — name resolved via relationships, allow-list checked). All paths draft first, require confirmed:true to dispatch, and use the approval queue.",
  descriptionCompressed:
    "Twilio voice: place(number) call_owner(escalation policy) call_external(name→phone via relationships allowlist-check) draft-confirm approval-queue",
  contexts: ["contacts", "messaging", "phone", "tasks", "automation"],
  roleGate: { minRole: "OWNER" },

  validate: async () => true,

  parameters: [
    {
      name: "subaction",
      description: "One of: place, call_owner, call_external.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "phoneNumber",
      description:
        "For place: destination phone number in E.164 format (e.g. +15551234567).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "recipient",
      description:
        "For call_external: contact name or E.164 phone number. Names resolve via the relationships store.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "bodyText",
      description: "Optional spoken message played when the call connects.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Must be true to actually place the call. Without it the action returns a draft / approval-queue entry.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "reason",
      description:
        "Optional reason describing why the call is being placed (recorded with the approval task).",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    const resolved = await resolveActionArgs<
      VoiceCallSubaction,
      VoiceCallParams
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        data: { actionName: ACTION_NAME, missing: resolved.missing },
      };
    }

    const { subaction, params } = resolved;
    switch (subaction) {
      case "place":
        return handlePlace(runtime, params);
      case "call_owner":
        return handleCallOwner(runtime, message, params);
      case "call_external":
        return handleCallExternal(runtime, message, params);
    }
  },

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
        content: {
          text: "If you get stuck in the browser or on my computer, call me and let me jump in to unblock it.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Recorded. If I get stuck in the browser or on your computer, I'll escalate by phone so you can jump in to unblock it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Call the dentist and reschedule my appointment." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can draft that call and hold it behind your approval. Tell me which saved contact or phone number to use, and I'll ask for confirmation before dialing.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const __internal = {
  readOwnerNumber,
  readExternalAllowList,
};
