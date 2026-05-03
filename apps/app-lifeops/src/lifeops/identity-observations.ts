export const LIFEOPS_IDENTITY_OBSERVATION_KINDS = [
  "gmail_sender",
  "phone_contact",
  "calendar_attendee",
  "chat_identity",
  "drive_doc_mention",
  "manual_assertion",
] as const;

export type LifeOpsIdentityObservationKind =
  (typeof LIFEOPS_IDENTITY_OBSERVATION_KINDS)[number];

export const LIFEOPS_IDENTITY_PRIVACY_SCOPES = [
  "planner_visible",
  "owner_private",
  "sensitive",
] as const;

export type LifeOpsIdentityPrivacyScope =
  (typeof LIFEOPS_IDENTITY_PRIVACY_SCOPES)[number];

export type LifeOpsIdentityObservationSource =
  | "gmail"
  | "phone_contacts"
  | "calendar"
  | "chat"
  | "drive"
  | "manual";

export type LifeOpsIdentityObservationProvenance = {
  source: LifeOpsIdentityObservationSource;
  sourceId: string;
  observedAt: string;
  collectedAt?: string;
  connectorAccountId?: string;
  actorId?: string;
  url?: string;
};

type LifeOpsIdentityObservationBase = {
  kind: LifeOpsIdentityObservationKind;
  provenance: LifeOpsIdentityObservationProvenance;
  privacyScope?: LifeOpsIdentityPrivacyScope;
  confidence?: number;
  notes?: string;
};

export type LifeOpsIdentityHandleObservation = {
  platform: string;
  handle: string;
  userId?: string;
  verified?: boolean;
};

export type LifeOpsGmailSenderIdentityObservation =
  LifeOpsIdentityObservationBase & {
    kind: "gmail_sender";
    email?: string;
    replyTo?: string;
    displayName?: string;
    messageId?: string;
    threadId?: string;
  };

export type LifeOpsPhoneContactIdentityObservation =
  LifeOpsIdentityObservationBase & {
    kind: "phone_contact";
    contactId?: string;
    displayName?: string;
    givenName?: string;
    familyName?: string;
    organization?: string;
    emails?: string[];
    phones?: string[];
    handles?: LifeOpsIdentityHandleObservation[];
  };

export type LifeOpsCalendarAttendeeIdentityObservation =
  LifeOpsIdentityObservationBase & {
    kind: "calendar_attendee";
    eventId?: string;
    calendarId?: string;
    email?: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
  };

export type LifeOpsChatIdentityObservation = LifeOpsIdentityObservationBase & {
  kind: "chat_identity";
  platform: string;
  handle: string;
  userId?: string;
  displayName?: string;
  aliases?: string[];
  verified?: boolean;
};

export type LifeOpsDriveDocMentionIdentityObservation =
  LifeOpsIdentityObservationBase & {
    kind: "drive_doc_mention";
    documentId?: string;
    documentTitle?: string;
    mentionText?: string;
    email?: string;
    displayName?: string;
  };

export type LifeOpsManualIdentityAssertionObservation =
  LifeOpsIdentityObservationBase & {
    kind: "manual_assertion";
    assertedBy: string;
    verified: boolean;
    assertedDisplayName?: string;
    assertedEmails?: string[];
    assertedPhones?: string[];
    assertedHandles?: LifeOpsIdentityHandleObservation[];
    relationshipLabel?: string;
  };

export type LifeOpsIdentityObservation =
  | LifeOpsGmailSenderIdentityObservation
  | LifeOpsPhoneContactIdentityObservation
  | LifeOpsCalendarAttendeeIdentityObservation
  | LifeOpsChatIdentityObservation
  | LifeOpsDriveDocMentionIdentityObservation
  | LifeOpsManualIdentityAssertionObservation;

export type NormalizedLifeOpsIdentityHandle = {
  platform: string;
  handle: string;
  rawHandle: string;
  verified: boolean;
  userId?: string;
};

export type LifeOpsIdentityNameEvidence = {
  name: string;
  normalizedName: string;
  confidence: number;
  source: LifeOpsIdentityObservationKind;
  verified: boolean;
};

export type LifeOpsIdentityIdentifierBundle = {
  emails: string[];
  phones: string[];
  handles: NormalizedLifeOpsIdentityHandle[];
};

export type NormalizedLifeOpsIdentityObservation = {
  id: string;
  kind: LifeOpsIdentityObservationKind;
  provenance: LifeOpsIdentityObservationProvenance;
  privacyScope: LifeOpsIdentityPrivacyScope;
  confidence: number;
  baseConfidence: number;
  confidenceDecay: number;
  names: LifeOpsIdentityNameEvidence[];
  identifiers: LifeOpsIdentityIdentifierBundle;
  sourceFields: Record<string, string>;
  notes: string | null;
};

export type LifeOpsIdentityConflict = {
  type: "email_conflict" | "phone_conflict" | "handle_conflict";
  severity: "blocking" | "review";
  observationIds: string[];
  field: "email" | "phone" | "handle";
  values: string[];
  reason: string;
};

export type LifeOpsIdentitySummary = {
  id: string;
  displayName: string | null;
  observationIds: string[];
  confidence: number;
  privacyScope: LifeOpsIdentityPrivacyScope;
  identifiers: LifeOpsIdentityIdentifierBundle;
  sources: LifeOpsIdentityObservationKind[];
};

export type LifeOpsIdentityCandidateLookup = {
  observationId: string;
  displayNames: string[];
  identifiers: LifeOpsIdentityIdentifierBundle;
  privacyScope: LifeOpsIdentityPrivacyScope;
};

export type LifeOpsCoreIdentityCandidate = {
  primaryEntityId: string;
  displayName: string;
  aliases?: string[];
  emails?: string[];
  phones?: string[];
  handles?: NormalizedLifeOpsIdentityHandle[];
};

export type LifeOpsIdentityMergeProposalPayload = {
  kind: "identity_merge";
  status: "proposed";
  source: "lifeops.identity_observations";
  entityA: string;
  entityB: string;
  confidence: number;
  requiresExplicitConfirmation: true;
  observationIds: string[];
  preferredDisplayName: string | null;
  privacyScope: LifeOpsIdentityPrivacyScope;
  matchedIdentifiers: LifeOpsIdentityIdentifierBundle;
  conflicts: LifeOpsIdentityConflict[];
  evidence: Record<string, unknown>;
};

export type LifeOpsIdentityMergeProposalReceipt = {
  candidateId: string;
};

export type LifeOpsIdentityObservationCoreAdapter = {
  recordIdentityObservation?: (
    observation: NormalizedLifeOpsIdentityObservation,
  ) => Promise<void>;
  findCandidatePeople: (
    lookup: LifeOpsIdentityCandidateLookup,
  ) => Promise<LifeOpsCoreIdentityCandidate[]>;
  proposeMerge: (
    proposal: LifeOpsIdentityMergeProposalPayload,
  ) => Promise<LifeOpsIdentityMergeProposalReceipt>;
};

export type LifeOpsIdentityObservationOptions = {
  now?: Date | string;
  defaultCountryCode?: "US";
  confidenceHalfLifeDays?: number;
  mergeProposalThreshold?: number;
};

export type LifeOpsIdentityObservationPlan = {
  normalizedObservations: NormalizedLifeOpsIdentityObservation[];
  duplicateCount: number;
  conflicts: LifeOpsIdentityConflict[];
  summaries: LifeOpsIdentitySummary[];
};

export type LifeOpsIdentityObservationIngestionResult =
  LifeOpsIdentityObservationPlan & {
    proposedMerges: Array<
      LifeOpsIdentityMergeProposalPayload & {
        candidateId: string;
      }
    >;
  };

export type LifeOpsPlannerIdentityContext = {
  identities: Array<{
    displayName: string | null;
    confidence: number;
    sources: LifeOpsIdentityObservationKind[];
    emails: string[];
    phones: string[];
    handles: Array<{ platform: string; handle: string }>;
  }>;
};

export class LifeOpsIdentityObservationValidationError extends Error {
  readonly code:
    | "INVALID_CONFIDENCE"
    | "INVALID_PROVENANCE"
    | "MISSING_IDENTITY";

  constructor(
    code: "INVALID_CONFIDENCE" | "INVALID_PROVENANCE" | "MISSING_IDENTITY",
    message: string,
  ) {
    super(message);
    this.name = "LifeOpsIdentityObservationValidationError";
    this.code = code;
  }
}

type ObservationGroup = {
  observations: NormalizedLifeOpsIdentityObservation[];
  summary: LifeOpsIdentitySummary;
};

type RelationshipsGraphHandleLike = {
  platform: string;
  handle: string;
  verified?: boolean | null;
};

type RelationshipsGraphIdentityLike = {
  handles?: RelationshipsGraphHandleLike[];
  names?: string[];
};

type RelationshipsGraphPersonLike = {
  primaryEntityId: string;
  displayName: string;
  aliases?: string[];
  emails?: string[];
  phones?: string[];
  identities?: RelationshipsGraphIdentityLike[];
};

export type RelationshipsGraphIdentityObservationAdapterInput = {
  getGraphSnapshot: (query?: {
    search?: string | null;
    scope?: "all" | "relevant";
    limit?: number;
  }) => Promise<{
    people: RelationshipsGraphPersonLike[];
  }>;
  proposeMerge: (
    entityA: string,
    entityB: string,
    evidence: Record<string, unknown>,
  ) => Promise<string>;
};

const DEFAULT_CONFIDENCE_HALF_LIFE_DAYS = 365;
const DEFAULT_MERGE_PROPOSAL_THRESHOLD = 0.72;
const DAY_MS = 24 * 60 * 60 * 1000;

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function boundConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1_000) / 1_000));
}

function parseNow(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp);
    }
  }
  return new Date();
}

function normalizeIso(value: string | undefined, field: string): string {
  const trimmed = nonEmpty(value);
  if (!trimmed) {
    throw new LifeOpsIdentityObservationValidationError(
      "INVALID_PROVENANCE",
      `${field} is required`,
    );
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    throw new LifeOpsIdentityObservationValidationError(
      "INVALID_PROVENANCE",
      `${field} must be a valid ISO timestamp`,
    );
  }
  return new Date(timestamp).toISOString();
}

function normalizeProvenance(
  provenance: LifeOpsIdentityObservationProvenance | undefined,
): LifeOpsIdentityObservationProvenance {
  if (!provenance) {
    throw new LifeOpsIdentityObservationValidationError(
      "INVALID_PROVENANCE",
      "identity observation provenance is required",
    );
  }

  const source = nonEmpty(provenance.source);
  const sourceId = nonEmpty(provenance.sourceId);
  if (!source || !sourceId) {
    throw new LifeOpsIdentityObservationValidationError(
      "INVALID_PROVENANCE",
      "identity observation provenance requires source and sourceId",
    );
  }

  return {
    source: provenance.source,
    sourceId,
    observedAt: normalizeIso(provenance.observedAt, "provenance.observedAt"),
    ...(provenance.collectedAt
      ? {
          collectedAt: normalizeIso(
            provenance.collectedAt,
            "provenance.collectedAt",
          ),
        }
      : {}),
    ...(nonEmpty(provenance.connectorAccountId)
      ? { connectorAccountId: nonEmpty(provenance.connectorAccountId) ?? "" }
      : {}),
    ...(nonEmpty(provenance.actorId)
      ? { actorId: nonEmpty(provenance.actorId) ?? "" }
      : {}),
    ...(nonEmpty(provenance.url)
      ? { url: nonEmpty(provenance.url) ?? "" }
      : {}),
  };
}

export function normalizeEmail(value: string | undefined): string | null {
  const trimmed = nonEmpty(value?.replace(/^mailto:/i, ""));
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizePhone(
  value: string | undefined,
  options: { defaultCountryCode?: "US" } = {},
): string | null {
  const trimmed = nonEmpty(value);
  if (!trimmed) {
    return null;
  }

  const withoutExtension = trimmed
    .replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, "")
    .trim();
  let digits = withoutExtension.replace(/[^\d+]/g, "");
  if (digits.startsWith("++")) {
    digits = `+${digits.replace(/^\++/, "")}`;
  }
  if (digits.startsWith("011")) {
    digits = `+${digits.slice(3)}`;
  }
  if (digits.startsWith("00")) {
    digits = `+${digits.slice(2)}`;
  }

  if (digits.startsWith("+")) {
    const international = digits.slice(1).replace(/\D/g, "");
    return international.length >= 8 && international.length <= 15
      ? `+${international}`
      : null;
  }

  const localDigits = digits.replace(/\D/g, "");
  if (options.defaultCountryCode === "US" || !options.defaultCountryCode) {
    if (localDigits.length === 10) {
      return `+1${localDigits}`;
    }
    if (localDigits.length === 11 && localDigits.startsWith("1")) {
      return `+${localDigits}`;
    }
  }

  return null;
}

export function normalizeIdentityPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "x" || normalized === "x_dm") {
    return "twitter";
  }
  if (
    normalized === "tg" ||
    normalized === "telegram-account" ||
    normalized === "telegram_account"
  ) {
    return "telegram";
  }
  if (normalized === "i_message") {
    return "imessage";
  }
  return normalized;
}

export function normalizeIdentityHandle(
  platform: string,
  handle: string,
  options: { defaultCountryCode?: "US" } = {},
): NormalizedLifeOpsIdentityHandle | null {
  const rawHandle = nonEmpty(handle);
  if (!rawHandle) {
    return null;
  }

  const normalizedPlatform = normalizeIdentityPlatform(platform);
  if (normalizedPlatform === "email") {
    const email = normalizeEmail(rawHandle);
    return email
      ? {
          platform: normalizedPlatform,
          handle: email,
          rawHandle,
          verified: false,
        }
      : null;
  }
  if (
    normalizedPlatform === "phone" ||
    normalizedPlatform === "sms" ||
    normalizedPlatform === "whatsapp" ||
    normalizedPlatform === "signal"
  ) {
    const phone = normalizePhone(rawHandle, options);
    if (phone) {
      return {
        platform: normalizedPlatform,
        handle: phone,
        rawHandle,
        verified: false,
      };
    }
  }

  let normalizedHandle = rawHandle.trim();
  if (normalizedPlatform === "telegram") {
    normalizedHandle = normalizedHandle
      .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
      .replace(/^@+/, "");
  } else if (normalizedPlatform === "twitter") {
    normalizedHandle = normalizedHandle
      .replace(/^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\//i, "")
      .replace(/^@+/, "");
  } else if (normalizedPlatform === "website") {
    normalizedHandle = normalizedHandle.replace(/\/+$/, "");
  } else {
    normalizedHandle = normalizedHandle.replace(/^@+/, "");
  }

  const withoutQuery = normalizedHandle.split(/[/?#]/)[0]?.trim() ?? "";
  if (!withoutQuery) {
    return null;
  }

  return {
    platform: normalizedPlatform,
    handle:
      normalizedPlatform === "website"
        ? withoutQuery.toLowerCase()
        : withoutQuery.toLowerCase(),
    rawHandle,
    verified: false,
  };
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addName(
  names: LifeOpsIdentityNameEvidence[],
  rawName: string | undefined,
  kind: LifeOpsIdentityObservationKind,
  confidence: number,
  verified: boolean,
): void {
  const name = nonEmpty(rawName);
  if (!name) {
    return;
  }
  const key = normalizedName(name);
  if (!key) {
    return;
  }
  const existing = names.find((candidate) => candidate.normalizedName === key);
  if (!existing || existing.confidence < confidence) {
    if (existing) {
      names.splice(names.indexOf(existing), 1);
    }
    names.push({
      name,
      normalizedName: key,
      confidence: boundConfidence(confidence),
      source: kind,
      verified,
    });
  }
}

function addEmail(target: Set<string>, email: string | undefined): void {
  const normalized = normalizeEmail(email);
  if (normalized) {
    target.add(normalized);
  }
}

function addPhone(
  target: Set<string>,
  phone: string | undefined,
  options: LifeOpsIdentityObservationOptions,
): void {
  const normalized = normalizePhone(phone, options);
  if (normalized) {
    target.add(normalized);
  }
}

function addHandle(
  target: Map<string, NormalizedLifeOpsIdentityHandle>,
  raw: LifeOpsIdentityHandleObservation | undefined,
  options: LifeOpsIdentityObservationOptions,
): void {
  if (!raw) {
    return;
  }
  const normalized = normalizeIdentityHandle(raw.platform, raw.handle, options);
  if (!normalized) {
    return;
  }
  const userId = nonEmpty(raw.userId);
  const value: NormalizedLifeOpsIdentityHandle = {
    ...normalized,
    verified: raw.verified === true,
    ...(userId ? { userId } : {}),
  };
  target.set(identityHandleKey(value), value);

  if (userId) {
    const userIdHandle: NormalizedLifeOpsIdentityHandle = {
      platform: `${value.platform}:user_id`,
      handle: userId.toLowerCase(),
      rawHandle: userId,
      verified: raw.verified === true,
    };
    target.set(identityHandleKey(userIdHandle), userIdHandle);
  }
}

function identityHandleKey(handle: {
  platform: string;
  handle: string;
}): string {
  return `${normalizeIdentityPlatform(handle.platform)}:${handle.handle}`;
}

function sourceBaseConfidence(
  observation: LifeOpsIdentityObservation,
  identifiers: LifeOpsIdentityIdentifierBundle,
): number {
  switch (observation.kind) {
    case "manual_assertion":
      return observation.verified ? 0.98 : 0.72;
    case "phone_contact":
      return identifiers.phones.length > 0 || identifiers.emails.length > 0
        ? 0.84
        : 0.62;
    case "chat_identity":
      return observation.userId || observation.verified ? 0.76 : 0.66;
    case "calendar_attendee":
      return identifiers.emails.length > 0 ? 0.68 : 0.5;
    case "gmail_sender":
      return identifiers.emails.length > 0 ? 0.58 : 0.34;
    case "drive_doc_mention":
      return identifiers.emails.length > 0 ? 0.52 : 0.3;
  }
}

function explicitConfidence(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new LifeOpsIdentityObservationValidationError(
      "INVALID_CONFIDENCE",
      "identity observation confidence must be between 0 and 1",
    );
  }
  return value;
}

function decayedConfidence(args: {
  baseConfidence: number;
  observedAt: string;
  now: Date;
  halfLifeDays: number;
}): { confidence: number; decay: number } {
  const observedAtMs = Date.parse(args.observedAt);
  const ageDays = Math.max(0, (args.now.getTime() - observedAtMs) / DAY_MS);
  const decay = 0.5 ** (ageDays / args.halfLifeDays);
  return {
    confidence: boundConfidence(args.baseConfidence * decay),
    decay: boundConfidence(decay),
  };
}

function confidenceHalfLifeDays(
  options: LifeOpsIdentityObservationOptions,
): number {
  const days =
    options.confidenceHalfLifeDays ?? DEFAULT_CONFIDENCE_HALF_LIFE_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    throw new LifeOpsIdentityObservationValidationError(
      "INVALID_CONFIDENCE",
      "identity observation confidence half-life must be a positive finite number",
    );
  }
  return days;
}

export function normalizeIdentityObservation(
  observation: LifeOpsIdentityObservation,
  options: LifeOpsIdentityObservationOptions = {},
): NormalizedLifeOpsIdentityObservation {
  const provenance = normalizeProvenance(observation.provenance);
  const now = parseNow(options.now);
  const emails = new Set<string>();
  const phones = new Set<string>();
  const handles = new Map<string, NormalizedLifeOpsIdentityHandle>();
  const names: LifeOpsIdentityNameEvidence[] = [];
  const sourceFields: Record<string, string> = {};

  switch (observation.kind) {
    case "gmail_sender":
      addEmail(emails, observation.email);
      addEmail(emails, observation.replyTo);
      addName(names, observation.displayName, observation.kind, 0.38, false);
      if (observation.messageId) {
        sourceFields.messageId = observation.messageId;
      }
      if (observation.threadId) {
        sourceFields.threadId = observation.threadId;
      }
      break;
    case "phone_contact":
      for (const email of observation.emails ?? []) {
        addEmail(emails, email);
      }
      for (const phone of observation.phones ?? []) {
        addPhone(phones, phone, options);
      }
      for (const handle of observation.handles ?? []) {
        addHandle(handles, handle, options);
      }
      addName(names, observation.displayName, observation.kind, 0.7, false);
      addName(
        names,
        [observation.givenName, observation.familyName]
          .filter((part): part is string => Boolean(nonEmpty(part)))
          .join(" "),
        observation.kind,
        0.66,
        false,
      );
      if (observation.contactId) {
        sourceFields.contactId = observation.contactId;
      }
      if (observation.organization) {
        sourceFields.organization = observation.organization;
      }
      break;
    case "calendar_attendee":
      addEmail(emails, observation.email);
      addName(names, observation.displayName, observation.kind, 0.48, false);
      if (observation.eventId) {
        sourceFields.eventId = observation.eventId;
      }
      if (observation.calendarId) {
        sourceFields.calendarId = observation.calendarId;
      }
      if (observation.responseStatus) {
        sourceFields.responseStatus = observation.responseStatus;
      }
      break;
    case "chat_identity":
      addHandle(
        handles,
        {
          platform: observation.platform,
          handle: observation.handle,
          userId: observation.userId,
          verified: observation.verified,
        },
        options,
      );
      addName(
        names,
        observation.displayName,
        observation.kind,
        observation.verified ? 0.72 : 0.58,
        observation.verified === true,
      );
      for (const alias of observation.aliases ?? []) {
        addName(names, alias, observation.kind, 0.42, false);
      }
      break;
    case "drive_doc_mention":
      addEmail(emails, observation.email);
      addName(
        names,
        observation.displayName ?? observation.mentionText,
        observation.kind,
        0.36,
        false,
      );
      if (observation.documentId) {
        sourceFields.documentId = observation.documentId;
      }
      if (observation.documentTitle) {
        sourceFields.documentTitle = observation.documentTitle;
      }
      break;
    case "manual_assertion":
      for (const email of observation.assertedEmails ?? []) {
        addEmail(emails, email);
      }
      for (const phone of observation.assertedPhones ?? []) {
        addPhone(phones, phone, options);
      }
      for (const handle of observation.assertedHandles ?? []) {
        addHandle(
          handles,
          {
            ...handle,
            verified: handle.verified ?? observation.verified,
          },
          options,
        );
      }
      addName(
        names,
        observation.assertedDisplayName,
        observation.kind,
        observation.verified ? 0.98 : 0.74,
        observation.verified,
      );
      sourceFields.assertedBy = observation.assertedBy;
      if (observation.relationshipLabel) {
        sourceFields.relationshipLabel = observation.relationshipLabel;
      }
      break;
  }

  const identifiers: LifeOpsIdentityIdentifierBundle = {
    emails: uniqueSorted(emails),
    phones: uniqueSorted(phones),
    handles: Array.from(handles.values()).sort((left, right) =>
      identityHandleKey(left).localeCompare(identityHandleKey(right)),
    ),
  };

  if (
    identifiers.emails.length === 0 &&
    identifiers.phones.length === 0 &&
    identifiers.handles.length === 0 &&
    names.length === 0
  ) {
    throw new LifeOpsIdentityObservationValidationError(
      "MISSING_IDENTITY",
      "identity observation must contain a name, email, phone, or platform handle",
    );
  }

  const baseConfidence = boundConfidence(
    explicitConfidence(observation.confidence) ??
      sourceBaseConfidence(observation, identifiers),
  );
  const decayed = decayedConfidence({
    baseConfidence,
    observedAt: provenance.observedAt,
    now,
    halfLifeDays: confidenceHalfLifeDays(options),
  });
  const privacyScope = observation.privacyScope ?? "owner_private";
  const notes = nonEmpty(observation.notes);

  const normalized: NormalizedLifeOpsIdentityObservation = {
    id: observationFingerprint({
      kind: observation.kind,
      provenance,
      identifiers,
      names,
    }),
    kind: observation.kind,
    provenance,
    privacyScope,
    confidence: decayed.confidence,
    baseConfidence,
    confidenceDecay: decayed.decay,
    names: names.sort((left, right) => right.confidence - left.confidence),
    identifiers,
    sourceFields,
    notes,
  };

  return normalized;
}

function observationFingerprint(args: {
  kind: LifeOpsIdentityObservationKind;
  provenance: LifeOpsIdentityObservationProvenance;
  identifiers: LifeOpsIdentityIdentifierBundle;
  names: LifeOpsIdentityNameEvidence[];
}): string {
  const handlePart = args.identifiers.handles.map(identityHandleKey).join(",");
  const namePart = args.names.map((name) => name.normalizedName).join(",");
  return [
    "lifeops-identity",
    args.kind,
    args.provenance.source,
    args.provenance.sourceId,
    args.identifiers.emails.join(","),
    args.identifiers.phones.join(","),
    handlePart,
    namePart,
  ]
    .filter((part) => part.length > 0)
    .join(":");
}

function dedupeObservations(
  observations: NormalizedLifeOpsIdentityObservation[],
): {
  normalizedObservations: NormalizedLifeOpsIdentityObservation[];
  duplicateCount: number;
} {
  const byId = new Map<string, NormalizedLifeOpsIdentityObservation>();
  let duplicateCount = 0;

  for (const observation of observations) {
    const existing = byId.get(observation.id);
    if (!existing) {
      byId.set(observation.id, observation);
      continue;
    }
    duplicateCount += 1;
    if (observation.confidence > existing.confidence) {
      byId.set(observation.id, observation);
    }
  }

  return {
    normalizedObservations: Array.from(byId.values()),
    duplicateCount,
  };
}

function observationIdentifierKeys(
  observation: NormalizedLifeOpsIdentityObservation,
): string[] {
  return [
    ...observation.identifiers.emails.map((email) => `email:${email}`),
    ...observation.identifiers.phones.map((phone) => `phone:${phone}`),
    ...observation.identifiers.handles.map(
      (handle) => `handle:${identityHandleKey(handle)}`,
    ),
  ];
}

function sharedStrongIdentifier(
  left: NormalizedLifeOpsIdentityObservation,
  right: NormalizedLifeOpsIdentityObservation,
): boolean {
  const leftKeys = new Set(observationIdentifierKeys(left));
  return observationIdentifierKeys(right).some((key) => leftKeys.has(key));
}

function hasIntersect(left: string[], right: string[]): boolean {
  const set = new Set(left);
  return right.some((value) => set.has(value));
}

function detectIdentityConflicts(
  observations: NormalizedLifeOpsIdentityObservation[],
): LifeOpsIdentityConflict[] {
  const conflicts: LifeOpsIdentityConflict[] = [];
  const nameBuckets = new Map<string, NormalizedLifeOpsIdentityObservation[]>();

  for (const observation of observations) {
    for (const name of observation.names) {
      const current = nameBuckets.get(name.normalizedName) ?? [];
      current.push(observation);
      nameBuckets.set(name.normalizedName, current);
    }
  }

  for (const bucket of nameBuckets.values()) {
    for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < bucket.length;
        rightIndex += 1
      ) {
        const left = bucket[leftIndex];
        const right = bucket[rightIndex];
        if (!left || !right) {
          continue;
        }
        const leftEmails = left.identifiers.emails;
        const rightEmails = right.identifiers.emails;
        if (
          leftEmails.length > 0 &&
          rightEmails.length > 0 &&
          !hasIntersect(leftEmails, rightEmails) &&
          !sharedStrongIdentifier(left, right)
        ) {
          conflicts.push({
            type: "email_conflict",
            severity: "blocking",
            observationIds: uniqueSorted([left.id, right.id]),
            field: "email",
            values: uniqueSorted([...leftEmails, ...rightEmails]),
            reason:
              "same normalized display name has conflicting emails and no stronger shared identifier",
          });
        }
      }
    }
  }

  return uniqueConflicts(conflicts);
}

function uniqueConflicts(
  conflicts: LifeOpsIdentityConflict[],
): LifeOpsIdentityConflict[] {
  const byKey = new Map<string, LifeOpsIdentityConflict>();
  for (const conflict of conflicts) {
    byKey.set(
      [
        conflict.type,
        conflict.severity,
        conflict.observationIds.join(","),
        conflict.values.join(","),
      ].join(":"),
      conflict,
    );
  }
  return Array.from(byKey.values());
}

class ObservationUnionFind {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index];
    if (parent === undefined || parent === index) {
      return index;
    }
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parents[rightRoot] = leftRoot;
    }
  }
}

function groupObservations(
  observations: NormalizedLifeOpsIdentityObservation[],
): ObservationGroup[] {
  const unionFind = new ObservationUnionFind(observations.length);
  const ownerByIdentifier = new Map<string, number>();

  observations.forEach((observation, index) => {
    for (const key of observationIdentifierKeys(observation)) {
      const owner = ownerByIdentifier.get(key);
      if (owner === undefined) {
        ownerByIdentifier.set(key, index);
      } else {
        unionFind.union(owner, index);
      }
    }
  });

  const grouped = new Map<number, NormalizedLifeOpsIdentityObservation[]>();
  observations.forEach((observation, index) => {
    const root = unionFind.find(index);
    const current = grouped.get(root) ?? [];
    current.push(observation);
    grouped.set(root, current);
  });

  return Array.from(grouped.values()).map((group, index) => ({
    observations: group,
    summary: summarizeIdentityGroup(group, index),
  }));
}

function summarizeIdentityGroup(
  observations: NormalizedLifeOpsIdentityObservation[],
  index: number,
): LifeOpsIdentitySummary {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const handles = new Map<string, NormalizedLifeOpsIdentityHandle>();
  const sources = new Set<LifeOpsIdentityObservationKind>();

  for (const observation of observations) {
    sources.add(observation.kind);
    for (const email of observation.identifiers.emails) {
      emails.add(email);
    }
    for (const phone of observation.identifiers.phones) {
      phones.add(phone);
    }
    for (const handle of observation.identifiers.handles) {
      handles.set(identityHandleKey(handle), handle);
    }
  }

  return {
    id: `identity-summary:${index}`,
    displayName: preferredDisplayName(observations),
    observationIds: observations.map((observation) => observation.id).sort(),
    confidence: groupConfidence(observations),
    privacyScope: mergePrivacyScopes(
      observations.map((observation) => observation.privacyScope),
    ),
    identifiers: {
      emails: uniqueSorted(emails),
      phones: uniqueSorted(phones),
      handles: Array.from(handles.values()).sort((left, right) =>
        identityHandleKey(left).localeCompare(identityHandleKey(right)),
      ),
    },
    sources: Array.from(sources).sort(),
  };
}

function preferredDisplayName(
  observations: NormalizedLifeOpsIdentityObservation[],
): string | null {
  const candidates = observations.flatMap((observation) =>
    observation.names.map((name) => ({
      ...name,
      weightedConfidence:
        name.confidence *
        observation.confidence *
        (name.verified ? 1.35 : name.source === "gmail_sender" ? 0.65 : 1),
    })),
  );
  candidates.sort((left, right) => {
    if (right.weightedConfidence !== left.weightedConfidence) {
      return right.weightedConfidence - left.weightedConfidence;
    }
    return left.name.localeCompare(right.name);
  });
  return candidates[0]?.name ?? null;
}

function groupConfidence(
  observations: NormalizedLifeOpsIdentityObservation[],
): number {
  const confidenceComplement = observations.reduce(
    (product, observation) => product * (1 - observation.confidence),
    1,
  );
  const multiSourceBonus = observations.length > 1 ? 0.05 : 0;
  return boundConfidence(1 - confidenceComplement + multiSourceBonus);
}

function mergePrivacyScopes(
  scopes: LifeOpsIdentityPrivacyScope[],
): LifeOpsIdentityPrivacyScope {
  if (scopes.includes("sensitive")) {
    return "sensitive";
  }
  if (scopes.includes("owner_private")) {
    return "owner_private";
  }
  return "planner_visible";
}

export function planIdentityObservationIngestion(
  observations: LifeOpsIdentityObservation[],
  options: LifeOpsIdentityObservationOptions = {},
): LifeOpsIdentityObservationPlan {
  const normalized = observations.map((observation) =>
    normalizeIdentityObservation(observation, options),
  );
  const deduped = dedupeObservations(normalized);
  const conflicts = detectIdentityConflicts(deduped.normalizedObservations);
  const summaries = groupObservations(deduped.normalizedObservations).map(
    (group) => group.summary,
  );

  return {
    normalizedObservations: deduped.normalizedObservations,
    duplicateCount: deduped.duplicateCount,
    conflicts,
    summaries,
  };
}

export async function ingestIdentityObservations(args: {
  observations: LifeOpsIdentityObservation[];
  core: LifeOpsIdentityObservationCoreAdapter;
  options?: LifeOpsIdentityObservationOptions;
}): Promise<LifeOpsIdentityObservationIngestionResult> {
  const plan = planIdentityObservationIngestion(
    args.observations,
    args.options,
  );

  if (args.core.recordIdentityObservation) {
    await Promise.all(
      plan.normalizedObservations.map((observation) =>
        args.core.recordIdentityObservation?.(observation),
      ),
    );
  }

  const groups = groupObservations(plan.normalizedObservations);
  const candidatesByObservationId = new Map<
    string,
    LifeOpsCoreIdentityCandidate[]
  >();

  await Promise.all(
    plan.normalizedObservations.map(async (observation) => {
      const candidates = await args.core.findCandidatePeople(
        lookupFromObservation(observation),
      );
      candidatesByObservationId.set(
        observation.id,
        dedupeCandidates(candidates),
      );
    }),
  );

  const proposedMerges: Array<
    LifeOpsIdentityMergeProposalPayload & {
      candidateId: string;
    }
  > = [];
  const threshold =
    args.options?.mergeProposalThreshold ?? DEFAULT_MERGE_PROPOSAL_THRESHOLD;

  for (const group of groups) {
    const groupConflicts = plan.conflicts.filter((conflict) =>
      conflict.observationIds.every((id) =>
        group.summary.observationIds.includes(id),
      ),
    );
    if (groupConflicts.some((conflict) => conflict.severity === "blocking")) {
      continue;
    }

    const candidates = dedupeCandidates(
      group.observations.flatMap(
        (observation) => candidatesByObservationId.get(observation.id) ?? [],
      ),
    );
    if (candidates.length < 2 || group.summary.confidence < threshold) {
      continue;
    }

    for (const [entityA, entityB] of candidatePairs(candidates)) {
      const payload = mergeProposalPayload({
        entityA: entityA.primaryEntityId,
        entityB: entityB.primaryEntityId,
        group,
        conflicts: groupConflicts,
      });
      const receipt = await args.core.proposeMerge(payload);
      proposedMerges.push({
        ...payload,
        candidateId: receipt.candidateId,
      });
    }
  }

  return {
    ...plan,
    proposedMerges,
  };
}

function lookupFromObservation(
  observation: NormalizedLifeOpsIdentityObservation,
): LifeOpsIdentityCandidateLookup {
  return {
    observationId: observation.id,
    displayNames: observation.names.map((name) => name.name),
    identifiers: observation.identifiers,
    privacyScope: observation.privacyScope,
  };
}

function dedupeCandidates(
  candidates: LifeOpsCoreIdentityCandidate[],
): LifeOpsCoreIdentityCandidate[] {
  const byId = new Map<string, LifeOpsCoreIdentityCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.primaryEntityId, candidate);
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.primaryEntityId.localeCompare(right.primaryEntityId),
  );
}

function candidatePairs(
  candidates: LifeOpsCoreIdentityCandidate[],
): Array<[LifeOpsCoreIdentityCandidate, LifeOpsCoreIdentityCandidate]> {
  const pairs: Array<
    [LifeOpsCoreIdentityCandidate, LifeOpsCoreIdentityCandidate]
  > = [];
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const leftCandidate = candidates[left];
      const rightCandidate = candidates[right];
      if (leftCandidate && rightCandidate) {
        pairs.push([leftCandidate, rightCandidate]);
      }
    }
  }
  return pairs;
}

function mergeProposalPayload(args: {
  entityA: string;
  entityB: string;
  group: ObservationGroup;
  conflicts: LifeOpsIdentityConflict[];
}): LifeOpsIdentityMergeProposalPayload {
  return {
    kind: "identity_merge",
    status: "proposed",
    source: "lifeops.identity_observations",
    entityA: args.entityA,
    entityB: args.entityB,
    confidence: args.group.summary.confidence,
    requiresExplicitConfirmation: true,
    observationIds: args.group.summary.observationIds,
    preferredDisplayName: args.group.summary.displayName,
    privacyScope: args.group.summary.privacyScope,
    matchedIdentifiers: args.group.summary.identifiers,
    conflicts: args.conflicts,
    evidence: {
      source: "lifeops.identity_observations",
      status: "proposed",
      requiresExplicitConfirmation: true,
      observationIds: args.group.summary.observationIds,
      sources: args.group.summary.sources,
      displayName: args.group.summary.displayName,
      confidence: args.group.summary.confidence,
      privacyScope: args.group.summary.privacyScope,
      identifiers: {
        emails: args.group.summary.identifiers.emails,
        phones: args.group.summary.identifiers.phones,
        handles: args.group.summary.identifiers.handles.map((handle) => ({
          platform: handle.platform,
          handle: handle.handle,
          verified: handle.verified,
        })),
      },
    },
  };
}

export function plannerContextFromIdentityPlan(
  plan: Pick<LifeOpsIdentityObservationPlan, "summaries">,
): LifeOpsPlannerIdentityContext {
  return {
    identities: plan.summaries
      .filter((summary) => summary.privacyScope === "planner_visible")
      .map((summary) => ({
        displayName: summary.displayName,
        confidence: summary.confidence,
        sources: summary.sources,
        emails: summary.identifiers.emails,
        phones: summary.identifiers.phones,
        handles: summary.identifiers.handles.map((handle) => ({
          platform: handle.platform,
          handle: handle.handle,
        })),
      })),
  };
}

export function createRelationshipsGraphIdentityObservationAdapter(
  graph: RelationshipsGraphIdentityObservationAdapterInput,
): LifeOpsIdentityObservationCoreAdapter {
  return {
    async findCandidatePeople(lookup) {
      const hasStrongLookup =
        lookup.identifiers.emails.length > 0 ||
        lookup.identifiers.phones.length > 0 ||
        lookup.identifiers.handles.length > 0;
      const snapshot = await graph.getGraphSnapshot({
        search: hasStrongLookup ? null : (lookup.displayNames[0] ?? null),
        scope: "all",
        limit: 200,
      });
      return snapshot.people
        .filter((person) => personMatchesLookup(person, lookup))
        .map(personToCoreCandidate);
    },
    async proposeMerge(proposal) {
      const candidateId = await graph.proposeMerge(
        proposal.entityA,
        proposal.entityB,
        proposal.evidence,
      );
      return { candidateId };
    },
  };
}

function personToCoreCandidate(
  person: RelationshipsGraphPersonLike,
): LifeOpsCoreIdentityCandidate {
  const handles = new Map<string, NormalizedLifeOpsIdentityHandle>();
  for (const identity of person.identities ?? []) {
    for (const handle of identity.handles ?? []) {
      const normalized = normalizeIdentityHandle(
        handle.platform,
        handle.handle,
      );
      if (normalized) {
        handles.set(identityHandleKey(normalized), {
          ...normalized,
          verified: handle.verified === true,
        });
      }
    }
  }
  return {
    primaryEntityId: person.primaryEntityId,
    displayName: person.displayName,
    aliases: person.aliases ?? [],
    emails: uniqueSorted(
      (person.emails ?? []).flatMap((email) => {
        const normalized = normalizeEmail(email);
        return normalized ? [normalized] : [];
      }),
    ),
    phones: uniqueSorted(
      (person.phones ?? []).flatMap((phone) => {
        const normalized = normalizePhone(phone);
        return normalized ? [normalized] : [];
      }),
    ),
    handles: Array.from(handles.values()),
  };
}

function personMatchesLookup(
  person: RelationshipsGraphPersonLike,
  lookup: LifeOpsIdentityCandidateLookup,
): boolean {
  const candidate = personToCoreCandidate(person);
  if (hasIntersect(candidate.emails ?? [], lookup.identifiers.emails)) {
    return true;
  }
  if (hasIntersect(candidate.phones ?? [], lookup.identifiers.phones)) {
    return true;
  }

  const personHandles = new Set(
    (candidate.handles ?? []).map((handle) => identityHandleKey(handle)),
  );
  if (
    lookup.identifiers.handles.some((handle) =>
      personHandles.has(identityHandleKey(handle)),
    )
  ) {
    return true;
  }

  if (
    lookup.identifiers.emails.length > 0 ||
    lookup.identifiers.phones.length > 0 ||
    lookup.identifiers.handles.length > 0
  ) {
    return false;
  }

  const names = [candidate.displayName, ...(candidate.aliases ?? [])].map(
    (name) => normalizedName(name),
  );
  return lookup.displayNames.some((name) =>
    names.includes(normalizedName(name)),
  );
}
