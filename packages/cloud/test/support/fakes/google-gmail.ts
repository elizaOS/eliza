// spec/cloud/services/google/mailRead.md, "Story: Read my mail through the grant I chose"
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";
import type { GmailMailbox, MailboxMessage } from "./google-gmail-changes.ts";

export interface FakeAttachment {
  readonly partId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ReadableMessage extends MailboxMessage {
  internalDate?: number;
  headers?: Readonly<Record<string, string>>;
  received?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: ReadonlyArray<FakeAttachment>;
  mimePayload?: ReturnType<typeof mimeBoundaryPayload>;
}

export interface ReadableMailbox extends GmailMailbox {
  readonly messages: Map<string, ReadableMessage>;
}

const base = "/gmail/v1/users/me";
const notFound: FakeAnswer = { status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } };

export function readableMailbox(messages: ReadonlyArray<Omit<ReadableMessage, "historyId">>): ReadableMailbox {
  const mailbox: ReadableMailbox = { messages: new Map(), drafts: new Map(), history: 1000 };
  for (const message of messages) mailbox.messages.set(message.id, { ...message, labelIds: [...message.labelIds], historyId: String(++mailbox.history) });
  return mailbox;
}

export function touchMessage(mailbox: ReadableMailbox, id: string): void {
  const message = mailbox.messages.get(id);
  if (message !== undefined) message.historyId = String(++mailbox.history);
}

const data = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

export function mimeBoundaryPayload(count: number, body: "plain" | "html" | "malformed") {
  const text = (mimeType: string, value: string) => ({
    mimeType, body: { data: data(value), size: Buffer.byteLength(value) }
  });
  const file = (partId: string, filename: string) => ({ ...text("text/plain", filename), partId, filename });
  const fillers = Array.from({ length: count - (body === "plain" ? 6 : 5) }, () => ({ mimeType: "application/octet-stream" }));
  const html = text("text/html", "<p>HTML after the attachments</p>");
  return { mimeType: "multipart/mixed", parts: [
    file("1", "first.txt"),
    ...fillers,
    { mimeType: "multipart/mixed", parts: [
      file("2", "last.txt"),
      ...(body === "plain" ? [text("text/plain", "Complete plain text")] : []),
      body === "malformed" ? false : html
    ] }
  ] };
}

function rawParts(raw: string): { readonly headers: Record<string, string>; readonly body: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.search(/\r?\n\r?\n/);
  const head = split < 0 ? text : text.slice(0, split);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { headers, body: split < 0 ? "" : text.slice(split).replace(/^\r?\n\r?\n/, "") };
}

function headerList(received: ReadonlyArray<{ readonly name: string; readonly value: string }>, headers: Readonly<Record<string, string>>, only: ReadonlyArray<string> | undefined) {
  return [...received, ...Object.entries(headers).map(([name, value]) => ({ name, value }))]
    .filter(({ name }) => only === undefined || only.some((wanted) => wanted.toLowerCase() === name.toLowerCase()));
}

function payload(message: ReadableMessage, format: string, only: ReadonlyArray<string> | undefined) {
  const parsed = message.raw === undefined ? undefined : rawParts(message.raw);
  const headers = headerList(message.received ?? [], message.headers ?? parsed?.headers ?? {}, format === "metadata" ? only : undefined);
  if (format === "metadata") return { mimeType: (message.attachments ?? []).length > 0 ? "multipart/mixed" : "multipart/alternative", headers };
  if (message.mimePayload !== undefined) return { ...message.mimePayload, headers };
  const text = message.bodyText ?? parsed?.body;
  const bodies = [
    ...(text === undefined ? [] : [{ partId: "0.0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }], body: { size: Buffer.byteLength(text), data: data(text) } }]),
    ...(message.bodyHtml === undefined ? [] : [{ partId: "0.1", mimeType: "text/html", filename: "", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { size: Buffer.byteLength(message.bodyHtml), data: data(message.bodyHtml) } }])
  ];
  const files = (message.attachments ?? []).map((file) => ({
    partId: file.partId, mimeType: file.mimeType, filename: file.filename, headers: [], body: { size: file.bytes.length, attachmentId: `att-${message.id}-${file.partId.replace(".", "-")}` }
  }));
  return { mimeType: "multipart/mixed", headers, body: { size: 0 }, parts: [{ partId: "0", mimeType: "multipart/alternative", filename: "", body: { size: 0 }, parts: bodies }, ...files] };
}

function shown(message: ReadableMessage, format: string, only?: ReadonlyArray<string>) {
  return {
    id: message.id, threadId: message.threadId, labelIds: [...message.labelIds], historyId: message.historyId,
    snippet: message.snippet ?? "", internalDate: String(message.internalDate ?? 0),
    ...(format === "minimal" ? {} : { payload: payload(message, format, only) })
  };
}

function matches(message: ReadableMessage, query: URLSearchParams): boolean {
  const labels = query.getAll("labelIds");
  if (!labels.every((label) => message.labelIds.includes(label))) return false;
  if (message.labelIds.includes("TRASH") && query.get("includeSpamTrash") !== "true") return false;
  const terms = (query.get("q") ?? "").split(/\s+/).filter(Boolean);
  const text = `${Object.values(message.headers ?? {}).join(" ")} ${message.snippet ?? ""} ${message.bodyText ?? ""}`.toLowerCase();
  return terms.every((term) => term === "-in:trash" ? !message.labelIds.includes("TRASH") : term.startsWith("in:") || text.includes(term.toLowerCase()));
}

function page<T>(rows: ReadonlyArray<T>, query: URLSearchParams): { readonly rows: ReadonlyArray<T>; readonly nextPageToken?: string } {
  const size = Number(query.get("maxResults") ?? "100");
  const start = Number(query.get("pageToken") ?? "0");
  const end = start + size;
  return { rows: rows.slice(start, end), ...(end < rows.length ? { nextPageToken: String(end) } : {}) };
}

function draftShown(mailbox: ReadableMailbox, id: string, format: string) {
  const draft = mailbox.drafts.get(id);
  if (draft === undefined) return undefined;
  const parsed = rawParts(draft.raw);
  const message: ReadableMessage = { id: draft.messageId, threadId: draft.threadId ?? draft.messageId, labelIds: ["DRAFT"], historyId: String(mailbox.history), raw: draft.raw, headers: parsed.headers, bodyText: parsed.body };
  return { id, message: format === "raw" ? { id: draft.messageId, threadId: message.threadId, raw: draft.raw } : shown(message, format, ["Subject", "To"]) };
}

function answer(mailbox: ReadableMailbox, request: FakeRequest, rest: string): FakeAnswer | undefined {
  const query = request.query;
  const format = query.get("format") ?? "full";
  if (rest === "/profile") return { status: 200, body: { emailAddress: "owner@example.com", historyId: String(mailbox.history) } };
  if (rest === "/messages" && !(query.get("q") ?? "").startsWith("rfc822msgid:")) {
    const rows = [...mailbox.messages.values()].filter((message) => !message.labelIds.includes("DRAFT") && matches(message, query))
      .toSorted((left, right) => (right.internalDate ?? 0) - (left.internalDate ?? 0));
    const listed = page(rows, query);
    return { status: 200, body: { messages: listed.rows.map((message) => ({ id: message.id, threadId: message.threadId })), resultSizeEstimate: rows.length, ...(listed.nextPageToken === undefined ? {} : { nextPageToken: listed.nextPageToken }) } };
  }
  const attachment = /^\/messages\/([A-Za-z0-9_-]+)\/attachments\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (attachment !== null) {
    const message = mailbox.messages.get(attachment[1] ?? "");
    const file = message?.attachments?.find((candidate) => `att-${message.id}-${candidate.partId.replace(".", "-")}` === attachment[2]);
    return file === undefined ? notFound : { status: 200, body: { size: file.bytes.length, data: data(file.bytes) } };
  }
  const messagePath = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (messagePath !== null && format !== "minimal") {
    const message = mailbox.messages.get(messagePath[1] ?? "");
    return message === undefined ? notFound : { status: 200, body: shown(message, format, query.getAll("metadataHeaders")) };
  }
  const threadPath = /^\/threads\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (threadPath !== null) {
    const messages = [...mailbox.messages.values()].filter((message) => message.threadId === threadPath[1]);
    if (messages.length === 0) return notFound;
    const historyId = String(Math.max(...messages.map((message) => Number(message.historyId))));
    return { status: 200, body: { id: threadPath[1], historyId, messages: messages.map((message) => shown(message, format)) } };
  }
  if (rest === "/drafts") {
    const listed = page([...mailbox.drafts.keys()], query);
    return { status: 200, body: { drafts: listed.rows.map((id) => ({ id })), ...(listed.nextPageToken === undefined ? {} : { nextPageToken: listed.nextPageToken }) } };
  }
  const draftPath = /^\/drafts\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (draftPath !== null) {
    const draft = draftShown(mailbox, draftPath[1] ?? "", format);
    return draft === undefined ? notFound : { status: 200, body: draft };
  }
  return undefined;
}

export function gmailReads(mailbox: ReadableMailbox): FakeHandler {
  return (request) => {
    if (request.method !== "GET" || !request.path.startsWith(`${base}/`)) return undefined;
    if (!/^Bearer \S+$/.test(String(request.headers.authorization ?? ""))) return { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } };
    return answer(mailbox, request, request.path.slice(base.length));
  };
}
