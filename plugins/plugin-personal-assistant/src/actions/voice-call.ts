/**
 * VOICE_CALL action — owner-initiated outbound phone calls via Twilio.
 * Confirmation-gated; handles the place/status/end/list subactions and reports
 * per-segment cost estimates. The telephony transport is Twilio; this action
 * owns only the owner-facing call lifecycle.
 */
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type IAgentRuntime,
  logger,
  type Memory,
  requireConfirmation,
  resolveActionArgs,
  type SubactionsMap,
} from "@elizaos/core";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioVoiceCall,
  type TwilioDeliveryResult,
} from "@elizaos/plugin-native-phone/twilio";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { LifeOpsService } from "../lifeops/service.js";

const ACTION_NAME = "VOICE_CALL";

const OWNER_NUMBER_ENV_KEYS = [
  "ELIZA_E2E_TWILIO_RECIPIENT",
  "TWILIO_OWNER_NUMBER",
] as const;
const EXTERNAL_ALLOWLIST_ENV_KEY = "TWILIO_CALL_EXTERNAL_ALLOWLIST";

const E164_RE = /^\+[1-9]\d{1,14}$/;
const PLACEHOLDER_555_RE = /^\+?1?[-\s]?\(?5{3}\)?[-\s]?5{3}[-\s]?5{4}$/;

type VoiceCallSubaction = "dial";

type RecipientKind = "owner" | "external" | "e164";

interface VoiceCallParams {
  /**
   * Recipient discriminator. Drives the routing inside `dial`:
   *   - `owner`     → owner-escalation path (env-resolved owner number)
   *   - `external`  → name-resolved third party + allow-list check
   *   - `e164`      → raw E.164 number, no relationship lookup
   */
  recipientKind?: RecipientKind;
  /** Resolved or asserted phone number (E.164). Required for `e164`. */
  phoneNumber?: string;
  /** Contact name or E.164 used for `external` lookup. */
  recipient?: string;
  bodyText?: string;
}

const SUBACTIONS: SubactionsMap<VoiceCallSubaction> = {
  dial: {
    description:
      "Outbound Twilio voice call. recipientKind: owner escalation env owner number; external third party RelationshipStore + allow-list; e164 raw phoneNumber + bodyText. Draft first; the owner's next-turn yes dispatches.",
    descriptionCompressed:
      "Twilio voice dial: recipientKind=owner|external|e164; draft, owner yes/no next turn",
    required: ["recipientKind"],
    optional: ["phoneNumber", "recipient", "bodyText"],
  },
};

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
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

const UNSPACED_SCRIPT_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/**
 * Whether `inner` appears as a run of whole tokens in `outer`, or of token
 * prefixes when `prefix` is set. Scripts written without spaces may carry
 * attached particles ("田中さんに"), so their tokens match inside a longer token.
 */
function containsTokenRun(
  outer: string[],
  inner: string[],
  prefix = false,
): boolean {
  if (inner.length === 0 || inner[0] === "") return false;
  for (let start = 0; start + inner.length <= outer.length; start++) {
    if (
      inner.every((token, offset) => {
        const candidate = outer[start + offset] ?? "";
        return (
          candidate === token ||
          (prefix && candidate.startsWith(token)) ||
          (UNSPACED_SCRIPT_RE.test(token) && candidate.includes(token))
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

function messageText(message: Memory): string {
  return typeof message.content.text === "string" ? message.content.text : "";
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

type SpokenMessageConfirmation =
  | { status: "confirmed"; spokenMessage: string }
  | { status: "pending" | "cancelled"; spokenMessage: string; prompt: string };

/**
 * Two-phase confirmation bound to the spoken message the owner was shown. The
 * planner writes the arguments again on the confirming turn, so a yes places
 * the call with the previewed message. A yes that arrives with a different
 * bodyText previews that message instead of dialing.
 */
async function confirmSpokenMessage(args: {
  runtime: IAgentRuntime;
  message: Memory;
  actionName: string;
  pendingKey: string;
  /** How the prompt names the callee. */
  target: string;
  /** The message this call asks for: bodyText, or the path default. */
  spokenMessage: string;
  /** False when bodyText was omitted and `spokenMessage` is the default. */
  explicit: boolean;
}): Promise<SpokenMessageConfirmation> {
  const { spokenMessage } = args;
  const prompt = `Place voice call to ${args.target} with message: "${spokenMessage}"?`;
  const ask = () =>
    requireConfirmation({
      runtime: args.runtime,
      message: args.message,
      actionName: args.actionName,
      pendingKey: args.pendingKey,
      prompt,
      metadata: { spokenMessage },
    });
  const decision = await ask();
  if (decision.status !== "confirmed") {
    return { status: decision.status, spokenMessage, prompt };
  }
  const previewed = decision.metadata?.spokenMessage;
  if (
    typeof previewed === "string" &&
    (!args.explicit || previewed === spokenMessage)
  ) {
    return { status: "confirmed", spokenMessage: previewed };
  }
  // The consumed record held another message; this call stores the new one.
  await ask();
  return { status: "pending", spokenMessage, prompt };
}

type ExternalCallRecipient =
  | {
      kind: "resolved";
      to: string;
      name: string | null;
      matchedRelationshipId: string | null;
    }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "missing" };

/**
 * Resolve the callee. The declared `recipient` decides when it is supplied;
 * the message text is searched only when it is absent, so a contact that is
 * merely mentioned in the chat cannot replace the named one.
 */
async function resolveExternalCallRecipient(args: {
  runtime: IAgentRuntime;
  recipient?: string;
  messageText: string;
}): Promise<ExternalCallRecipient> {
  const explicit = args.recipient?.trim();
  if (explicit && isE164PhoneNumber(explicit)) {
    return {
      kind: "resolved",
      to: explicit,
      name: null,
      matchedRelationshipId: null,
    };
  }

  const haystack = normalizeLookup(explicit || args.messageText);
  if (!haystack) {
    return { kind: "missing" };
  }

  const haystackTokens = haystack.split(" ");
  const service = new LifeOpsService(args.runtime);
  const relationships = await service.listRelationships();
  const partialMatches = relationships.filter((relationship) => {
    if (typeof relationship.phone !== "string" || !relationship.phone) {
      return false;
    }
    const identifiers = [
      relationship.name,
      relationship.primaryHandle,
      relationship.email ?? "",
      ...relationship.tags,
    ].map((value) => normalizeLookup(value).split(" "));
    // Free-text notes only match when the whole note was named, so a word in
    // a note ("Alice's brother") never stands in for the contact.
    const notes = normalizeLookup(relationship.notes ?? "").split(" ");
    // A declared recipient may be the start of a name ("Bo" for "Bob"); the
    // message text must name the contact in whole words.
    return (
      identifiers.some(
        (tokens) =>
          containsTokenRun(haystackTokens, tokens) ||
          containsTokenRun(tokens, haystackTokens, Boolean(explicit)),
      ) || containsTokenRun(haystackTokens, notes)
    );
  });
  // A contact whose whole name was given wins over contacts that only contain
  // it ("Bob" over "Bob Jones"), so the short name stays callable.
  const namedMatches = partialMatches.filter(
    (relationship) => normalizeLookup(relationship.name) === haystack,
  );
  const matches = namedMatches.length > 0 ? namedMatches : partialMatches;

  const [first] = matches;
  if (!first?.phone) {
    // An unmatched `recipient` is reported as an invalid number by the caller.
    return explicit
      ? {
          kind: "resolved",
          to: explicit,
          name: null,
          matchedRelationshipId: null,
        }
      : { kind: "missing" };
  }
  if (new Set(matches.map((relationship) => relationship.phone)).size > 1) {
    return {
      kind: "ambiguous",
      names: matches.map((relationship) => relationship.name),
    };
  }
  return {
    kind: "resolved",
    to: first.phone,
    name: first.name,
    matchedRelationshipId: first.id,
  };
}

function deliveryToResult(
  delivery: TwilioDeliveryResult,
  to: string,
  recipientKind: RecipientKind,
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
      action: "dial",
      subaction: "dial",
      recipientKind,
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
  recipientKind: RecipientKind,
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
      action: "dial",
      subaction: "dial",
      recipientKind,
      error: errorCode,
      to,
      contact: contact ?? null,
    },
  };
}

async function dialE164(
  runtime: IAgentRuntime,
  message: Memory,
  params: VoiceCallParams,
): Promise<ActionResult> {
  const credentials = readTwilioCredentialsFromEnv();
  if (!credentials) {
    return {
      text: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
      success: false,
      values: { success: false, error: "TWILIO_NOT_CONFIGURED" },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "e164",
      },
    };
  }

  const to = (params.phoneNumber ?? "").trim();
  if (!to) {
    return {
      text: "Missing required parameter: phoneNumber (E.164 phone number).",
      success: false,
      values: { success: false, error: "MISSING_TO" },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "e164",
      },
    };
  }
  if (isPlaceholderOrNonNumeric(to)) {
    return invalidPhoneResult(
      to,
      undefined,
      "e164",
      "PLACEHOLDER_PHONE_NUMBER",
    );
  }
  if (!isE164(to)) {
    return invalidPhoneResult(to, undefined, "e164", "INVALID_PHONE_NUMBER");
  }

  const messageBody = (params.bodyText ?? "").trim();
  if (!messageBody) {
    return {
      text: "Missing required parameter: bodyText.",
      success: false,
      values: { success: false, error: "MISSING_MESSAGE" },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "e164",
      },
    };
  }

  const decision = await confirmSpokenMessage({
    runtime,
    message,
    actionName: ACTION_NAME,
    pendingKey: `e164:${to}`,
    target: to,
    spokenMessage: messageBody,
    explicit: true,
  });
  if (decision.status !== "confirmed") {
    return {
      text:
        decision.status === "pending"
          ? `${decision.prompt} Reply yes to confirm or no to cancel.`
          : "Voice call cancelled.",
      success: false,
      values: {
        success: false,
        error:
          decision.status === "pending"
            ? "DRAFT_REQUIRES_CONFIRMATION"
            : "CANCELLED",
        draft: decision.status === "pending",
        to,
        message: messageBody,
      },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "e164",
        draft: decision.status === "pending",
        to,
        message: messageBody,
        awaitingUserInput: decision.status === "pending",
      },
    };
  }

  const result = await sendTwilioVoiceCall({
    credentials,
    to,
    message: decision.spokenMessage,
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
        action: "dial",
        subaction: "dial",
        recipientKind: "e164",
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
      action: "dial",
      subaction: "dial",
      recipientKind: "e164",
      to,
      message: messageBody,
      sid: result.sid ?? null,
      status: result.status,
      retryCount: result.retryCount,
    },
  };
}

async function dialOwner(
  runtime: IAgentRuntime,
  message: Memory,
  params: VoiceCallParams,
): Promise<ActionResult> {
  const to = readOwnerNumber(runtime);
  if (!to) {
    logger.warn(
      { action: ACTION_NAME, recipientKind: "owner" },
      `[${ACTION_NAME}] owner phone number not configured`,
    );
    return {
      text: "",
      success: false,
      values: { success: false, error: "OWNER_NUMBER_NOT_CONFIGURED" },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "owner",
        error: "OWNER_NUMBER_NOT_CONFIGURED",
      },
    };
  }
  if (!isE164(to) || isPlaceholderOrNonNumeric(to)) {
    return invalidPhoneResult(
      to,
      "the owner",
      "owner",
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
        action: "dial",
        subaction: "dial",
        recipientKind: "owner",
        error: "TWILIO_NOT_CONFIGURED",
      },
    };
  }

  const bodyText = params.bodyText?.trim();
  const ownerDecision = await confirmSpokenMessage({
    runtime,
    message,
    actionName: "VOICE_CALL_OWNER",
    pendingKey: `owner:${to}`,
    target: `owner ${to}`,
    spokenMessage: bodyText || "Your agent is calling you.",
    explicit: Boolean(bodyText),
  });
  if (ownerDecision.status !== "confirmed") {
    return {
      text:
        ownerDecision.status === "pending"
          ? `${ownerDecision.prompt} Reply yes to confirm or no to cancel.`
          : "Voice call cancelled.",
      success: false,
      values: {
        success: false,
        requiresConfirmation: ownerDecision.status === "pending",
      },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "owner",
        requiresConfirmation: ownerDecision.status === "pending",
        awaitingUserInput: ownerDecision.status === "pending",
      },
    };
  }
  const delivery = await sendTwilioVoiceCall({
    credentials,
    to,
    message: ownerDecision.spokenMessage,
  });
  return deliveryToResult(delivery, to, "owner");
}

async function dialExternal(
  runtime: IAgentRuntime,
  message: Memory,
  params: VoiceCallParams,
): Promise<ActionResult> {
  const resolvedRecipient = await resolveExternalCallRecipient({
    runtime,
    recipient: params.recipient,
    messageText: messageText(message),
  });
  if (resolvedRecipient.kind === "ambiguous") {
    return {
      text: `More than one saved contact matches: ${resolvedRecipient.names.join(", ")}. Which one should I call?`,
      success: false,
      values: { success: false, error: "AMBIGUOUS_RECIPIENT" },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "external",
        error: "AMBIGUOUS_RECIPIENT",
        candidates: resolvedRecipient.names,
      },
    };
  }
  if (resolvedRecipient.kind === "missing") {
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
        action: "dial",
        subaction: "dial",
        recipientKind: "external",
        error: "MISSING_RECIPIENT",
        requiresConfirmation: true,
      },
    };
  }
  const to = resolvedRecipient.to.trim();
  if (isPlaceholderOrNonNumeric(to)) {
    return invalidPhoneResult(
      to,
      undefined,
      "external",
      "PLACEHOLDER_PHONE_NUMBER",
    );
  }
  if (!isE164(to)) {
    return invalidPhoneResult(
      to,
      undefined,
      "external",
      "INVALID_PHONE_NUMBER",
    );
  }

  // Refuse a call that cannot be placed before the owner is asked to confirm it.
  const allowList = readExternalAllowList(runtime);
  const normalizedTo = normalizePhoneAllowListKey(to);
  const isAllowed = allowList.some(
    (candidate) => normalizePhoneAllowListKey(candidate) === normalizedTo,
  );
  if (!isAllowed) {
    logger.warn(
      { action: ACTION_NAME, recipientKind: "external", to },
      `[${ACTION_NAME}] recipient not in allow-list`,
    );
    return {
      text: `I cannot call ${to}. It is not on the external call allow-list (${EXTERNAL_ALLOWLIST_ENV_KEY}).`,
      success: false,
      values: { success: false, reason: "disallowed-recipient", to },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "external",
        reason: "disallowed-recipient",
        to,
        matchedRelationshipId: resolvedRecipient.matchedRelationshipId,
      },
    };
  }

  const credentials = readTwilioCredentialsFromEnv();
  if (!credentials) {
    return {
      text: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
      success: false,
      values: { success: false, error: "TWILIO_NOT_CONFIGURED" },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "external",
        error: "TWILIO_NOT_CONFIGURED",
      },
    };
  }

  const bodyText = params.bodyText?.trim();
  const externalDecision = await confirmSpokenMessage({
    runtime,
    message,
    actionName: "VOICE_CALL_EXTERNAL",
    pendingKey: `external:${to}`,
    target: resolvedRecipient.name ? `${resolvedRecipient.name} (${to})` : to,
    spokenMessage: bodyText || "This is a call from an automated assistant.",
    explicit: Boolean(bodyText),
  });
  if (externalDecision.status !== "confirmed") {
    return {
      text:
        externalDecision.status === "pending"
          ? `${externalDecision.prompt} Reply yes to confirm or no to cancel.`
          : "Voice call cancelled.",
      success: false,
      values: {
        success: false,
        requiresConfirmation: externalDecision.status === "pending",
        to,
      },
      data: {
        actionName: ACTION_NAME,
        action: "dial",
        subaction: "dial",
        recipientKind: "external",
        requiresConfirmation: externalDecision.status === "pending",
        awaitingUserInput: externalDecision.status === "pending",
        to,
        matchedRelationshipId: resolvedRecipient.matchedRelationshipId,
      },
    };
  }

  const delivery = await sendTwilioVoiceCall({
    credentials,
    to,
    message: externalDecision.spokenMessage,
  });
  return deliveryToResult(delivery, to, "external");
}

function normalizeRecipientKind(value: unknown): RecipientKind | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "owner" ||
    normalized === "external" ||
    normalized === "e164"
  ) {
    return normalized;
  }
  return null;
}

export const voiceCallAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  suppressPostActionContinuation: true,
  similes: [
    "CALL_ME",
    "ESCALATE_TO_USER",
    "CALL_THIRD_PARTY",
    "PHONE_SOMEONE",
    "DIAL",
  ],
  tags: [
    "domain:meta",
    "capability:execute",
    "capability:send",
    "surface:remote-api",
    "risk:user-visible",
  ],
  description:
    "Owner-only outbound voice call via registered provider. Action dial; recipientKind=owner|external|e164. " +
    "Provider Twilio; Android/app-phone implementation-only until VOICE_CALL provider wired. " +
    "owner env owner number; external RelationshipStore contact + allow-list; e164 raw phoneNumber. " +
    "All paths draft first; the call is placed only after the owner replies yes on the next turn.",
  descriptionCompressed:
    "Twilio voice dial: recipientKind=owner|external|e164; draft, owner yes/no next turn",
  contexts: ["contacts", "messaging", "phone", "tasks", "automation"],
  roleGate: { minRole: "OWNER" },

  validate: async () => true,

  parameters: [
    {
      name: "action",
      description: "dial.",
      required: true,
      schema: { type: "string" as const, enum: ["dial"] },
    },
    {
      name: "recipientKind",
      description:
        "owner escalation env number | external RelationshipStore lookup + allow-list | e164 raw E.164 phoneNumber.",
      required: true,
      schema: {
        type: "string" as const,
        enum: ["owner", "external", "e164"],
      },
    },
    {
      name: "phoneNumber",
      description:
        "recipientKind=e164: destination E.164 phoneNumber. Also needs bodyText.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "recipient",
      description:
        "recipientKind=external: contact name or E.164; names via RelationshipStore. When omitted, the saved contact named in the message text is used.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "bodyText",
      description:
        "Spoken message on connect. Required for recipientKind=e164; owner and external use a default message when omitted.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return {
        success: false,
        text: "Voice-call actions are restricted to the owner.",
        data: { actionName: ACTION_NAME, error: "PERMISSION_DENIED" },
      };
    }

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
      defaultSubaction: "dial",
    });
    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        data: { actionName: ACTION_NAME, missing: resolved.missing },
      };
    }

    const { params } = resolved;
    const recipientKind = normalizeRecipientKind(params.recipientKind);
    if (!recipientKind) {
      return {
        success: false,
        text: "VOICE_CALL.dial requires recipientKind = owner | external | e164.",
        values: { success: false, error: "MISSING_RECIPIENT_KIND" },
        data: {
          actionName: ACTION_NAME,
          action: "dial",
          subaction: "dial",
          error: "MISSING_RECIPIENT_KIND",
        },
      };
    }

    switch (recipientKind) {
      case "e164":
        return dialE164(runtime, message, params);
      case "owner":
        return dialOwner(runtime, message, params);
      case "external":
        return dialExternal(runtime, message, params);
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Call my phone now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft call to your configured phone number: "Your agent is calling you." Reply yes to confirm or no to cancel.',
        },
      },
    ],
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
