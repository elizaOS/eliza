/**
 * Gmail send-target MessageConnector: advertises Gmail as a cross-connector
 * send surface so `MESSAGE op=send source=gmail` (aliases "email"/"mail") and
 * email-literal targets resolve to a real transport instead of
 * SOURCE_CONNECTOR_NOT_FOUND, and routes delivery through
 * `GoogleWorkspaceService.sendGmailMessage`.
 *
 * Recipient resolution: a literal address is used as-is when no principal
 * UUID is present. A principal UUID always resolves through the canonical
 * identity service's active verified Google claim scoped to the selected
 * connector account; a carried channelId cannot override that authority.
 * Account routing is `connector`-scoped: the handler honors an explicit
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
  type IdentityDeliveryClaimResolution,
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
 * Resolve the recipient address fail-closed. A literal target is explicit only
 * when the target does not also identify a principal UUID; principal delivery
 * must yield exactly one active, verified Google claim observed through the
 * selected sending account. Multiple claims refuse rather than guess, and
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
    const candidates = resolution.claims
      .flatMap((claim) => [claim.handle, claim.externalSubjectId])
      .filter(isEmailAddress)
      .map((email) => email.toLowerCase());
    const distinctCandidates = [...new Set(candidates)].sort();
    if (distinctCandidates.length === 0) {
      return {
        kind: "unresolved",
        reason: "verified claims contain no deliverable email address",
      };
    }
    return { kind: "ambiguous", candidates: distinctCandidates };
  }
  const email =
    emailLiteral(resolution.claim.handle) ?? emailLiteral(resolution.claim.externalSubjectId);
  if (!email) {
    return { kind: "unresolved", reason: "verified claim has no deliverable email address" };
  }
  const normalizedEmail = email.toLowerCase();
  if (
    expectedClaim &&
    (expectedClaim.claimId !== resolution.claim.id ||
      expectedClaim.canonicalPrincipalId !== resolution.canonicalPrincipalId ||
      expectedClaim.connectorAccountId !== resolution.claim.connectorAccountId ||
      expectedClaim.generation !== resolution.generation ||
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
      claimId: resolution.claim.id,
      canonicalPrincipalId: resolution.canonicalPrincipalId,
      connectorAccountId: resolution.claim.connectorAccountId,
      generation: resolution.generation,
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

  const expectedClaim = expectedIdentityClaim(content);
  if (expectedClaim.kind === "invalid") {
    return {
      kind: "not_delivered",
      code: "GMAIL_IDENTITY_AUTHORITY_UNAVAILABLE",
      message: "Canonical identity evidence is malformed; refusing to send.",
    };
  }
  const resolution = await resolveRecipientEmail(
    runtime,
    target,
    account.accountId,
    expectedClaim.kind === "present" ? expectedClaim : undefined
  );
  if (resolution.kind === "unresolved") {
    return {
      kind: "not_delivered",
      code: "GMAIL_RECIPIENT_UNRESOLVED",
      message: `Could not resolve an active verified email claim for the recipient (${resolution.reason}). Provide a literal address or verify the contact's Google identity.`,
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
