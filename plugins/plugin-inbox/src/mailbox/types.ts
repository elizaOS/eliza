/**
 * Wire contract of the Eliza Cloud managed Gmail mailbox (`/api/v1/eliza/google/*`
 * and its `gmail/inbox-v1` namespace) as seen by a phone or browser client.
 *
 * Browser-safe: no Node built-ins, no React and no runtime imports. Every value
 * here is validated by `ManagedGmailMailboxClient` before a caller sees it.
 */

/** One owner-side Google connection as Cloud reports it. */
export interface GoogleConnection {
  configured: boolean;
  connected: boolean;
  reason: string;
  connectionId: string | null;
  grantedCapabilities: string[];
}

/** A Google connection with the label shown for its mailbox. */
export interface GmailAccount extends GoogleConnection {
  label: string;
}

/** Per-account managed inbox capabilities (`inbox-v1/capabilities`). */
export interface GmailInboxCapabilities {
  version: 1;
  from: string;
  threads: boolean;
  send: boolean;
  providerDrafts: boolean;
  mailboxMutations: boolean;
  attachments: boolean;
  providerExactlyOnce: false;
  atomicDraftReplacement: false;
  /** Reviewed mark-read/mark-unread operations. Older servers omit it: false. */
  readState: boolean;
  /** Provider draft listing and content reads. Absent: false. */
  draftsList: boolean;
  /** Forward with the source message's attachments bound to its historyId. Absent: false. */
  forwardAttachments: boolean;
  /** Gmail search can list Trash. Absent: false. */
  searchTrash: boolean;
  /** Opaque byte-copy download of any attachment type under the cap. Absent: false. */
  opaqueAttachments: boolean;
  /** Outgoing attachment policy. Older servers publish maximumOutgoing 1 or omit the policy. */
  attachmentPolicy: {
    maximumOutgoing: number;
    maximumBytes: number;
    maximumTotalBytes: number;
  };
}

/** A provider-extracted link: inert data, never fetched or rendered as HTML. */
export interface GmailLink {
  href: string;
  text: string;
}

export interface GmailDraftSummary {
  draftId: string;
  messageId: string;
  subject: string;
  to: string[];
  snippet: string;
  updatedAt: string | null;
}

export interface GmailDraftContent {
  draftId: string;
  messageId: string;
  providerDigest: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  threaded: boolean;
  attachmentCount: number;
  /** False for an HTML-only draft, whose formatting a plain-text edit would discard. */
  plainText: boolean;
}

/** Every reviewed mailbox effect the inbox-v1 operation routes accept. */
export type GmailInboxOperationKind =
  | "send"
  | "draft-create"
  | "draft-replace"
  | "draft-delete"
  | "archive"
  | "unarchive"
  | "trash"
  | "untrash"
  | "mark-read"
  | "mark-unread";

export type GmailInboxReceiptState =
  | "prepared"
  | "dispatched"
  | "succeeded"
  | "rejected"
  | "outcome-unknown";

/** Canonical Cloud receipt for one reviewed operation. `succeeded` always carries a provider result. */
export interface GmailInboxReceipt {
  requestId: string;
  kind: GmailInboxOperationKind;
  reviewDigest: string;
  state: GmailInboxReceiptState;
  providerResult: Record<string, unknown> | null;
  rejectionCode: string | null;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  to: string[];
  cc?: string[];
  replyTo?: string | null;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  /** Search hint from a multipart/mixed container; absent on older servers. */
  hasAttachments?: boolean;
}

/** Attachment metadata of a read message. Bytes are fetched separately and reviewed. */
export interface GmailMessageAttachment {
  partId: string;
  name: string;
  mimeType: string;
  size: number;
  supported: boolean;
}

/** One message body read. `historyId` binds later attachment reads and reviewed changes. */
export interface GmailReadResult {
  message: GmailMessage;
  bodyText: string;
  bodyHtml?: string;
  /** The provider sent an HTML body too large to display; `bodyText` is shown instead. */
  bodyHtmlOmitted?: true;
  links: GmailLink[];
  /** Distinct safe links beyond the displayed `links` limit. */
  omittedLinks?: number;
  historyId: string | null;
  attachments: GmailMessageAttachment[];
}

/** One search page. Two pages of one search with different `mailboxHistoryId` came from a changed mailbox. */
export interface GmailSearchPage {
  messages: GmailMessage[];
  syncedAt: string;
  nextPageToken: string | null;
  mailboxHistoryId?: string;
  supportsSpamTrash: boolean;
}

export interface GmailThreadMessage {
  message: GmailMessage;
  bodyText: string;
  bodyHtml?: string;
  /** The provider sent an HTML body too large to display; `bodyText` is shown instead. */
  bodyHtmlOmitted?: true;
  links: GmailLink[];
  /** Distinct safe links beyond the displayed `links` limit. */
  omittedLinks?: number;
  historyId: string | null;
  attachments: GmailMessageAttachment[];
}

/** One bounded thread page, pinned to the thread revision of its first page. */
export interface GmailThreadPage {
  messages: GmailThreadMessage[];
  total: number;
  offset: number;
  historyId: string;
  nextOffset: number | null;
}

/** An approved mailbox change and the Cloud capability family it needs. */
export type GmailMailboxAction = GmailInboxOperationKind;
