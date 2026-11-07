/**
 * Mailbox list state for a phone or browser Inbox: folder queries, provider
 * cursor paging, bounded list and body caches, the owner-bound saved snapshot
 * that lets Inbox (and a Home summary) reopen without a provider read, and the
 * metadata-only attention summary a Home surface may show.
 *
 * Paging never claims completeness it did not see: a later page whose mailbox
 * revision differs from the first page's, or that repeats a listed message,
 * marks the list as cut from a changed mailbox; a repeated provider cursor ends
 * paging instead of looping; a message listed twice is shown once. Saved
 * snapshots are validated row by row and restored only for a readable account
 * the owner last chose.
 *
 * Browser-safe: no Node built-ins, no React and only erasable TypeScript.
 */
import { gmailReadable } from "./grants.ts";
import type { GmailAccount, GmailMessage } from "./types.ts";

export type MailboxFolder =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "trash"
  | "starred"
  | "all"
  | "spam";

/** The Gmail search each folder lists. */
export const MAILBOX_FOLDER_QUERY: Readonly<Record<MailboxFolder, string>> =
  Object.freeze({
    inbox: "in:inbox",
    sent: "in:sent",
    drafts: "in:drafts",
    archive: "in:archive",
    trash: "in:trash",
    starred: "is:starred",
    all: "-in:spam -in:trash",
    spam: "in:spam",
  });

/** Shown when a later page came from a mailbox that changed after the first page. */
export const MAILBOX_CHANGED_NOTICE =
  "Newer mail arrived while this list was loading and is not shown yet. Load newer mail to read the list again.";

/** Plain status for a loaded list. */
export function mailboxListStatus(count: number, query: string): string {
  if (count) return `${count} messages loaded`;
  if (query === MAILBOX_FOLDER_QUERY.inbox) return "Your Inbox is empty";
  if (query === MAILBOX_FOLDER_QUERY.sent) return "No sent messages";
  if (query === MAILBOX_FOLDER_QUERY.archive) return "No archived messages";
  if (query === MAILBOX_FOLDER_QUERY.trash) return "Trash is empty";
  return "No messages match this search";
}

/**
 * The cursor to offer for the next page, recorded in `seen`. A provider cursor
 * that repeats would page forever, so it ends the results instead.
 */
export function nextMailboxCursor(
  seen: Set<string>,
  next: string | null | undefined,
): string | null {
  const cursor = next && !seen.has(next) ? next : null;
  if (cursor) seen.add(cursor);
  return cursor;
}

export type MailboxPageState<M extends { id: string }> = {
  messages: readonly M[];
  /** Mailbox revision reported with the first page, when the server sends one. */
  firstPageRevision: string | null;
  seenCursors: ReadonlySet<string>;
};

export type MailboxPage<M extends { id: string }> = {
  messages: readonly M[];
  nextPageToken?: string | null;
  mailboxHistoryId?: string | null;
};

export type MailboxPageMerge<M extends { id: string }> = {
  messages: M[];
  firstPageRevision: string | null;
  seenCursors: Set<string>;
  nextPageToken: string | null;
  /** This later page was listed from a mailbox that changed after the earlier pages were read. */
  shifted: boolean;
};

/**
 * Merges one search page into the list. `pageToken` is the cursor the page was
 * read with, or null for a first page (which starts a new list).
 */
export function mergeMailboxPage<M extends { id: string }>(
  state: MailboxPageState<M>,
  page: MailboxPage<M>,
  pageToken: string | null,
): MailboxPageMerge<M> {
  const seen = new Set(pageToken ? state.messages.map((m) => m.id) : []);
  // A server without mailbox revisions (older Cloud) leaves only the repeat check;
  // the revision also reveals a removed message, which no repeat can show.
  const revisionChanged =
    !!pageToken &&
    !!state.firstPageRevision &&
    !!page.mailboxHistoryId &&
    page.mailboxHistoryId !== state.firstPageRevision;
  const shifted =
    !!pageToken &&
    (revisionChanged || page.messages.some((m) => seen.has(m.id)));
  const fresh = page.messages.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  const seenCursors = pageToken
    ? new Set(state.seenCursors)
    : new Set<string>();
  return {
    messages: pageToken ? [...state.messages, ...fresh] : fresh,
    firstPageRevision: pageToken
      ? state.firstPageRevision
      : (page.mailboxHistoryId ?? null),
    seenCursors,
    nextPageToken: nextMailboxCursor(seenCursors, page.nextPageToken),
    shifted,
  };
}

/** A loaded folder list kept for a quick reopen. `key` is the host's read identity for the list. */
export type MailboxListSnapshot<M = GmailMessage> = {
  key: string;
  at: number;
  firstPageRevision: string | null;
  messages: M[];
  query: string;
  cursor: string | null;
  revision: string;
  cursors: string[];
  newerMail: boolean;
  status: string;
};

export const MAILBOX_LIST_LIMITS = Object.freeze({
  lists: 8,
  messages: 100,
  maxAgeMs: 30 * 86_400_000,
});

const fresh = (at: number, now: number, maxAgeMs: number) =>
  Number.isFinite(at) && at <= now && now - at < maxAgeMs;

/** Recently loaded folder lists, oldest first. Memory only; the host persists the rows it chooses. */
export class MailboxListCache<M = GmailMessage> {
  private readonly rows = new Map<string, MailboxListSnapshot<M>>();

  /** Keeps a loaded list. Drafts and lists over the message limit are not kept. */
  remember(row: MailboxListSnapshot<M>): boolean {
    if (
      !row.query ||
      row.query === MAILBOX_FOLDER_QUERY.drafts ||
      row.messages.length > MAILBOX_LIST_LIMITS.messages
    )
      return false;
    this.put({
      ...row,
      messages: [...row.messages],
      cursors: [...row.cursors],
    });
    return true;
  }

  /** Restores a validated saved row under its current key. */
  put(row: MailboxListSnapshot<M>): void {
    this.rows.delete(row.key);
    this.rows.set(row.key, row);
    while (this.rows.size > MAILBOX_LIST_LIMITS.lists)
      this.rows.delete(this.rows.keys().next().value as string);
  }

  /** A kept list within the age limit. An expired list is dropped. */
  get(key: string, now = Date.now()): MailboxListSnapshot<M> | undefined {
    const row = this.rows.get(key);
    if (!row) return undefined;
    if (!fresh(row.at, now, MAILBOX_LIST_LIMITS.maxAgeMs)) {
      this.rows.delete(key);
      return undefined;
    }
    return row;
  }

  delete(key: string): void {
    this.rows.delete(key);
  }

  clear(): void {
    this.rows.clear();
  }

  get size(): number {
    return this.rows.size;
  }

  values(): MailboxListSnapshot<M>[] {
    return [...this.rows.values()];
  }
}

export type MailBodyEntry<B> = { at: number; body: B };

export const MAIL_BODY_LIMITS = Object.freeze({
  bodies: 16,
  bytes: 4 * 1024 * 1024,
});

const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** Recently read message bodies, at most 16 and 4 MiB of JSON. Memory only. */
export class MailBodyCache<B> {
  private readonly rows = new Map<string, MailBodyEntry<B>>();

  remember(key: string, body: B, now = Date.now()): void {
    this.rows.delete(key);
    this.rows.set(key, { at: now, body });
    let bytes = 0;
    for (const row of this.rows.values()) bytes += jsonBytes(row.body);
    while (
      this.rows.size > MAIL_BODY_LIMITS.bodies ||
      bytes > MAIL_BODY_LIMITS.bytes
    ) {
      const first = this.rows.keys().next().value as string;
      bytes -= jsonBytes(this.rows.get(first)?.body);
      this.rows.delete(first);
    }
  }

  /** Restores a validated saved entry with its original read time. */
  put(key: string, entry: MailBodyEntry<B>): void {
    this.rows.delete(key);
    this.rows.set(key, entry);
  }

  get(key: string): MailBodyEntry<B> | undefined {
    return this.rows.get(key);
  }

  delete(key: string): void {
    this.rows.delete(key);
  }

  clear(): void {
    this.rows.clear();
  }

  values(): MailBodyEntry<B>[] {
    return [...this.rows.values()];
  }
}

/** The owner-bound mailbox snapshot a host saves after a successful read. */
export type SavedMailbox<B = unknown, M = GmailMessage> = {
  accounts: GmailAccount[];
  selected: string;
  spamTrashSearch: boolean;
  lists: MailboxListSnapshot<M>[];
  bodies: MailBodyEntry<B>[];
};

/** Home's metadata of one message: never a snippet, recipient or body. */
export type InboxSummaryMessage = Pick<
  GmailMessage,
  "id" | "subject" | "from" | "unread"
>;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const savedAccount = (value: unknown): GmailAccount | null => {
  const account = record(value);
  return account &&
    typeof account.label === "string" &&
    Array.isArray(account.grantedCapabilities)
    ? (account as unknown as GmailAccount)
    : null;
};

/**
 * The newest saved Inbox page of the account the owner last chose, reduced to
 * the metadata a Home summary may show. Null when nothing valid was saved.
 */
export function readSavedInboxSummary(
  value: unknown,
  hint: string | null | undefined,
  now = Date.now(),
): {
  account: GmailAccount;
  messages: InboxSummaryMessage[];
  more: boolean;
  readAt: number;
} | null {
  const saved = record(value);
  if (
    !saved ||
    !Array.isArray(saved.accounts) ||
    !Array.isArray(saved.lists) ||
    (hint && hint !== saved.selected)
  )
    return null;
  const account = saved.accounts
    .map(savedAccount)
    .find(
      (row): row is GmailAccount =>
        !!row && row.connectionId === saved.selected && gmailReadable(row),
    );
  if (!account) return null;
  const row = saved.lists
    .map(record)
    .filter(
      (list): list is Record<string, unknown> =>
        !!list &&
        list.query === MAILBOX_FOLDER_QUERY.inbox &&
        typeof list.at === "number" &&
        fresh(list.at, now, MAILBOX_LIST_LIMITS.maxAgeMs),
    )
    .sort((a, b) => (b.at as number) - (a.at as number))[0];
  if (
    !row ||
    !Array.isArray(row.messages) ||
    row.messages.length > MAILBOX_LIST_LIMITS.messages ||
    (row.cursor !== null && typeof row.cursor !== "string") ||
    row.messages.some((raw) => {
      const m = record(raw);
      return (
        !m ||
        typeof m.id !== "string" ||
        typeof m.subject !== "string" ||
        typeof m.from !== "string" ||
        typeof m.unread !== "boolean"
      );
    })
  )
    return null;
  return {
    account,
    messages: (row.messages as InboxSummaryMessage[]).map(
      ({ id, subject, from, unread }) => ({ id, subject, from, unread }),
    ),
    more: row.cursor !== null,
    readAt: row.at as number,
  };
}

/**
 * A saved mailbox restorable for the account the owner last chose. Invalid list
 * and body rows are dropped; the host re-keys the rest under its current read
 * identity. Null when the snapshot or its chosen account is not usable.
 */
export function readSavedMailbox<B extends { message: { id: string } }>(
  value: unknown,
  hint: string | null | undefined,
): {
  accounts: GmailAccount[];
  selected: string;
  chosen: GmailAccount;
  spamTrashSearch: boolean;
  lists: MailboxListSnapshot<GmailMessage>[];
  bodies: MailBodyEntry<B>[];
} | null {
  const saved = record(value);
  if (
    !saved ||
    !Array.isArray(saved.accounts) ||
    !saved.accounts.every((row) => savedAccount(row)) ||
    !Array.isArray(saved.lists) ||
    !Array.isArray(saved.bodies) ||
    typeof saved.selected !== "string" ||
    (hint && hint !== saved.selected)
  )
    return null;
  const accounts = saved.accounts as GmailAccount[];
  const chosen = accounts.find(
    (account) =>
      account.connectionId === saved.selected && gmailReadable(account),
  );
  if (!chosen) return null;
  const lists = saved.lists.filter((raw): boolean => {
    const row = record(raw);
    return (
      !!row &&
      typeof row.query === "string" &&
      typeof row.at === "number" &&
      Array.isArray(row.messages) &&
      row.messages.every((item) => {
        const m = record(item);
        return (
          !!m &&
          typeof m.id === "string" &&
          typeof m.from === "string" &&
          typeof m.snippet === "string" &&
          Array.isArray(m.to)
        );
      })
    );
  }) as MailboxListSnapshot<GmailMessage>[];
  const bodies = saved.bodies.filter((raw): boolean => {
    const row = record(raw),
      body = record(row?.body),
      message = record(body?.message);
    return (
      !!row &&
      typeof row.at === "number" &&
      typeof message?.id === "string" &&
      !!message.id &&
      typeof body?.bodyText === "string"
    );
  }) as MailBodyEntry<B>[];
  return {
    accounts,
    selected: saved.selected,
    chosen,
    spamTrashSearch: saved.spamTrashSearch === true,
    lists,
    bodies,
  };
}

/**
 * What a Home surface may show about mail. Only counts, the account label and
 * a time leave the Inbox: no subject, sender or body. `unreadMore` means the
 * bounded query or loaded pages did not see every message; `unread` stays
 * undefined until a page was read, so a stale or loading state never claims a
 * count it did not see.
 */
export interface InboxAttention {
  state: "not-connected" | "loading" | "ready" | "error" | "stale";
  unread: number | undefined;
  unreadMore: boolean;
  source: string | null;
  updatedAt: string | null;
}

/** Attention for loaded Inbox messages; `updatedAt` is never newer than the oldest data counted. */
export function inboxAttentionFor(
  messages: ReadonlyArray<Pick<GmailMessage, "unread">>,
  more: boolean,
  source: string | null,
  updatedAt: string,
  state: "ready" | "stale" = "ready",
): InboxAttention {
  return {
    state,
    unread: messages.filter((m) => m.unread).length,
    unreadMore: more,
    source,
    updatedAt,
  };
}
