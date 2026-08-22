/**
 * Gmail send-target MessageConnector: advertises Gmail as a cross-connector
 * send surface so `MESSAGE op=send source=gmail` (aliases "email"/"mail") and
 * email-literal targets resolve to a real transport instead of
 * SOURCE_CONNECTOR_NOT_FOUND, and routes delivery through
 * `GoogleWorkspaceService.sendGmailMessage`.
 *
 * Recipient resolution: a literal address on the target (channelId or
 * entityId) is used as-is — a typed address is unambiguous; an entity-store
 * UUID resolves through the entity's stored email handles (component data).
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
  type MessageConnectorRegistration,
  type MessageConnectorTarget,
  type SendHandlerOutcome,
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
  | { kind: "resolved"; email: string }
  | { kind: "unresolved" }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve the recipient address fail-closed: a literal target address wins;
 * otherwise the entity graph must yield exactly one distinct stored email
 * (across explicitly email-named component fields, or — only when no named
 * field exists — email-shaped component values). Multiple distinct candidates
 * refuse rather than guess, so a contact with work + personal addresses never
 * gets mail routed by component iteration order.
 */
async function resolveRecipientEmail(
  runtime: IAgentRuntime,
  target: TargetInfo
): Promise<RecipientResolution> {
  const literal = emailLiteral(target.channelId) ?? emailLiteral(target.entityId);
  if (literal) return { kind: "resolved", email: literal };

  const entityId = String(target.entityId ?? "").trim();
  if (!UUID_PATTERN.test(entityId) || typeof runtime.getEntityById !== "function") {
    return { kind: "unresolved" };
  }
  const entity = await runtime.getEntityById(entityId as UUID);
  if (!entity) return { kind: "unresolved" };

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
  if (candidates.size === 0) return { kind: "unresolved" };
  if (candidates.size > 1) return { kind: "ambiguous", candidates: [...candidates].sort() };
  return { kind: "resolved", email: [...candidates][0] };
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
): Promise<SendHandlerOutcome> {
  const service = getGmailSendService(runtime);
  if (!service) {
    return {
      kind: "not_delivered",
      code: "GMAIL_SERVICE_UNAVAILABLE",
      message: "The Google Workspace service is not running; Gmail send is unavailable.",
    };
  }

  const resolution = await resolveRecipientEmail(runtime, target);
  if (resolution.kind === "unresolved") {
    return {
      kind: "not_delivered",
      code: "GMAIL_RECIPIENT_UNRESOLVED",
      message:
        "Could not resolve an email address for the recipient. Provide a literal address (name@example.com) or a contact with a stored email.",
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

  const account = await resolveGmailAccountId(runtime, target.accountId);
  if ("error" in account) {
    return account.error;
  }

  const bodyText = String(content.text ?? "");
  const sent = await service.sendGmailMessage({
    accountId: account.accountId,
    to: [recipient],
    subject: subjectFromContent(content),
    bodyText,
  });

  return {
    kind: "delivered",
    receipt: {
      // Gmail returns the created message id on acceptance; the thread id is
      // the fallback evidence if the id field is ever absent on a 200.
      providerMessageIds: [
        sent.messageId ?? sent.threadId ?? `gmail:${account.accountId}:accepted`,
      ],
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
    sendHandler: async (handlerRuntime, target, content) =>
      sendGmailFromTarget(handlerRuntime, target, content),
  };
}
