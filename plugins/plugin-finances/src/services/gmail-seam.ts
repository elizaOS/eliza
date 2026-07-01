/**
 * Gmail runtime-service seam for the subscriptions back-end.
 *
 * Subscription discovery scans the owner's recent Gmail for receipts /
 * renewals and scores them against the cancellation playbooks. It does NOT
 * need cross-channel triage — only a date-windowed Gmail search. This module
 * resolves the `@elizaos/plugin-google` runtime service
 * (`runtime.getService("google")`), derives the owner's Gmail grant from the
 * connector-account metadata + scopes, and exposes the single search the
 * subscriptions path uses.
 *
 * It is the focused sibling of `@elizaos/plugin-inbox`'s `google-gmail-seam`
 * and carries no dependency on `@elizaos/plugin-personal-assistant`: grant
 * derivation is reproduced here from the connector-account metadata (the same
 * mapping PA performs) so the grant is self-contained.
 */

import {
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import type {
  GoogleMessageSummary,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google";
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
  LifeOpsGoogleCapability,
} from "@elizaos/shared";
import { fail } from "../finance-normalize.ts";

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
}): Promise<ConnectorAccount | null> {
  const accounts = await listGoogleConnectorAccounts(
    args.runtime,
    args.requestedSide,
  );
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
): Record<string, unknown> {
  const service = runtime.getService("google");
  if (!isRecord(service)) {
    fail(
      503,
      "Google Workspace service is not registered. Enable @elizaos/plugin-google before scanning Gmail for subscriptions.",
    );
  }
  return service;
}

function requireSearchMessages(
  runtime: IAgentRuntime,
): IGoogleWorkspaceService["searchMessages"] {
  const service = requireGoogleWorkspaceService(runtime);
  const searchMessages = service.searchMessages;
  if (typeof searchMessages !== "function") {
    fail(
      501,
      "@elizaos/plugin-google does not expose searchMessages for subscription discovery.",
    );
  }
  return searchMessages.bind(
    service,
  ) as IGoogleWorkspaceService["searchMessages"];
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
 * The Gmail surface the subscriptions back-end needs, resolved from the runtime
 * so the service does not reach into `runtime.getService` itself.
 */
export interface SubscriptionsGmailGateway {
  /**
   * Search recent owner Gmail for subscription evidence. `windowDays` bounds
   * the search to the discovery window; messages are returned newest-first.
   * Throws (409/403/503) when Google is unconnected or Gmail is not granted.
   */
  searchSubscriptionMessages(args: {
    windowDays: number;
    maxResults: number;
    now?: Date;
  }): Promise<LifeOpsGmailMessageSummary[]>;
}

/**
 * Build the subscriptions Gmail gateway bound to a runtime. The owner mailbox
 * is scanned (the subscriptions path operates on the owner's receipts).
 */
export function createSubscriptionsGmailGateway(
  runtime: IAgentRuntime,
  agentId: string,
): SubscriptionsGmailGateway {
  return {
    async searchSubscriptionMessages(
      args,
    ): Promise<LifeOpsGmailMessageSummary[]> {
      const account = await resolveGoogleConnectorAccount({
        runtime,
        requestedSide: "owner",
      });
      if (account?.status !== "connected") {
        fail(409, "Google Gmail is not connected.");
      }
      const grant = grantFromAccount({ account, agentId });
      if (!grant.capabilities.includes("google.gmail.triage")) {
        fail(403, "Google Gmail triage access has not been granted.");
      }
      const searchMessages = requireSearchMessages(runtime);
      const syncedAt = (args.now ?? new Date()).toISOString();
      const windowDays = Math.max(
        1,
        Math.min(365, Math.trunc(args.windowDays)),
      );
      const googleMessages = await searchMessages({
        accountId: accountIdForGrant(grant),
        query: `in:inbox newer_than:${windowDays}d`,
        limit: args.maxResults,
      });
      return googleMessages.map((message) =>
        gmailMessageFromGoogle({ message, grant, agentId, syncedAt }),
      );
    },
  };
}
