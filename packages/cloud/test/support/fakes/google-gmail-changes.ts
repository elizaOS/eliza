// spec/cloud/services/google/mailOperations.md, "Story: Change or send from my mailbox once, as I reviewed it"
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";

export interface MailboxMessage {
  readonly id: string;
  threadId: string;
  labelIds: string[];
  historyId: string;
  raw?: string;
}

export interface MailboxDraft {
  readonly id: string;
  messageId: string;
  raw: string;
  threadId?: string;
}

export interface GmailMailbox {
  readonly messages: Map<string, MailboxMessage>;
  readonly drafts: Map<string, MailboxDraft>;
  history: number;
}

export interface GmailChangeSwitches {
  dropNextReply: boolean;
  readonly calls: Array<{ readonly method: string; readonly path: string }>;
}

const base = "/gmail/v1/users/me";

export function gmailMailbox(messages: ReadonlyArray<Pick<MailboxMessage, "id" | "threadId" | "labelIds"> & { readonly raw?: string }> = []): GmailMailbox {
  const mailbox: GmailMailbox = { messages: new Map(), drafts: new Map(), history: 1000 };
  for (const message of messages) mailbox.messages.set(message.id, { ...message, labelIds: [...message.labelIds], historyId: String(++mailbox.history) });
  return mailbox;
}

export function gmailChangeSwitches(): GmailChangeSwitches {
  return { dropNextReply: false, calls: [] };
}

export function sentTexts(mailbox: GmailMailbox): string[] {
  return [...mailbox.messages.values()].filter((message) => message.labelIds.includes("SENT")).map((message) => Buffer.from(message.raw ?? "", "base64url").toString("utf8"));
}

function touch(mailbox: GmailMailbox, message: MailboxMessage): MailboxMessage {
  message.historyId = String(++mailbox.history);
  return message;
}

function relabel(mailbox: GmailMailbox, message: MailboxMessage, add: ReadonlyArray<string>, remove: ReadonlyArray<string>): MailboxMessage {
  message.labelIds = [...new Set([...message.labelIds.filter((label) => !remove.includes(label)), ...add])];
  return touch(mailbox, message);
}

function shown(message: MailboxMessage) {
  return { id: message.id, threadId: message.threadId, labelIds: [...message.labelIds], historyId: message.historyId };
}

function rfc822Of(raw: string): string | undefined {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  return /^Message-ID:\s*<([^>\r\n]+)>/im.exec(text)?.[1];
}

function draftShown(mailbox: GmailMailbox, draft: MailboxDraft, format: string | null) {
  const message = mailbox.messages.get(draft.messageId);
  return { id: draft.id, message: { id: draft.messageId, threadId: draft.threadId ?? draft.messageId, labelIds: message?.labelIds ?? ["DRAFT"], ...(format === "raw" ? { raw: draft.raw } : {}) } };
}

function saveDraft(mailbox: GmailMailbox, id: string, body: { message?: { raw?: string; threadId?: string } }): MailboxDraft | undefined {
  const raw = body.message?.raw;
  if (typeof raw !== "string") return undefined;
  const messageId = `msg-draft-${++mailbox.history}`;
  const previous = mailbox.drafts.get(id);
  if (previous !== undefined) mailbox.messages.delete(previous.messageId);
  const draft: MailboxDraft = { id, messageId, raw, ...(body.message?.threadId === undefined ? {} : { threadId: body.message.threadId }) };
  mailbox.drafts.set(id, draft);
  mailbox.messages.set(messageId, { id: messageId, threadId: draft.threadId ?? messageId, labelIds: ["DRAFT"], historyId: String(mailbox.history), raw });
  return draft;
}

function parsed(request: FakeRequest): Record<string, unknown> {
  return request.body === "" ? {} : (JSON.parse(request.body) as Record<string, unknown>);
}

function change(mailbox: GmailMailbox, request: FakeRequest, rest: string): FakeAnswer | undefined {
  const notFound: FakeAnswer = { status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } };
  const labelPath = /^\/messages\/([A-Za-z0-9_-]+)\/(modify|trash|untrash)$/.exec(rest);
  if (request.method === "POST" && labelPath !== null) {
    const message = mailbox.messages.get(labelPath[1] ?? "");
    if (message === undefined) return notFound;
    const body = parsed(request) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    const changed = labelPath[2] === "trash" ? relabel(mailbox, message, ["TRASH"], ["INBOX"])
      : labelPath[2] === "untrash" ? relabel(mailbox, message, ["INBOX"], ["TRASH"])
      : relabel(mailbox, message, body.addLabelIds ?? [], body.removeLabelIds ?? []);
    return { status: 200, body: shown(changed) };
  }
  if (request.method === "POST" && rest === "/messages/send") {
    const body = parsed(request) as { raw?: string; threadId?: string };
    if (typeof body.raw !== "string") return { status: 400, body: { error: { code: 400 } } };
    const id = `msg-sent-${++mailbox.history}`;
    const sent: MailboxMessage = { id, threadId: body.threadId ?? id, labelIds: ["SENT"], historyId: String(mailbox.history), raw: body.raw };
    mailbox.messages.set(id, sent);
    return { status: 200, body: { id, threadId: sent.threadId, labelIds: ["SENT"] } };
  }
  if (request.method === "POST" && rest === "/drafts") {
    const draft = saveDraft(mailbox, `r-${++mailbox.history}`, parsed(request));
    return draft === undefined ? { status: 400, body: { error: { code: 400 } } } : { status: 200, body: draftShown(mailbox, draft, null) };
  }
  const draftPath = /^\/drafts\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (draftPath !== null && (request.method === "PUT" || request.method === "DELETE")) {
    const id = draftPath[1] ?? "";
    const current = mailbox.drafts.get(id);
    if (current === undefined) return notFound;
    if (request.method === "DELETE") {
      mailbox.drafts.delete(id);
      mailbox.messages.delete(current.messageId);
      return { status: 204 };
    }
    const draft = saveDraft(mailbox, id, parsed(request));
    return draft === undefined ? { status: 400, body: { error: { code: 400 } } } : { status: 200, body: draftShown(mailbox, draft, null) };
  }
  return undefined;
}

function read(mailbox: GmailMailbox, request: FakeRequest, rest: string): FakeAnswer | undefined {
  if (request.method !== "GET") return undefined;
  const query = request.query.get("q") ?? "";
  if (rest === "/messages" && query.startsWith("rfc822msgid:")) {
    const wanted = query.slice("rfc822msgid:".length).replace(/^<|>$/g, "");
    const messages = [...mailbox.messages.values()].filter((message) => message.raw !== undefined && rfc822Of(message.raw) === wanted).map((message) => ({ id: message.id, threadId: message.threadId }));
    return { status: 200, body: { messages, resultSizeEstimate: messages.length } };
  }
  const messagePath = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (messagePath !== null && request.query.get("format") === "minimal") {
    const message = mailbox.messages.get(messagePath[1] ?? "");
    return message === undefined ? { status: 404, body: { error: { code: 404 } } } : { status: 200, body: shown(message) };
  }
  return undefined;
}

export function gmailChanges(mailbox: GmailMailbox, switches: GmailChangeSwitches): FakeHandler {
  return (request) => {
    if (!request.path.startsWith(`${base}/`)) return undefined;
    if (!/^Bearer \S+$/.test(String(request.headers.authorization ?? ""))) return { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } };
    const rest = request.path.slice(base.length);
    const changed = change(mailbox, request, rest);
    if (changed !== undefined) {
      switches.calls.push({ method: request.method, path: rest });
      if (!switches.dropNextReply) return changed;
      switches.dropNextReply = false;
      return { status: 504, body: { error: { code: 504, status: "DEADLINE_EXCEEDED" } } };
    }
    return read(mailbox, request, rest);
  };
}
