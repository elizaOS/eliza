/**
 * Gmail send-target MessageConnector: advertises Gmail as a cross-connector
 * send surface so `MESSAGE op=send source=gmail` (aliases "email"/"mail") and
 * email-literal targets resolve to a real transport instead of
 * SOURCE_CONNECTOR_NOT_FOUND, and routes delivery through
 * `GoogleWorkspaceService.sendGmailMessage`.
 *
 * Recipient resolution is gated by the IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE
 * runtime setting. Legacy mode (default, while claim ingestion from issue
 * #23099 is unshipped): a literal address on the target is used as-is and an
 * entity UUID resolves through the entity's stored email component data. Claim
 * mode: a principal UUID always resolves through the canonical identity
 * service's active verified Google claim scoped to the selected connector
 * account; a carried channelId cannot override that authority. Account
 * routing is `connector`-scoped: the handler honors an explicit
 * target accountId, else the sole policy-authorized, gmail-send-capable Google
 * account, and refuses with a structural not_delivered when the account choice
 * is unauthorized, ambiguous, or absent. Subject comes from `content.metadata.subject`
 * when the planner supplies one, else the first line of the body clipped to a
 * sane header length. Registered by the Google connector-account provider at
 * plugin init.
 */
import {
  type ConnectorAccount,
  type ConnectorAccountAccessGate,
  type ConnectorAccountPurpose,
  type ConnectorAccountStatus,
  type Content,
  getConnectorAccountManager,
  type IAgentRuntime,
  IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE_SETTING,
  type IdentityClaim,
  type IdentityDeliveryClaimResolution,
  identityDeliveryClaimsAuthoritative,
  type MessageConnectorRegistration,
  type MessageConnectorTarget,
  type PrincipalService,
  type SendHandlerOutcome,
  ServiceType,
  type TargetInfo,
  toWellFormedUnicode,
  type UUID,
} from "@elizaos/core";
import { GOOGLE_SERVICE_NAME } from "./types.js";

export const GMAIL_MESSAGE_SOURCE = "gmail";

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_COMPONENT_KEYS = ["email", "emailAddress"] as const;
const GMAIL_SEND_ACCOUNT_STATUSES: ConnectorAccountStatus[] = ["connected"];
const GMAIL_SEND_ACCOUNT_PURPOSES: ConnectorAccountPurpose[] = ["messaging"];
const GMAIL_SEND_ACCOUNT_ACCESS_GATES: ConnectorAccountAccessGate[] = ["open", "owner_binding"];

/** True when the value is a deliverable literal email address. */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && EMAIL_ADDRESS_PATTERN.test(value.trim());
}

function emailLiteral(value: unknown): string | undefined {
  return isEmailAddress(value) ? String(value).trim() : undefined;
}

interface GmailSendCapableService {
  sendGmailMessage(params: {
    accountId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyText: string;
  }): Promise<{ messageId: string | null; threadId: string | null }>;
}

function getGmailSendService(runtime: IAgentRuntime): GmailSendCapableService | null {
  const service = runtime.getService(GOOGLE_SERVICE_NAME);
  return service &&
    typeof service === "object" &&
    typeof Reflect.get(service, "sendGmailMessage") === "function"
    ? (service as unknown as GmailSendCapableService)
    : null;
}

function accountSupportsGmailSend(account: ConnectorAccount): boolean {
  if (account.status !== "connected") return false;
  const granted = account.metadata?.grantedCapabilities;
  // Accounts predating capability metadata carry no grant list; treat them as
  // send-capable and let the Gmail API be the authority at call time.
  if (!Array.isArray(granted)) return true;
  return granted.some((capability) => capability === "gmail.send");
}

async function accountIsAuthorizedForGmailSend(
  runtime: IAgentRuntime,
  account: ConnectorAccount
): Promise<boolean> {
  if (!accountSupportsGmailSend(account)) return false;
  const evaluation = await getConnectorAccountManager(runtime).evaluatePolicy(
    {
      provider: GOOGLE_SERVICE_NAME,
      statuses: GMAIL_SEND_ACCOUNT_STATUSES,
      purposes: GMAIL_SEND_ACCOUNT_PURPOSES,
      accessGates: GMAIL_SEND_ACCOUNT_ACCESS_GATES,
      required: true,
    },
    { accountId: account.id, purpose: "messaging" }
  );
  return evaluation.allowed && evaluation.account?.id === account.id;
}

async function resolveGmailAccountId(
  runtime: IAgentRuntime,
  requested: string | undefined
): Promise<{ accountId: string } | { error: SendHandlerOutcome }> {
  if (requested?.trim()) {
    const accountId = requested.trim();
    const manager = getConnectorAccountManager(runtime);
    const account = await manager.getAccount(GOOGLE_SERVICE_NAME, accountId);
    if (
      !account ||
      account.id !== accountId ||
      !(await accountIsAuthorizedForGmailSend(runtime, account))
    ) {
      return {
        error: {
          kind: "not_delivered",
          code: "GMAIL_ACCOUNT_UNAVAILABLE",
          message:
            "The requested Google account is not connected and authorized with the gmail.send capability.",
        },
      };
    }
    return { accountId };
  }
  const listedAccounts =
    await getConnectorAccountManager(runtime).listAccounts(GOOGLE_SERVICE_NAME);
  const authorized = await Promise.all(
    listedAccounts.map(async (account) => ({
      account,
      allowed: await accountIsAuthorizedForGmailSend(runtime, account),
    }))
  );
  const accounts = authorized.filter(({ allowed }) => allowed).map(({ account }) => account);
  const sole = accounts.length === 1 ? accounts[0] : undefined;
  if (sole) {
    return { accountId: sole.id };
  }
  if (accounts.length === 0) {
    return {
      error: {
        kind: "not_delivered",
        code: "GMAIL_ACCOUNT_UNAVAILABLE",
        message:
          "No connected Google account with the gmail.send capability. Connect a Google account (Gmail send scope) before sending email.",
      },
    };
  }
  return {
    error: {
      kind: "not_delivered",
      code: "GMAIL_ACCOUNT_AMBIGUOUS",
      message: `Multiple Google accounts can send email (${accounts
        .map((account) => account.displayHandle ?? account.id)
        .join(", ")}). Specify accountId to pick one.`,
    },
  };
}

type RecipientResolution =
  | {
      kind: "resolved";
      email: string;
      identityClaim?: {
        claimId: UUID;
        canonicalPrincipalId: UUID;
        connectorAccountId: UUID;
        generation: number;
        deliveryKey: string;
      };
    }
  | { kind: "unresolved"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Legacy (pre-claim-authority) recipient resolution: a literal target address
 * wins; otherwise the entity graph must yield exactly one distinct stored
 * email (across explicitly email-named component fields, or — only when no
 * named field exists — email-shaped component values). Multiple distinct
 * candidates refuse rather than guess, so a contact with work + personal
 * addresses never gets mail routed by component iteration order. Active only
 * while IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE is off.
 */
async function resolveLegacyRecipientEmail(
  runtime: IAgentRuntime,
  target: TargetInfo
): Promise<RecipientResolution> {
  const literal = emailLiteral(target.channelId) ?? emailLiteral(target.entityId);
  if (literal) return { kind: "resolved", email: literal };

  const entityId = String(target.entityId ?? "").trim();
  if (!UUID_PATTERN.test(entityId) || typeof runtime.getEntityById !== "function") {
    return { kind: "unresolved", reason: "target carries no literal address or entity id" };
  }
  const entity = await runtime.getEntityById(entityId as UUID);
  if (!entity) return { kind: "unresolved", reason: "entity not found" };

  const named = new Set<string>();
  const emailShaped = new Set<string>();
  for (const component of entity.components ?? []) {
    const data = component.data ?? {};
    for (const key of EMAIL_COMPONENT_KEYS) {
      const value = emailLiteral(data[key]);
      if (value) named.add(value.toLowerCase());
    }
    for (const value of Object.values(data)) {
      const email = emailLiteral(value);
      if (email) emailShaped.add(email.toLowerCase());
    }
  }

  const candidates = named.size > 0 ? named : emailShaped;
  if (candidates.size === 0) {
    return { kind: "unresolved", reason: "the contact has no stored email address" };
  }
  if (candidates.size > 1) return { kind: "ambiguous", candidates: [...candidates].sort() };
  return { kind: "resolved", email: [...candidates][0] };
}

/** The lowercased deliverable address a verified Google claim carries, if any. */
function claimEmail(claim: IdentityClaim): string | undefined {
  const email = emailLiteral(claim.handle) ?? emailLiteral(claim.externalSubjectId);
  return email?.toLowerCase();
}

/**
 * Resolve the recipient address fail-closed under claim authority. A literal
 * target is explicit only when the target does not also identify a principal
 * UUID; principal delivery must yield exactly one distinct deliverable address
 * across the active, verified Google claims observed through the selected
 * sending account. Multiple distinct addresses refuse rather than guess, and
 * legacy entity components are never consulted as recipient authority.
 */
async function resolveRecipientEmail(
  runtime: IAgentRuntime,
  target: TargetInfo,
  connectorAccountId: string,
  expectedClaim?: {
    claimId: string;
    canonicalPrincipalId: string;
    connectorAccountId: string;
    generation: number;
    deliveryKey: string;
  }
): Promise<RecipientResolution> {
  const entityId = String(target.entityId ?? "").trim();
  if (!UUID_PATTERN.test(entityId)) {
    const literal = emailLiteral(target.channelId) ?? emailLiteral(target.entityId);
    if (literal) return { kind: "resolved", email: literal };
    return { kind: "unresolved", reason: "target is not a canonical principal UUID" };
  }
  if (!UUID_PATTERN.test(connectorAccountId)) {
    return { kind: "unavailable", reason: "connector account id is not canonical" };
  }
  const principalService = runtime.getService<PrincipalService>(ServiceType.PRINCIPAL);
  if (!principalService) {
    return { kind: "unavailable", reason: "canonical principal service is not registered" };
  }
  let resolution: IdentityDeliveryClaimResolution;
  try {
    resolution = await principalService.resolveIdentityDeliveryClaim({
      agentId: runtime.agentId,
      principalId: entityId as UUID,
      connectorId: GOOGLE_SERVICE_NAME,
      connectorAccountId: connectorAccountId as UUID,
    });
  } catch (error) {
    // error-policy:J4 identity authority failures are structurally refused and
    // reported; an address carried in target.channelId cannot bypass the read.
    runtime.reportError("gmail.resolveIdentityDeliveryClaim", error, {
      principalId: entityId,
      connectorAccountId,
    });
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (resolution.decision === "no_claim") {
    return { kind: "unresolved", reason: resolution.reason };
  }
  if (resolution.decision === "ambiguous") {
    // Ambiguity is judged on distinct deliverable addresses, not raw claim
    // rows: one address observed by several claims (for example as both
    // handle and subject id) is a single destination and must resolve.
    const claimsByEmail = new Map<string, IdentityClaim>();
    for (const claim of resolution.claims) {
      const email = claimEmail(claim);
      if (email && !claimsByEmail.has(email)) claimsByEmail.set(email, claim);
    }
    if (claimsByEmail.size === 0) {
      return {
        kind: "unresolved",
        reason: "verified claims contain no deliverable email address",
      };
    }
    if (claimsByEmail.size > 1) {
      return { kind: "ambiguous", candidates: [...claimsByEmail.keys()].sort() };
    }
    const evidenceClaim = expectedClaim
      ? resolution.claims.find((claim) => claim.id === expectedClaim.claimId)
      : [...claimsByEmail.values()][0];
    if (!evidenceClaim) {
      return {
        kind: "unavailable",
        reason: "canonical delivery claim changed after target selection",
      };
    }
    return claimRecipientResolution(
      evidenceClaim,
      resolution.canonicalPrincipalId,
      resolution.generation,
      expectedClaim
    );
  }
  return claimRecipientResolution(
    resolution.claim,
    resolution.canonicalPrincipalId,
    resolution.generation,
    expectedClaim
  );
}

/**
 * Finalize a single verified claim into a resolved recipient, revalidating
 * the planner-carried claim evidence so an identity change between target
 * selection and dispatch refuses instead of silently rerouting.
 */
function claimRecipientResolution(
  claim: IdentityClaim,
  canonicalPrincipalId: UUID,
  generation: number,
  expectedClaim?: {
    claimId: string;
    canonicalPrincipalId: string;
    connectorAccountId: string;
    generation: number;
    deliveryKey: string;
  }
): RecipientResolution {
  const normalizedEmail = claimEmail(claim);
  if (!normalizedEmail) {
    return { kind: "unresolved", reason: "verified claim has no deliverable email address" };
  }
  if (
    expectedClaim &&
    (expectedClaim.claimId !== claim.id ||
      expectedClaim.canonicalPrincipalId !== canonicalPrincipalId ||
      expectedClaim.connectorAccountId !== claim.connectorAccountId ||
      expectedClaim.generation !== generation ||
      expectedClaim.deliveryKey.toLowerCase() !== normalizedEmail)
  ) {
    return {
      kind: "unavailable",
      reason: "canonical delivery claim changed after target selection",
    };
  }
  return {
    kind: "resolved",
    email: normalizedEmail,
    identityClaim: {
      claimId: claim.id,
      canonicalPrincipalId,
      connectorAccountId: claim.connectorAccountId,
      generation,
      deliveryKey: normalizedEmail,
    },
  };
}

type ExpectedIdentityClaimRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | {
      kind: "present";
      claimId: string;
      canonicalPrincipalId: string;
      connectorAccountId: string;
      generation: number;
      deliveryKey: string;
    };

function expectedIdentityClaim(content: Content): ExpectedIdentityClaimRead {
  const metadata = content.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { kind: "absent" };
  }
  const value = (metadata as Record<string, unknown>).identityDeliveryClaim;
  if (value === undefined) return { kind: "absent" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.claimId !== "string" ||
    typeof evidence.canonicalPrincipalId !== "string" ||
    typeof evidence.connectorAccountId !== "string" ||
    typeof evidence.generation !== "number" ||
    typeof evidence.deliveryKey !== "string"
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "present",
    claimId: evidence.claimId,
    canonicalPrincipalId: evidence.canonicalPrincipalId,
    connectorAccountId: evidence.connectorAccountId,
    generation: evidence.generation,
    deliveryKey: evidence.deliveryKey,
  };
}

function subjectFromContent(content: Content): string {
  const metadata = content.metadata;
  const explicit =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).subject
      : undefined;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return toWellFormedUnicode(explicit.trim());
  }
  const firstLine = toWellFormedUnicode(
    String(content.text ?? "")
      .split("\n", 1)[0]
      .trim()
  );
  return firstLine;
}

async function sendGmailFromTarget(
  runtime: IAgentRuntime,
  target: TargetInfo,
  content: Content
): Promise<SendHandlerOutcome | undefined> {
  const service = getGmailSendService(runtime);
  if (!service) {
    return {
      kind: "not_delivered",
      code: "GMAIL_SERVICE_UNAVAILABLE",
      message: "The Google Workspace service is not running; Gmail send is unavailable.",
    };
  }

  const account = await resolveGmailAccountId(runtime, target.accountId);
  if ("error" in account) {
    return account.error;
  }

  const claimsAuthoritative = identityDeliveryClaimsAuthoritative(
    runtime.getSetting(IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE_SETTING)
  );
  let resolution: RecipientResolution;
  if (claimsAuthoritative) {
    const expectedClaim = expectedIdentityClaim(content);
    if (expectedClaim.kind === "invalid") {
      return {
        kind: "not_delivered",
        code: "GMAIL_IDENTITY_AUTHORITY_UNAVAILABLE",
        message: "Canonical identity evidence is malformed; refusing to send.",
      };
    }
    resolution = await resolveRecipientEmail(
      runtime,
      target,
      account.accountId,
      expectedClaim.kind === "present" ? expectedClaim : undefined
    );
  } else {
    resolution = await resolveLegacyRecipientEmail(runtime, target);
  }
  if (resolution.kind === "unresolved") {
    return {
      kind: "not_delivered",
      code: "GMAIL_RECIPIENT_UNRESOLVED",
      message: claimsAuthoritative
        ? `Could not resolve an active verified email claim for the recipient (${resolution.reason}). Provide a literal address or verify the contact's Google identity.`
        : `Could not resolve an email address for the recipient (${resolution.reason}). Provide a literal address (name@example.com) or a contact with a stored email.`,
    };
  }
  if (resolution.kind === "unavailable") {
    return {
      kind: "not_delivered",
      code: "GMAIL_IDENTITY_AUTHORITY_UNAVAILABLE",
      message: `Canonical identity authority is unavailable (${resolution.reason}); refusing to send.`,
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "not_delivered",
      code: "GMAIL_RECIPIENT_AMBIGUOUS",
      message: `The contact has multiple stored email addresses (${resolution.candidates.join(
        ", "
      )}). Provide the literal address to use.`,
    };
  }
  const recipient = resolution.email;

  const bodyText = String(content.text ?? "");
  const sent = await service.sendGmailMessage({
    accountId: account.accountId,
    to: [recipient],
    subject: subjectFromContent(content),
    bodyText,
  });

  const providerMessageId = sent.messageId ?? sent.threadId;
  if (!providerMessageId) {
    // The provider call may have been accepted, but without returned Gmail
    // evidence the connector cannot truthfully classify it as delivered.
    return undefined;
  }

  return {
    kind: "delivered",
    receipt: {
      providerMessageIds: [providerMessageId],
      acceptedAt: Date.now(),
      persistence: {
        status: "not_attempted",
        reason: "MESSAGE op=send owns outbound-memory persistence",
      },
    },
    memories: [],
  };
}

/**
 * Build the Gmail MessageConnector registration. `accountRouting: "connector"`
 * keeps one unscoped registration valid for every dynamically-connected Google
 * account; the send handler resolves the concrete account per delivery.
 */
export function createGmailMessageConnector(_runtime: IAgentRuntime): MessageConnectorRegistration {
  return {
    source: GMAIL_MESSAGE_SOURCE,
    label: "Gmail",
    accountRouting: "connector",
    capabilities: ["send_message"],
    supportedTargetKinds: ["email", "contact", "user"],
    contexts: ["email", "connectors"],
    description:
      "Send email through the connected Google account. Targets: a literal email address, or a contact with a stored email.",
    metadata: {
      aliases: ["email", "mail", "google mail"],
      service: GOOGLE_SERVICE_NAME,
    },
    resolveTargets: async (query): Promise<MessageConnectorTarget[]> => {
      const literal = emailLiteral(query);
      if (!literal) return [];
      return [
        {
          target: { source: GMAIL_MESSAGE_SOURCE, channelId: literal },
          label: literal,
          kind: "email",
          score: 0.95,
          contexts: ["email", "connectors"],
        },
      ];
    },
    resolveIdentityClaimTarget: (
      claim,
      _context,
      canonicalPrincipalId
    ): MessageConnectorTarget | null => {
      const email = emailLiteral(claim.handle) ?? emailLiteral(claim.externalSubjectId);
      if (!email) return null;
      return {
        target: {
          source: GMAIL_MESSAGE_SOURCE,
          entityId: canonicalPrincipalId,
          channelId: email.toLowerCase(),
        },
        identityDeliveryKey: email.toLowerCase(),
        label: email.toLowerCase(),
        kind: "email",
        score: 1,
        contexts: ["email", "connectors"],
      };
    },
    sendHandler: async (handlerRuntime, target, content) =>
      sendGmailFromTarget(handlerRuntime, target, content),
  };
}
