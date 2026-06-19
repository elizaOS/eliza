/**
 * Gmail runtime-service seam for the inbox unsubscribe back-end.
 *
 * The inbox plugin legitimately consumes Gmail. This module resolves the
 * `@elizaos/plugin-google` runtime service (`runtime.getService("google")`),
 * derives the account-scoped connector grant the unsubscribe path needs, and
 * exposes the narrow Gmail surface that surface uses: search, mailto/HTTP
 * unsubscribe send, sender-filter creation, and thread trashing.
 *
 * It is the focused successor to the resolver helpers the unsubscribe path used
 * out of PA's `google-plugin-delegates.ts` (`requireGoogleWorkspaceService`,
 * `requireGoogleServiceMethod`, `resolveGoogleConnectorAccount`,
 * `googleGrantFromAccount`, `accountIdForGrant`, the Gmail-triage grant gate).
 * It carries no dependency on `@elizaos/plugin-personal-assistant`; capability
 * derivation is reproduced here from the connector-account metadata/scopes
 * (the same mapping PA performs) so the grant is self-contained.
 */

import {
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import type {
  GoogleMessageSummary,
  GoogleParsedMailto,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google";
import {
  fail,
  type LifeOpsConnectorGrant,
  type LifeOpsConnectorSide,
  type LifeOpsGmailMessageSummary,
  type LifeOpsGmailSearchFeed,
  type LifeOpsGoogleCapability,
} from "@elizaos/shared";

const GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX = "connector-account:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function accountMetadata(account: ConnectorAccount): Record<string, unknown> {
  return isRecord(account.metadata) ? account.metadata : {};
}

function googleSideForAccount(
  account: Pick<ConnectorAccount, "role">,
): LifeOpsConnectorSide {
  return account.role === "AGENT" ? "agent" : "owner";
}

/**
 * Derive the Google capabilities granted to a connector account from its
 * metadata + granted OAuth scopes. Mirrors PA's grant derivation for the
 * Gmail-relevant subset (triage / send / manage); identity is always implied.
 */
function googleCapabilitiesForAccount(
  account: ConnectorAccount,
): LifeOpsGoogleCapability[] {
  const meta = accountMetadata(account);
  const scopes = stringArray(meta.grantedScopes);
  const capabilities = new Set<LifeOpsGoogleCapability>([
    "google.basic_identity",
  ]);
  if (scopes.some((scope) => scope.includes("gmail.readonly"))) {
    capabilities.add("google.gmail.triage");
  }
  if (scopes.some((scope) => scope.includes("gmail.send"))) {
    capabilities.add("google.gmail.send");
    capabilities.add("google.gmail.triage");
  }
  if (
    scopes.some(
      (scope) =>
        scope.includes("gmail.modify") || scope.includes("gmail.settings"),
    )
  ) {
    capabilities.add("google.gmail.manage");
    capabilities.add("google.gmail.triage");
  }
  return [...capabilities];
}

function googleAccountEmail(account: ConnectorAccount): string | null {
  const meta = accountMetadata(account);
  return (
    (
      stringValue(meta.email) ??
      stringValue(account.displayHandle) ??
      null
    )?.toLowerCase() ?? null
  );
}

function grantIdForAccount(accountId: string): string {
  return `${GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX}${accountId}`;
}

function accountIdFromGrantId(
  grantId: string | null | undefined,
): string | null {
  const normalized = stringValue(grantId);
  if (!normalized) return null;
  return normalized.startsWith(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX)
    ? normalized.slice(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX.length)
    : normalized;
}

function grantFromAccount(args: {
  account: ConnectorAccount;
  agentId: string;
}): LifeOpsConnectorGrant {
  const { account, agentId } = args;
  const capabilities = googleCapabilitiesForAccount(account);
  const meta = accountMetadata(account);
  const createdAt = new Date(account.createdAt).toISOString();
  const updatedAt = new Date(account.updatedAt).toISOString();
  return {
    id: grantIdForAccount(account.id),
    agentId,
    provider: "google",
    side: googleSideForAccount(account),
    identity: {},
    grantedScopes: stringArray(meta.grantedScopes),
    capabilities,
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: meta.isDefault === true,
    cloudConnectionId: null,
    connectorAccountId: account.id,
    identityEmail: googleAccountEmail(account),
    metadata: {
      ...meta,
      connectorAccountId: account.id,
      connectorAccountProvider: "google",
    },
    lastRefreshAt: updatedAt,
    createdAt,
    updatedAt,
  } as LifeOpsConnectorGrant;
}

async function listGoogleConnectorAccounts(
  runtime: IAgentRuntime,
  requestedSide?: LifeOpsConnectorSide,
): Promise<ConnectorAccount[]> {
  const manager = getConnectorAccountManager(runtime);
  const accounts = await manager.listAccounts("google");
  return accounts
    .filter(
      (account) =>
        account.status !== "disabled" && account.status !== "revoked",
    )
    .filter((account) =>
      requestedSide ? googleSideForAccount(account) === requestedSide : true,
    );
}

async function resolveGoogleConnectorAccount(args: {
  runtime: IAgentRuntime;
  requestedSide?: LifeOpsConnectorSide;
  grantId?: string | null;
}): Promise<ConnectorAccount | null> {
  const accountId = accountIdFromGrantId(args.grantId);
  const accounts = await listGoogleConnectorAccounts(
    args.runtime,
    args.requestedSide,
  );
  if (accountId) {
    return (
      accounts.find(
        (account) =>
          account.id === accountId ||
          account.externalId === accountId ||
          account.displayHandle === accountId,
      ) ?? null
    );
  }
  return (
    accounts.find(
      (account) =>
        account.status === "connected" &&
        accountMetadata(account).isDefault === true,
    ) ??
    accounts.find((account) => account.status === "connected") ??
    accounts[0] ??
    null
  );
}

function requireGoogleWorkspaceService(
  runtime: IAgentRuntime,
): IGoogleWorkspaceService {
  const service = runtime.getService("google");
  if (!service || typeof service !== "object") {
    fail(
      503,
      "Google Workspace service is not registered. Enable @elizaos/plugin-google before using inbox Gmail features.",
    );
  }
  return service as unknown as IGoogleWorkspaceService;
}

function requireGoogleServiceMethod<K extends keyof IGoogleWorkspaceService>(
  runtime: IAgentRuntime,
  method: K,
): IGoogleWorkspaceService[K] {
  const service = requireGoogleWorkspaceService(runtime);
  const fn = service[method];
  if (typeof fn !== "function") {
    fail(
      501,
      `@elizaos/plugin-google does not expose ${String(method)} for account-scoped inbox access.`,
    );
  }
  return (fn as (...args: unknown[]) => unknown).bind(
    service,
  ) as IGoogleWorkspaceService[K];
}

function accountIdForGrant(grant: LifeOpsConnectorGrant): string {
  return (
    stringValue(grant.connectorAccountId) ??
    accountIdFromGrantId(grant.id) ??
    fail(
      409,
      "Google connector account id is missing. Reconnect Google through connector account management.",
    )
  );
}

function gmailMessageFromGoogle(args: {
  message: GoogleMessageSummary;
  grant: LifeOpsConnectorGrant;
  agentId: string;
  syncedAt: string;
}): LifeOpsGmailMessageSummary {
  const { message, grant, agentId, syncedAt } = args;
  const labels = message.labelIds ?? [];
  const fromName = message.from?.name?.trim();
  const fromEmail = message.from?.email?.trim() ?? null;
  const externalId = message.id;
  const receivedAt = message.receivedAt ?? syncedAt;
  return {
    id: `${agentId}:google:${grant.side}:gmail:${externalId}`,
    externalId,
    agentId,
    provider: "google",
    side: grant.side,
    threadId: message.threadId ?? externalId,
    subject: message.subject ?? "(no subject)",
    from: fromName || fromEmail || "Unknown sender",
    fromEmail,
    replyTo: message.replyTo?.email ?? null,
    to: (message.to ?? []).map((item) => item.email),
    cc: (message.cc ?? []).map((item) => item.email),
    snippet: message.snippet ?? message.bodyText?.slice(0, 240) ?? "",
    receivedAt,
    isUnread: labels.includes("UNREAD"),
    isImportant: labels.includes("IMPORTANT"),
    likelyReplyNeeded: labels.includes("INBOX") && !labels.includes("SENT"),
    triageScore: labels.includes("IMPORTANT")
      ? 90
      : labels.includes("UNREAD")
        ? 70
        : 40,
    triageReason: labels.includes("IMPORTANT")
      ? "Marked important in Gmail."
      : labels.includes("UNREAD")
        ? "Unread inbox message."
        : "Recent Gmail message.",
    labels,
    htmlLink: null,
    metadata: {
      googlePlugin: true,
      headers: message.headers ?? {},
      bodyHtml: message.bodyHtml,
    },
    syncedAt,
    updatedAt: syncedAt,
    connectorAccountId: grant.connectorAccountId ?? undefined,
    grantId: grant.id,
    accountEmail: grant.identityEmail ?? undefined,
  };
}

/**
 * The Gmail surface the inbox unsubscribe back-end needs, resolved once from
 * the runtime so the service does not reach into `runtime.getService` itself.
 */
export interface InboxGmailGateway {
  /** Resolve the Gmail-triage grant (throws 409/403 if unconnected/ungranted). */
  requireGmailGrant(): Promise<LifeOpsConnectorGrant>;
  /** Search synced Gmail messages, returning a search feed with header metadata. */
  searchGmail(args: {
    grant: LifeOpsConnectorGrant;
    query: string;
    maxResults: number;
    includeSpamTrash?: boolean;
    now?: Date;
  }): Promise<LifeOpsGmailSearchFeed>;
  /** Send a List-Unsubscribe mailto request for the account behind the grant. */
  sendMailtoUnsubscribeEmail(
    accountId: string,
    mailto: GoogleParsedMailto,
  ): Promise<void>;
  /** Create a Gmail filter that trashes future mail from a sender. */
  createGmailFilterForSender(
    accountId: string,
    fromAddress: string,
  ): Promise<{ filterId: string | null }>;
  /** Trash an existing Gmail thread. */
  trashGmailThread(accountId: string, threadId: string): Promise<void>;
}

function summarizeSearch(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailSearchFeed["summary"] {
  return {
    totalCount: messages.length,
    unreadCount: messages.filter((message) => message.isUnread).length,
    importantCount: messages.filter((message) => message.isImportant).length,
    replyNeededCount: messages.filter((message) => message.likelyReplyNeeded)
      .length,
  };
}

/**
 * Build the inbox Gmail gateway bound to a runtime. `requestedSide` defaults to
 * the owner side (the unsubscribe path operates on the owner's mailbox).
 */
export function createInboxGmailGateway(
  runtime: IAgentRuntime,
  agentId: string,
  requestedSide: LifeOpsConnectorSide = "owner",
): InboxGmailGateway {
  return {
    async requireGmailGrant(): Promise<LifeOpsConnectorGrant> {
      const account = await resolveGoogleConnectorAccount({
        runtime,
        requestedSide,
      });
      if (account?.status !== "connected") {
        fail(409, "Google Gmail is not connected.");
      }
      const grant = grantFromAccount({ account, agentId });
      if (!grant.capabilities.includes("google.gmail.triage")) {
        fail(403, "Google Gmail triage access has not been granted.");
      }
      return grant;
    },

    async searchGmail(args): Promise<LifeOpsGmailSearchFeed> {
      const searchMessages = requireGoogleServiceMethod(
        runtime,
        "searchMessages",
      );
      const syncedAt = (args.now ?? new Date()).toISOString();
      const query = args.includeSpamTrash
        ? `${args.query} in:anywhere`
        : args.query;
      const googleMessages = await searchMessages({
        accountId: accountIdForGrant(args.grant),
        query,
        limit: args.maxResults,
      });
      const messages = googleMessages.map((message) =>
        gmailMessageFromGoogle({
          message,
          grant: args.grant,
          agentId,
          syncedAt,
        }),
      );
      return {
        query: args.query,
        messages,
        source: "synced",
        syncedAt,
        summary: summarizeSearch(messages),
      };
    },

    async sendMailtoUnsubscribeEmail(accountId, mailto): Promise<void> {
      const send = requireGoogleServiceMethod(
        runtime,
        "sendMailtoUnsubscribeEmail",
      );
      await send({ accountId, mailto });
    },

    async createGmailFilterForSender(
      accountId,
      fromAddress,
    ): Promise<{ filterId: string | null }> {
      const createFilter = requireGoogleServiceMethod(
        runtime,
        "createGmailFilterForSender",
      );
      const filter = await createFilter({
        accountId,
        fromAddress,
        trash: true,
      });
      return { filterId: filter.filterId };
    },

    async trashGmailThread(accountId, threadId): Promise<void> {
      const trash = requireGoogleServiceMethod(runtime, "trashGmailThread");
      await trash({ accountId, threadId });
    },
  };
}

export { accountIdForGrant };
