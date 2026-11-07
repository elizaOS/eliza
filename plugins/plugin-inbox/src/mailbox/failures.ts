/**
 * Failure classification, attachment refusal and account disconnect for the
 * managed Gmail mailbox. Shared by Inbox and Settings surfaces. No provider
 * content is stored here.
 */
import type { GmailAccount } from "./types.ts";

/**
 * Host transports report their own protocol failures. Both names are
 * recognised so a host keeps its existing error class: `CloudProtocolError` is
 * the phone client's, `ManagedGmailProtocolError` is this module's default.
 * Duck-typed so errors from another module instance (tests, sandboxes) classify
 * the same way.
 */
export const MANAGED_PROTOCOL_ERROR_NAMES: readonly string[] = Object.freeze([
  "CloudProtocolError",
  "ManagedGmailProtocolError",
]);

export class ManagedGmailProtocolError extends Error {
  readonly code: "invalid-response" | "http";
  readonly status?: number;
  readonly data?: unknown;

  constructor(
    code: "invalid-response" | "http",
    status?: number,
    data?: unknown,
  ) {
    super(`Managed Gmail ${code}${status ? ` (${status})` : ""}`);
    this.name = "ManagedGmailProtocolError";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function protocolFailure(
  error: unknown,
): { code: unknown; status: unknown } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return typeof candidate.name === "string" &&
    MANAGED_PROTOCOL_ERROR_NAMES.includes(candidate.name)
    ? { code: candidate.code, status: candidate.status }
    : null;
}

/**
 * A file this client's own checks refused: its bytes do not match the declared
 * type, it is larger than allowed, or its name or encoding is unsafe. It is a
 * decision about the file, not a provider or network failure, so it is never
 * reported as Gmail being unavailable and retrying cannot change it.
 */
export class AttachmentRefusedError extends Error {
  constructor(message = "Attachment refused") {
    super(message);
    this.name = "AttachmentRefusedError";
  }
}

/** Duck-typed so a refusal from another module instance is recognised the same way. */
export const attachmentRefused = (error: unknown): boolean =>
  error instanceof AttachmentRefusedError ||
  (!!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AttachmentRefusedError");

/**
 * `refused` is this client's own refusal of an attachment's bytes, name or
 * size: Gmail answered, and a retry would get the same file.
 */
export type GmailFailureKind =
  | "offline"
  | "revoked"
  | "stale"
  | "unavailable"
  | "refused";

export interface GmailFailure {
  kind: GmailFailureKind;
  message: string;
}

const messages: Record<
  GmailFailureKind,
  Record<"read" | "operation", string>
> = {
  offline: {
    read: "You appear to be offline. Gmail was not reached. Retry when you are connected.",
    // A request may have reached Gmail before the connection dropped, so this does not claim no change.
    operation:
      "You appear to be offline. Gmail may not have received this change. When you are connected, check the saved receipt before trying again.",
  },
  revoked: {
    read: "Gmail access was revoked or needs authorization again. Reconnect Gmail, then retry.",
    operation:
      "Gmail no longer allows this change for the selected account. Reconnect Gmail, then retry. Nothing was changed.",
  },
  stale: {
    read: "This message changed in Gmail. Retry to load its current version.",
    operation:
      "This message changed in Gmail since it was loaded. Retry to reload it; nothing was changed.",
  },
  refused: {
    read: "This attachment does not match its type or is too large. It was not opened or saved.",
    operation:
      "An attachment does not match its type or is too large, so this review was refused. Nothing was sent or changed.",
  },
  unavailable: {
    read: "Gmail is unavailable right now. Retry, or check the connection.",
    operation:
      "Mail operation unavailable. Check its receipt before trying again.",
  },
};

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * Classifies a failed Gmail request. Reads and reviewed operations interpret
 * HTTP 409 differently: the managed read routes use 409 for a grant that needs
 * authorization again, while operation review uses it for a message or draft
 * that changed after it was loaded.
 */
export function classifyGmailFailure(
  error: unknown,
  context: "read" | "operation",
  isOnline = online(),
): GmailFailure {
  const result = (kind: GmailFailureKind): GmailFailure => ({
    kind,
    message: messages[kind][context],
  });
  // A refusal is decided on this device from bytes already received, so it holds offline too.
  if (attachmentRefused(error)) return result("refused");
  if (!isOnline) return result("offline");
  const failure = protocolFailure(error);
  if (failure) {
    if (failure.code !== "http") return result("unavailable");
    const status = failure.status;
    if (status === 403 || status === 404) return result("revoked");
    if (status === 409) return result(context === "read" ? "revoked" : "stale");
    return result("unavailable");
  }
  // Transport failures only; a TypeError from a programming fault is not reported as offline.
  if (
    error instanceof Error &&
    /network|offline|timed out|failed to fetch|load failed|internet/i.test(
      error.message,
    )
  )
    return result("offline");
  return result("unavailable");
}

/**
 * The client reports its own checks of a returned attachment (bytes against the
 * declared type, size, hash and name) as an invalid response. For an attachment
 * download that response is the file itself failing those checks, so it is
 * rethrown as a refusal; every other failure is unchanged.
 */
export function attachmentReadFailure(error: unknown): unknown {
  const failure = protocolFailure(error);
  return failure?.code === "invalid-response"
    ? new AttachmentRefusedError()
    : error;
}

export type GmailDisconnectOutcome =
  | "disconnected"
  | "still-connected"
  | "unconfirmed";

export interface GmailDisconnectClient {
  disconnectGmail(connectionId: string, signal: AbortSignal): Promise<void>;
  gmailAccounts(signal: AbortSignal): Promise<GmailAccount[]>;
}

/**
 * One explicit disconnect request, then a read-back. Never retried
 * automatically: a lost response is reported as unconfirmed so the user can
 * check the current state.
 */
export async function disconnectGmailAccount(
  client: GmailDisconnectClient,
  connectionId: string,
  signal: AbortSignal,
): Promise<{
  outcome: GmailDisconnectOutcome;
  accounts: GmailAccount[] | null;
}> {
  try {
    await client.disconnectGmail(connectionId, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    // A rejected request may still have been applied; read back before reporting.
    try {
      const accounts = await client.gmailAccounts(signal);
      const current = accounts.find(
        (account) => account.connectionId === connectionId,
      );
      return {
        outcome: current?.connected ? "unconfirmed" : "disconnected",
        accounts,
      };
    } catch {
      if (signal.aborted) throw error;
      return { outcome: "unconfirmed", accounts: null };
    }
  }
  try {
    const accounts = await client.gmailAccounts(signal);
    const current = accounts.find(
      (account) => account.connectionId === connectionId,
    );
    return {
      outcome: current?.connected ? "still-connected" : "disconnected",
      accounts,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { outcome: "unconfirmed", accounts: null };
  }
}

export function disconnectMessage(
  outcome: GmailDisconnectOutcome,
  label: string,
): string {
  if (outcome === "disconnected")
    return `${label} is disconnected. Cloud no longer holds its Gmail access. No mail was deleted; local drafts stay on this phone until you discard them. Google may still list the app in your Google Account permissions.`;
  if (outcome === "still-connected")
    return `Disconnect was requested, but Gmail still reports ${label} as connected. Check the connection again.`;
  return `Disconnect of ${label} was not confirmed. Check the connection to see its current state before trying again.`;
}
