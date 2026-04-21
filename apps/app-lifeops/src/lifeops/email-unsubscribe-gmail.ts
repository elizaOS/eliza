import { googleApiFetch } from "./google-fetch.js";

const GOOGLE_GMAIL_MESSAGES_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GOOGLE_GMAIL_FILTERS_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters";

const SUBSCRIPTION_METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Date",
  "List-Id",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "Precedence",
  "Auto-Submitted",
] as const;

const SUBSCRIPTION_SCAN_QUERY_DEFAULT =
  "(category:promotions OR category:updates OR list:* OR unsubscribe) newer_than:180d";

interface GoogleGmailListResponse {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMetadataResponse {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
  };
}

export interface GmailSubscriptionMessageHeaders {
  messageId: string;
  threadId: string;
  receivedAt: string;
  subject: string;
  fromDisplay: string;
  fromEmail: string | null;
  listId: string | null;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  snippet: string;
  labels: string[];
}

function readHeader(
  headers: GmailHeader[] | undefined,
  name: string,
): string | null {
  const lowerName = name.toLowerCase();
  const header = headers?.find(
    (candidate) => candidate.name?.trim().toLowerCase() === lowerName,
  );
  const value = header?.value?.trim();
  return value && value.length > 0 ? value : null;
}

function parseFromAddress(value: string | null): {
  display: string;
  email: string | null;
} {
  if (!value) {
    return { display: "Unknown sender", email: null };
  }
  const match = value.match(/^(.*?)<([^>]+)>$/);
  if (match) {
    const display = (match[1] ?? "").trim().replace(/^"|"$/g, "");
    const email = (match[2] ?? "").trim().toLowerCase();
    return {
      display: display || email,
      email: email.length > 0 ? email : null,
    };
  }
  const trimmed = value.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return { display: trimmed, email: trimmed.toLowerCase() };
  }
  return { display: trimmed || "Unknown sender", email: null };
}

function internalDateToIso(value: string | undefined): string {
  const ms = value ? Number(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function parseListUnsubscribe(value: string | null): {
  httpUrl: string | null;
  mailto: string | null;
} {
  if (!value) {
    return { httpUrl: null, mailto: null };
  }
  const entries: string[] = [];
  const regex = /<([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    entries.push(match[1].trim());
  }
  let httpUrl: string | null = null;
  let mailto: string | null = null;
  for (const entry of entries) {
    if (!httpUrl && /^https?:\/\//i.test(entry)) {
      httpUrl = entry;
    } else if (!mailto && /^mailto:/i.test(entry)) {
      mailto = entry;
    }
  }
  return { httpUrl, mailto };
}

export function extractListUnsubscribeOptions(
  header: GmailSubscriptionMessageHeaders,
): {
  httpUrl: string | null;
  mailto: string | null;
  oneClickPost: boolean;
} {
  const { httpUrl, mailto } = parseListUnsubscribe(header.listUnsubscribe);
  const oneClickPost = /one-click/i.test(header.listUnsubscribePost ?? "");
  return { httpUrl, mailto, oneClickPost };
}

async function gmailListIds(args: {
  accessToken: string;
  query: string;
  maxResults: number;
  pageToken?: string;
}): Promise<{ ids: string[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    maxResults: String(Math.min(Math.max(1, args.maxResults), 500)),
    includeSpamTrash: "false",
    q: args.query,
  });
  if (args.pageToken) {
    params.set("pageToken", args.pageToken);
  }
  const response = await googleApiFetch(
    `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  );
  const parsed = (await response.json()) as GoogleGmailListResponse;
  const ids = (parsed.messages ?? [])
    .map((entry) => entry.id?.trim() ?? "")
    .filter((id) => id.length > 0);
  return {
    ids,
    nextPageToken:
      typeof parsed.nextPageToken === "string" && parsed.nextPageToken.length > 0
        ? parsed.nextPageToken
        : null,
  };
}

async function gmailFetchHeaders(args: {
  accessToken: string;
  messageId: string;
}): Promise<GmailSubscriptionMessageHeaders | null> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of SUBSCRIPTION_METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }
  const response = await googleApiFetch(
    `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(args.messageId)}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  );
  const parsed = (await response.json()) as GmailMetadataResponse;
  const messageId = parsed.id?.trim();
  const threadId = parsed.threadId?.trim();
  if (!messageId || !threadId) {
    return null;
  }
  const headers = parsed.payload?.headers ?? [];
  const subject = readHeader(headers, "Subject") ?? "(no subject)";
  const from = parseFromAddress(readHeader(headers, "From"));
  const listId = readHeader(headers, "List-Id");
  const listUnsubscribe = readHeader(headers, "List-Unsubscribe");
  const listUnsubscribePost = readHeader(headers, "List-Unsubscribe-Post");
  return {
    messageId,
    threadId,
    receivedAt: internalDateToIso(parsed.internalDate),
    subject,
    fromDisplay: from.display,
    fromEmail: from.email,
    listId,
    listUnsubscribe,
    listUnsubscribePost,
    snippet: parsed.snippet?.trim() ?? "",
    labels: (parsed.labelIds ?? []).map((label) => label.trim()).filter(Boolean),
  };
}

export async function fetchGmailSubscriptionHeaders(args: {
  accessToken: string;
  query?: string;
  maxMessages?: number;
}): Promise<GmailSubscriptionMessageHeaders[]> {
  const query = args.query?.trim().length
    ? args.query.trim()
    : SUBSCRIPTION_SCAN_QUERY_DEFAULT;
  const maxMessages = Math.min(Math.max(1, args.maxMessages ?? 200), 1000);

  const results: GmailSubscriptionMessageHeaders[] = [];
  let pageToken: string | null = null;
  while (results.length < maxMessages) {
    const pageSize = Math.min(100, maxMessages - results.length);
    const page = await gmailListIds({
      accessToken: args.accessToken,
      query,
      maxResults: pageSize,
      pageToken: pageToken ?? undefined,
    });
    if (page.ids.length === 0) {
      break;
    }
    const batch = await Promise.all(
      page.ids.map((id) =>
        gmailFetchHeaders({ accessToken: args.accessToken, messageId: id }),
      ),
    );
    for (const headers of batch) {
      if (headers) {
        results.push(headers);
      }
    }
    if (!page.nextPageToken) {
      break;
    }
    pageToken = page.nextPageToken;
  }
  return results;
}

export interface GmailUnsubscribeHttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  method: "POST" | "GET";
  finalUrl: string;
}

export async function performGmailHttpUnsubscribe(args: {
  url: string;
  preferOneClickPost: boolean;
}): Promise<GmailUnsubscribeHttpResult> {
  if (args.preferOneClickPost) {
    const postResponse = await fetch(args.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "follow",
    });
    return {
      ok: postResponse.ok,
      status: postResponse.status,
      statusText: postResponse.statusText,
      method: "POST",
      finalUrl: postResponse.url || args.url,
    };
  }
  const getResponse = await fetch(args.url, {
    method: "GET",
    redirect: "follow",
  });
  return {
    ok: getResponse.ok,
    status: getResponse.status,
    statusText: getResponse.statusText,
    method: "GET",
    finalUrl: getResponse.url || args.url,
  };
}

export interface ParsedMailto {
  recipient: string;
  subject: string | null;
  body: string | null;
}

export function parseMailtoUnsubscribe(value: string): ParsedMailto | null {
  const trimmed = value.trim();
  if (!/^mailto:/i.test(trimmed)) {
    return null;
  }
  const rest = trimmed.slice("mailto:".length);
  const [addressPart, queryPart = ""] = rest.split("?", 2);
  const recipient = addressPart.trim();
  if (!recipient) {
    return null;
  }
  const params = new URLSearchParams(queryPart);
  const subject = params.get("subject");
  const body = params.get("body");
  return {
    recipient,
    subject: subject?.trim().length ? subject : null,
    body: body?.trim().length ? body : null,
  };
}

export interface GmailFilterCreateResult {
  filterId: string | null;
  trashed: boolean;
}

export async function createGmailFilterForSender(args: {
  accessToken: string;
  fromAddress: string;
  trash?: boolean;
}): Promise<GmailFilterCreateResult> {
  const addRemoveLabels = args.trash
    ? { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] }
    : { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] };
  const body = {
    criteria: { from: args.fromAddress },
    action: addRemoveLabels,
  };
  const response = await googleApiFetch(GOOGLE_GMAIL_FILTERS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  try {
    const parsed = (await response.json()) as { id?: string };
    return {
      filterId: typeof parsed.id === "string" ? parsed.id : null,
      trashed: true,
    };
  } catch {
    return { filterId: null, trashed: true };
  }
}

export async function trashGmailThread(args: {
  accessToken: string;
  threadId: string;
}): Promise<void> {
  await googleApiFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(args.threadId)}/trash`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
}

export async function modifyGmailMessageLabels(args: {
  accessToken: string;
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<void> {
  await googleApiFetch(
    `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(args.messageId)}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        addLabelIds: args.addLabelIds ?? [],
        removeLabelIds: args.removeLabelIds ?? [],
      }),
    },
  );
}

export async function sendMailtoUnsubscribeEmail(args: {
  accessToken: string;
  mailto: ParsedMailto;
}): Promise<void> {
  const lines = [
    `To: ${args.mailto.recipient}`,
    `Subject: ${args.mailto.subject ?? "unsubscribe"}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    (args.mailto.body ?? "unsubscribe").replace(/\r?\n/g, "\r\n"),
  ];
  const raw = Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
  await googleApiFetch(`${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
}
