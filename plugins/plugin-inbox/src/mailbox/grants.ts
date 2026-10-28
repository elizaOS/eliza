/**
 * Incremental Gmail grants for the managed mailbox. A client asks first for
 * read access only. Mailbox changes (send, provider drafts, archive/trash/read
 * state) are asked for once, as one incremental "modify" consent, and only when
 * the user starts an approved mailbox action. Revoking either step, or switching
 * account or Cloud session, isolates what was read or prepared under the old grant.
 *
 * Capability names are Eliza Cloud's. Which Google OAuth scopes back them is
 * Cloud's contract, not this module's.
 */
import type {
  GmailAccount,
  GmailInboxCapabilities,
  GmailMailboxAction,
} from "./types.ts";

export const GMAIL_READ_CAPABILITY = "google.gmail.triage";
export const GOOGLE_IDENTITY_CAPABILITY = "google.basic_identity";
/** The modify step, requested together: Google shows one incremental consent, not three. */
export const GMAIL_MODIFY_CAPABILITIES: readonly string[] = Object.freeze([
  "google.gmail.send",
  "google.gmail.drafts",
  "google.gmail.mailbox",
]);
/** Every Gmail capability a reconnect may carry over from an existing grant. */
export const GMAIL_CAPABILITIES: readonly string[] = Object.freeze([
  GOOGLE_IDENTITY_CAPABILITY,
  GMAIL_READ_CAPABILITY,
  ...GMAIL_MODIFY_CAPABILITIES,
]);

export type GmailGrantStep = "read" | "modify";
export type GmailGrantTier = "none" | "readonly" | "modify";
/** Consent a client may start: the two incremental steps, or one change capability. */
export type GmailGrantRequest =
  | "read"
  | "modify"
  | "send"
  | "drafts"
  | "mailbox";

/** Cloud capabilities one initiation asks for. Read is always included: modify extends it. */
export function gmailCapabilitiesFor(step: GmailGrantStep): string[] {
  return [
    GOOGLE_IDENTITY_CAPABILITY,
    GMAIL_READ_CAPABILITY,
    ...(step === "modify" ? GMAIL_MODIFY_CAPABILITIES : []),
  ];
}

/**
 * Capabilities a consent request names. Cloud maps exactly the requested
 * capabilities to Google scopes, so the request also names what the selected
 * account already holds; otherwise a reconnect could drop an earlier grant.
 * Only known Gmail capabilities are carried over.
 */
export function gmailConsentCapabilities(
  permission: GmailGrantRequest,
  granted: readonly string[] = [],
): string[] {
  const requested =
    permission === "read" || permission === "modify"
      ? gmailCapabilitiesFor(permission)
      : [
          GOOGLE_IDENTITY_CAPABILITY,
          GMAIL_READ_CAPABILITY,
          permission === "send"
            ? "google.gmail.send"
            : permission === "drafts"
              ? "google.gmail.drafts"
              : "google.gmail.mailbox",
        ];
  const kept = granted.filter((capability) =>
    GMAIL_CAPABILITIES.includes(capability),
  );
  return [
    ...new Set([
      GOOGLE_IDENTITY_CAPABILITY,
      GMAIL_READ_CAPABILITY,
      ...kept,
      ...requested,
    ]),
  ];
}

/** The Cloud capability an approved mailbox action needs. */
export function requiredGmailCapability(kind: GmailMailboxAction): string {
  if (kind === "send") return "google.gmail.send";
  if (kind.startsWith("draft-")) return "google.gmail.drafts";
  return "google.gmail.mailbox";
}

/** The account is connected and holds the read grant. */
export function gmailReadable(
  account: GmailAccount | null | undefined,
): account is GmailAccount {
  return (
    !!account &&
    account.connected &&
    !!account.connectionId &&
    account.grantedCapabilities.includes(GMAIL_READ_CAPABILITY)
  );
}

export function gmailGrantTier(
  account: GmailAccount | null | undefined,
): GmailGrantTier {
  if (!gmailReadable(account)) return "none";
  return GMAIL_MODIFY_CAPABILITIES.every((capability) =>
    account.grantedCapabilities.includes(capability),
  )
    ? "modify"
    : "readonly";
}

/** Describe the actual incremental grant, including send-only consent. */
export function googleAccountAccessLabel(account: GmailAccount): string {
  const caps = account.grantedCapabilities;
  const gmail =
    gmailGrantTier(account) === "modify"
      ? "Read and change access"
      : caps.includes("google.gmail.send")
        ? "Read and send access"
        : caps.includes(GMAIL_READ_CAPABILITY)
          ? "Read access"
          : "Not authorized";
  const calendar = caps.includes("google.calendar.write")
    ? "Read and edit access"
    : caps.includes("google.calendar.read")
      ? "Read access"
      : "Not authorized";
  return `Connected · Gmail: ${gmail} · Calendar: ${calendar}`;
}

/** Whether the server's per-account inbox capabilities allow this action now. */
export function gmailInboxAllows(
  caps: GmailInboxCapabilities | null | undefined,
  kind: GmailMailboxAction,
): boolean {
  if (!caps) return false;
  return kind === "send"
    ? caps.send
    : kind.startsWith("draft-")
      ? caps.providerDrafts
      : caps.mailboxMutations;
}

/** True while any modify-step action is still unavailable for the selected account. */
export function gmailModifyIncomplete(
  caps: GmailInboxCapabilities | null | undefined,
): boolean {
  return !caps?.send || !caps.providerDrafts || !caps.mailboxMutations;
}

/**
 * Decides one approved mailbox action. `granted`: prepare the review. `upgrade`:
 * offer the single modify consent; nothing is prepared or dispatched.
 * `unreadable`: the account has no read grant.
 */
export function gmailActionGrant(
  account: GmailAccount | null | undefined,
  kind: GmailMailboxAction,
): "granted" | "upgrade" | "unreadable" {
  if (!gmailReadable(account)) return "unreadable";
  return account.grantedCapabilities.includes(requiredGmailCapability(kind))
    ? "granted"
    : "upgrade";
}

/**
 * Read-cache identity: provider content read under one key is shown only under
 * the same key. It binds the Cloud session, the Google connection and the
 * presence of the read grant, so a revoked read grant, a different account and a
 * new session each start from nothing. Null: nothing may be shown.
 */
export function gmailReadCacheKey(
  sessionId: string | null | undefined,
  account: GmailAccount | null | undefined,
): string | null {
  if (!sessionId || !gmailReadable(account)) return null;
  return JSON.stringify([
    sessionId,
    account.connectionId,
    GMAIL_READ_CAPABILITY,
  ]);
}

/**
 * What a re-read of the account list invalidates. Losing read access, or a
 * different connection or session, drops cached mail. Losing a modify
 * capability drops unsent reviews prepared under it: a review is never
 * dispatched against a grant the user has since withdrawn.
 */
export function gmailGrantChange(
  before: {
    sessionId: string | null;
    account: GmailAccount | null | undefined;
  },
  after: { sessionId: string | null; account: GmailAccount | null | undefined },
): { dropReadCache: boolean; withdrawn: string[] } {
  const previous = gmailReadCacheKey(before.sessionId, before.account),
    next = gmailReadCacheKey(after.sessionId, after.account);
  const dropReadCache = previous === null || previous !== next;
  const had = before.account?.grantedCapabilities ?? [],
    has = after.account && next ? after.account.grantedCapabilities : [];
  const withdrawn = GMAIL_MODIFY_CAPABILITIES.filter(
    (capability) =>
      had.includes(capability) && (dropReadCache || !has.includes(capability)),
  );
  return { dropReadCache, withdrawn };
}

export function gmailGrantLabel(accounts: readonly GmailAccount[]): string {
  const tiers = accounts.map(gmailGrantTier);
  if (tiers.includes("modify")) return "Read and change access authorized";
  if (
    accounts.some(
      (account) =>
        gmailReadable(account) &&
        account.grantedCapabilities.includes("google.gmail.send"),
    )
  )
    return "Read and send access authorized";
  return tiers.includes("readonly")
    ? "Read access authorized"
    : "Authorization required";
}
