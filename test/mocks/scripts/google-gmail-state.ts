import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import {
  getLifeOpsSimulatorPerson,
  LIFEOPS_SIMULATOR_EMAILS,
  LIFEOPS_SIMULATOR_OWNER,
  type LifeOpsSimulatorEmail,
} from "../fixtures/lifeops-simulator.ts";
import {
  createGoogleCalendarMockState,
  type GoogleCalendarMockState,
  type GoogleCalendarRequestLedgerMetadata,
  googleCalendarDynamicFixture,
} from "./google-calendar-state.ts";
import { MockHttpError } from "./mock-http-error.ts";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RequestBody = Record<string, JsonValue>;

interface DynamicFixtureResponse {
  statusCode: number;
  body: JsonValue;
  headers?: Record<string, string>;
}

interface GoogleMockLedgerEntry {
  gmail?: GmailRequestLedgerMetadata;
  calendar?: GoogleCalendarRequestLedgerMetadata;
  runId?: string;
}

function jsonFixture(
  body: JsonValue | object,
  statusCode = 200,
): DynamicFixtureResponse {
  return {
    statusCode,
    body: body as JsonValue,
    headers: { "Content-Type": "application/json" },
  };
}

function randomFromAlphabet(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

function formatHttpDate(date: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${weekdays[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${
    months[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )}:${pad(date.getUTCSeconds())} GMT`;
}

function routeParam(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

type MessageResponse = {
  id: string;
  threadId: string;
  labelIds?: string[];
};

interface GmailMockAccount {
  id: string;
  name: string;
  email: string;
  grantId: string;
}

type GmailFixtureMessage = MessageResponse & {
  accountId?: string;
  snippet: string;
  internalDateOffsetMs: number;
  headers: Array<{ name: string; value: string }>;
  bodyText: string;
  attachments?: GmailFixtureAttachment[];
};

interface GmailFixtureAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  data: string;
}

const DEFAULT_GMAIL_ACCOUNT_ID = "work";

const GMAIL_MOCK_ACCOUNTS: GmailMockAccount[] = [
  {
    id: "work",
    name: "Work Gmail",
    email: "owner@example.test",
    grantId: "mock-google-work-grant",
  },
  {
    id: "home",
    name: "Home Gmail",
    email: "owner.home@example.test",
    grantId: "mock-google-home-grant",
  },
];

const GMAIL_FIXTURE_MESSAGES: GmailFixtureMessage[] = [
  {
    id: "msg-finance",
    threadId: "thr-finance",
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    snippet: "Please confirm receipt of invoice 4831 when you get a chance.",
    internalDateOffsetMs: -60 * 60 * 1000,
    headers: [
      { name: "From", value: "Finance Team <finance@example.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Invoice 4831 received" },
      { name: "Message-Id", value: "<finance-4831@example.com>" },
    ],
    bodyText:
      "Hi there,\n\nWe received invoice 4831 for April. Please confirm receipt when you get a chance.\n\nThanks,\nFinance Team\n",
  },
  {
    id: "msg-sarah",
    threadId: "thr-sarah",
    labelIds: ["INBOX", "UNREAD"],
    snippet:
      "Could you review the product brief tomorrow and send notes before lunch?",
    internalDateOffsetMs: -3 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Sarah Lee <sarah@example.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Can you review the product brief?" },
      { name: "Message-Id", value: "<sarah-brief@example.com>" },
    ],
    bodyText:
      "Hey,\n\nCan you review the product brief tomorrow and send me notes before lunch?\n\nThanks,\nSarah\n",
  },
  {
    id: "msg-julia",
    threadId: "thr-julia",
    labelIds: ["INBOX"],
    snippet: "Looking forward to our intro meeting tomorrow.",
    internalDateOffsetMs: -6 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Julia Chen <julia.chen@example.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Looking forward to tomorrow" },
      { name: "Message-Id", value: "<julia-intro@example.com>" },
    ],
    bodyText:
      "Looking forward to our intro meeting tomorrow. I'd love to compare notes on product strategy and AI assistants.\n\nBest,\nJulia\n",
  },
  {
    id: "msg-newsletter",
    threadId: "thr-news",
    labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    snippet:
      "This week in ops: ship the launch checklist and review the metrics deck.",
    internalDateOffsetMs: -10 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Weekly Digest <digest@example.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Weekly ops digest" },
      { name: "Precedence", value: "bulk" },
      { name: "List-Id", value: "<weekly.digest.example.com>" },
      { name: "Message-Id", value: "<weekly-digest@example.com>" },
    ],
    bodyText:
      "This week in ops: ship the launch checklist, review the metrics deck, and confirm next week's travel.\n",
  },
  {
    id: "msg-medium-newsletter",
    threadId: "thr-medium-news",
    labelIds: ["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"],
    snippet:
      "Top product reads from Medium this week, including AI strategy and launch notes.",
    internalDateOffsetMs: -45 * 60 * 1000,
    headers: [
      { name: "From", value: "Medium Daily Digest <newsletters@medium.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Your Medium Daily Digest" },
      { name: "Precedence", value: "bulk" },
      { name: "List-Id", value: "<daily.medium.com>" },
      {
        name: "List-Unsubscribe",
        value:
          "<mailto:unsubscribe@medium.com?subject=unsubscribe-newsletters>",
      },
      { name: "Message-Id", value: "<medium-digest@example.com>" },
    ],
    bodyText:
      "Top product reads from Medium this week, including AI strategy, launch notes, and team operations.\n",
  },
  {
    id: "msg-spam",
    threadId: "thr-spam",
    labelIds: ["SPAM", "UNREAD"],
    snippet: "Suspicious account notice routed to spam.",
    internalDateOffsetMs: -2 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Security Notice <security@example.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Account notice" },
      { name: "Message-Id", value: "<spam-notice@example.com>" },
    ],
    bodyText: "This is a synthetic spam-folder fixture.\n",
  },
  {
    id: "msg-unresponded-inbound",
    threadId: "thr-unresponded",
    labelIds: ["INBOX"],
    snippet: "Could you send the signed vendor packet?",
    internalDateOffsetMs: -16 * 24 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Vendor Ops <vendor@example.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Signed vendor packet" },
      { name: "Message-Id", value: "<vendor-inbound@example.com>" },
    ],
    bodyText: "Could you send the signed vendor packet when you can?\n",
  },
  {
    id: "msg-unresponded-sent",
    threadId: "thr-unresponded",
    labelIds: ["SENT"],
    snippet: "Following up on the signed packet.",
    internalDateOffsetMs: -14 * 24 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Owner <owner@example.test>" },
      { name: "To", value: "Vendor Ops <vendor@example.com>" },
      { name: "Subject", value: "Re: Signed vendor packet" },
      { name: "Message-Id", value: "<vendor-sent@example.test>" },
      { name: "In-Reply-To", value: "<vendor-inbound@example.com>" },
      {
        name: "References",
        value: "<vendor-inbound@example.com> <vendor-sent@example.test>",
      },
    ],
    bodyText: "Following up on the signed packet. Can you confirm receipt?\n",
  },
  {
    id: "msg-vendor-packet-signed",
    threadId: "thr-unresponded",
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    snippet: "Attached is the signed vendor packet.",
    internalDateOffsetMs: -20 * 60 * 1000,
    headers: [
      { name: "From", value: "Vendor Ops <vendor@example.com>" },
      { name: "To", value: "Owner <owner@example.test>" },
      { name: "Subject", value: "Re: Signed vendor packet" },
      { name: "Message-Id", value: "<vendor-packet-signed@example.com>" },
      { name: "In-Reply-To", value: "<vendor-inbound@example.com>" },
      {
        name: "References",
        value:
          "<vendor-inbound@example.com> <vendor-sent@example.test> <vendor-packet-signed@example.com>",
      },
    ],
    bodyText:
      "Attached is the signed vendor packet. Please use this version for the diligence review.\n",
    attachments: [
      {
        attachmentId: "att-vendor-packet-signed-pdf",
        filename: "signed-vendor-packet.pdf",
        mimeType: "application/pdf",
        data: "Synthetic signed vendor packet PDF bytes for LifeOps fixture testing.\n",
      },
    ],
  },
  {
    id: "msg-home-lease",
    accountId: "home",
    threadId: "thr-home-lease",
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    snippet: "Lease renewal needs your signature before Friday.",
    internalDateOffsetMs: -90 * 60 * 1000,
    headers: [
      { name: "From", value: "Landlord <landlord@example.net>" },
      { name: "To", value: "Owner Home <owner.home@example.test>" },
      { name: "Subject", value: "Lease renewal needs signature" },
      { name: "Message-Id", value: "<home-lease@example.net>" },
    ],
    bodyText:
      "Please review and sign the lease renewal before Friday. Reply if anything looks off.\n",
  },
  {
    id: "msg-home-dentist",
    accountId: "home",
    threadId: "thr-home-dentist",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Appointment reminder for your dentist visit next week.",
    internalDateOffsetMs: -4 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Dentist Office <dentist@example.net>" },
      { name: "To", value: "Owner Home <owner.home@example.test>" },
      { name: "Subject", value: "Dentist appointment reminder" },
      { name: "Auto-Submitted", value: "auto-generated" },
      { name: "Message-Id", value: "<home-dentist@example.net>" },
    ],
    bodyText:
      "This is an automated reminder for your dentist appointment next week.\n",
  },
  {
    id: "msg-home-family",
    accountId: "home",
    threadId: "thr-home-family",
    labelIds: ["INBOX"],
    snippet: "Can you bring dessert for Sunday dinner?",
    internalDateOffsetMs: -8 * 60 * 60 * 1000,
    headers: [
      { name: "From", value: "Mom <mom@example.net>" },
      { name: "To", value: "Owner Home <owner.home@example.test>" },
      { name: "Subject", value: "Sunday dinner logistics" },
      { name: "Message-Id", value: "<home-family@example.net>" },
    ],
    bodyText:
      "Can you bring dessert for Sunday dinner? Everyone else is covered.\n",
  },
];

function simulatorEmailToGmailFixture(
  email: LifeOpsSimulatorEmail,
): GmailFixtureMessage {
  const person = getLifeOpsSimulatorPerson(email.fromPersonKey);
  const accountEmail =
    email.accountId === "home"
      ? LIFEOPS_SIMULATOR_OWNER.homeEmail
      : LIFEOPS_SIMULATOR_OWNER.email;
  return {
    id: email.id,
    ...(email.accountId ? { accountId: email.accountId } : {}),
    threadId: email.threadId,
    labelIds: [...email.labels],
    snippet: email.snippet,
    internalDateOffsetMs: email.internalDateOffsetMs,
    headers: [
      { name: "From", value: `${person.name} <${person.email}>` },
      { name: "To", value: `Owner <${accountEmail}>` },
      { name: "Subject", value: email.subject },
      { name: "Message-Id", value: `<${email.id}@lifeops-simulator.test>` },
    ],
    bodyText: email.bodyText,
  };
}

function gmailFixtureMessages(opts?: {
  simulator?: boolean;
}): GmailFixtureMessage[] {
  return opts?.simulator
    ? [
        ...LIFEOPS_SIMULATOR_EMAILS.map(simulatorEmailToGmailFixture),
        ...GMAIL_FIXTURE_MESSAGES,
      ]
    : GMAIL_FIXTURE_MESSAGES;
}

type GmailMockMessage = Omit<GmailFixtureMessage, "internalDateOffsetMs"> & {
  accountId: string;
  accountEmail: string;
  grantId: string;
  internalDateMs: number;
  historyId: string;
  deleted: boolean;
  raw?: string;
  attachments?: GmailFixtureAttachment[];
};

interface GmailMockDraft {
  id: string;
  accountId: string;
  message: GmailMockMessage;
}

interface GmailHistoryMessageRef {
  message: { id: string; threadId: string };
}

interface GmailHistoryLabelRef extends GmailHistoryMessageRef {
  labelIds: string[];
}

interface GmailHistoryRecord {
  id: string;
  messagesAdded?: GmailHistoryMessageRef[];
  messagesDeleted?: GmailHistoryMessageRef[];
  labelsAdded?: GmailHistoryLabelRef[];
  labelsRemoved?: GmailHistoryLabelRef[];
}

export interface GmailDecodedSendMetadata {
  rawLength: number;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  runIdHeader: string | null;
  bodyText: string;
}

export interface GmailRequestLedgerMetadata {
  action: string;
  messageId?: string;
  attachmentId?: string;
  threadId?: string;
  draftId?: string;
  ids?: string[];
  batchIds?: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  query?: string;
  decodedSend?: GmailDecodedSendMetadata;
  runId?: string;
  historyId?: string;
}

export interface GoogleMockState {
  gmailAccounts: Map<string, GmailMockAccount>;
  gmailMessages: Map<string, GmailMockMessage>;
  gmailDrafts: Map<string, GmailMockDraft>;
  gmailHistoryId: number;
  gmailHistory: GmailHistoryRecord[];
  googleTokens: Map<string, GoogleMockToken>;
  calendar: GoogleCalendarMockState;
}

interface GoogleMockToken {
  scopes: Set<string>;
  gmailAccountId?: string;
  gmailGrantId?: string;
  gmailAccountEmail?: string;
}

const GOOGLE_DEFAULT_TOKEN_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
] as const;

const GOOGLE_GMAIL_READ_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;
const GOOGLE_GMAIL_SEND_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;
const GOOGLE_GMAIL_MODIFY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
] as const;
const GOOGLE_GMAIL_DRAFT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;
const GOOGLE_GMAIL_SETTINGS_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;
const GOOGLE_CALENDAR_READ_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;
const GOOGLE_CALENDAR_WRITE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
] as const;

function gmailAccountsMap(): Map<string, GmailMockAccount> {
  return new Map(
    GMAIL_MOCK_ACCOUNTS.map((account) => [account.id, { ...account }]),
  );
}

function gmailAccountForFixture(
  accounts: ReadonlyMap<string, GmailMockAccount>,
  fixture: GmailFixtureMessage,
): GmailMockAccount {
  const account =
    accounts.get(fixture.accountId ?? DEFAULT_GMAIL_ACCOUNT_ID) ??
    accounts.get(DEFAULT_GMAIL_ACCOUNT_ID);
  if (!account) {
    throw new Error("Default Gmail mock account is missing.");
  }
  return account;
}

export function createGoogleMockState(opts?: {
  simulator?: boolean;
}): GoogleMockState {
  const accounts = gmailAccountsMap();
  const messages = new Map<string, GmailMockMessage>();
  for (const fixture of gmailFixtureMessages(opts)) {
    const account = gmailAccountForFixture(accounts, fixture);
    messages.set(fixture.id, {
      id: fixture.id,
      accountId: account.id,
      accountEmail: account.email,
      grantId: account.grantId,
      threadId: fixture.threadId,
      labelIds: [...(fixture.labelIds ?? [])],
      snippet: fixture.snippet,
      internalDateMs: Date.now() + fixture.internalDateOffsetMs,
      headers: fixture.headers.map((header) => ({ ...header })),
      bodyText: fixture.bodyText,
      attachments: fixture.attachments?.map((attachment) => ({
        ...attachment,
      })),
      historyId: "123456",
      deleted: false,
    });
  }

  const draftMessage = buildGmailMessageFromRaw({
    id: "draft-message-mock",
    threadId: "thr-draft",
    labelIds: ["DRAFT"],
    raw: Buffer.from(
      "To: test@example.test\r\nSubject: Mock Gmail draft\r\n\r\nMock Gmail draft",
      "utf8",
    ).toString("base64url"),
    historyId: "123456",
    account: accounts.get(DEFAULT_GMAIL_ACCOUNT_ID),
  });

  return {
    gmailAccounts: accounts,
    gmailMessages: messages,
    gmailDrafts: new Map([
      [
        "draft-mock",
        {
          id: "draft-mock",
          accountId: draftMessage.accountId,
          message: draftMessage,
        },
      ],
    ]),
    gmailHistoryId: 123456,
    gmailHistory: [
      {
        id: "123456",
        messagesAdded: [
          { message: { id: "msg-finance", threadId: "thr-finance" } },
        ],
        labelsAdded: [
          {
            message: { id: "msg-finance", threadId: "thr-finance" },
            labelIds: ["INBOX", "UNREAD"],
          },
        ],
      },
    ],
    googleTokens: new Map(),
    calendar: createGoogleCalendarMockState(opts),
  };
}

function gmailFixtureInternalDate(
  message: GmailFixtureMessage | GmailMockMessage,
): number {
  return "internalDateMs" in message
    ? message.internalDateMs
    : Date.now() + message.internalDateOffsetMs;
}

function gmailFixtureResponse(
  message: GmailFixtureMessage | GmailMockMessage,
): JsonValue {
  const date = new Date(gmailFixtureInternalDate(message));
  const bodyData = Buffer.from(message.bodyText, "utf8").toString("base64url");
  const attachmentParts = (message.attachments ?? []).map(
    (attachment, index) => ({
      partId: String(index + 1),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      headers: [
        { name: "Content-Type", value: attachment.mimeType },
        {
          name: "Content-Disposition",
          value: `attachment; filename="${attachment.filename}"`,
        },
      ],
      body: {
        attachmentId: attachment.attachmentId,
        size: Buffer.byteLength(attachment.data, "utf8"),
      },
    }),
  );
  const headers = [
    ...message.headers,
    { name: "Date", value: formatHttpDate(date) },
  ];
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    snippet: message.snippet,
    historyId: "historyId" in message ? message.historyId : "123456",
    internalDate: String(date.getTime()),
    sizeEstimate: message.bodyText.length,
    payload:
      attachmentParts.length > 0
        ? {
            mimeType: "multipart/mixed",
            headers,
            body: { size: 0 },
            parts: [
              {
                partId: "0",
                mimeType: "text/plain",
                filename: "",
                headers: [{ name: "Content-Type", value: "text/plain" }],
                body: {
                  data: bodyData,
                  size: message.bodyText.length,
                },
              },
              ...attachmentParts,
            ],
          }
        : {
            mimeType: "text/plain",
            headers,
            body: {
              data: bodyData,
              size: message.bodyText.length,
            },
          },
  };
}

type GmailAccountSelection = ReadonlySet<string> | null;

function findGmailAccountByHint(
  state: GoogleMockState,
  value: string | undefined,
): GmailMockAccount | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "all") return null;
  return (
    [...state.gmailAccounts.values()].find(
      (account) =>
        account.id.toLowerCase() === normalized ||
        account.grantId.toLowerCase() === normalized ||
        account.email.toLowerCase() === normalized,
    ) ?? null
  );
}

function gmailTokenAccount(
  state: GoogleMockState,
  token: GoogleMockToken | null,
): GmailMockAccount | null {
  if (!token) return null;
  return (
    findGmailAccountByHint(state, token.gmailAccountId) ??
    findGmailAccountByHint(state, token.gmailGrantId) ??
    findGmailAccountByHint(state, token.gmailAccountEmail)
  );
}

function gmailAccountSelection(
  state: GoogleMockState,
  searchParams: URLSearchParams,
  token: GoogleMockToken | null,
): GmailAccountSelection {
  const tokenAccount = gmailTokenAccount(state, token);
  if (tokenAccount) return new Set([tokenAccount.id]);

  const explicit =
    searchParams.get("gmailAccountId") ??
    searchParams.get("accountId") ??
    searchParams.get("account") ??
    searchParams.get("grantId") ??
    searchParams.get("accountEmail");
  if (!explicit || explicit.trim().toLowerCase() === "all") return null;

  const account = findGmailAccountByHint(state, explicit);
  return account ? new Set([account.id]) : new Set();
}

function defaultGmailAccount(state: GoogleMockState): GmailMockAccount {
  const account =
    state.gmailAccounts.get(DEFAULT_GMAIL_ACCOUNT_ID) ??
    [...state.gmailAccounts.values()][0];
  if (!account) {
    throw new Error("Gmail mock has no accounts.");
  }
  return account;
}

function gmailWriteAccount(
  state: GoogleMockState,
  searchParams: URLSearchParams,
  token: GoogleMockToken | null,
): GmailMockAccount {
  const selection = gmailAccountSelection(state, searchParams, token);
  if (!selection) return defaultGmailAccount(state);
  const accountId = [...selection][0];
  const account = accountId ? state.gmailAccounts.get(accountId) : null;
  if (!account) {
    throw new MockHttpError(404, "Gmail mock account was not found.");
  }
  return account;
}

function gmailMessageVisible(
  message: GmailMockMessage,
  selection: GmailAccountSelection,
): boolean {
  return !selection || selection.has(message.accountId);
}

function gmailHeaderValue(
  message: GmailFixtureMessage | GmailMockMessage,
  name: string,
): string {
  const lower = name.toLowerCase();
  return (
    message.headers.find((header) => header.name.toLowerCase() === lower)
      ?.value ?? ""
  );
}

function gmailMessageNeedsResponse(
  message: GmailFixtureMessage | GmailMockMessage,
): boolean {
  const accountEmail =
    "accountEmail" in message ? message.accountEmail.toLowerCase() : "";
  const labels = new Set(
    (message.labelIds ?? []).map((label) => label.toUpperCase()),
  );
  const from = gmailHeaderValue(message, "From").toLowerCase();
  const to = gmailHeaderValue(message, "To").toLowerCase();
  const cc = gmailHeaderValue(message, "Cc").toLowerCase();
  const precedence = gmailHeaderValue(message, "Precedence").toLowerCase();
  const listId = gmailHeaderValue(message, "List-Id");
  const autoSubmitted = gmailHeaderValue(
    message,
    "Auto-Submitted",
  ).toLowerCase();
  const automated =
    Boolean(listId) ||
    ["bulk", "list", "junk", "auto-reply"].includes(precedence) ||
    (autoSubmitted.length > 0 && autoSubmitted !== "no");
  const fromSelf = accountEmail.length > 0 && from.includes(accountEmail);
  const directlyAddressed =
    accountEmail.length > 0 &&
    (to.includes(accountEmail) || cc.includes(accountEmail));
  return labels.has("UNREAD") && directlyAddressed && !fromSelf && !automated;
}

function gmailQueryTokens(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let braceDepth = 0;

  for (const char of query.trim()) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (!inQuotes && char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }
    if (!inQuotes && braceDepth === 0 && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function gmailOrGroups(tokens: readonly string[]): string[][] {
  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token.toUpperCase() === "OR") {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1]?.push(token);
  }
  return groups.filter((group) => group.length > 0);
}

function gmailQueryMatches(
  message: GmailFixtureMessage | GmailMockMessage,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const labels = new Set(
    (message.labelIds ?? []).map((label) => label.toUpperCase()),
  );
  const haystack = [
    message.id,
    message.threadId,
    message.snippet,
    message.bodyText,
    ...message.headers.map((header) => header.value),
    ...(message.attachments ?? []).map(
      (attachment) => `${attachment.filename} ${attachment.mimeType}`,
    ),
    ...(message.labelIds ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const ageMs = Date.now() - gmailFixtureInternalDate(message);
  const tokenMatches = (rawToken: string): boolean => {
    const token = rawToken.trim().toLowerCase();
    if (!token) return true;
    const negated = token.startsWith("-");
    const tokenBody = negated ? token.slice(1).trim() : token;
    if (!tokenBody) return true;
    if (tokenBody.startsWith("{") && tokenBody.endsWith("}")) {
      const groupMatched = gmailQueryTokens(tokenBody.slice(1, -1)).some(
        (entry) => tokenMatches(entry),
      );
      return negated ? !groupMatched : groupMatched;
    }

    const value = tokenBody.replace(/^"|"$/g, "");
    const matched = (() => {
      if (value === "priority" || value === "important") {
        return labels.has("IMPORTANT") || gmailMessageNeedsResponse(message);
      }
      if (value === "unread") return labels.has("UNREAD");
      if (
        value === "needs-response" ||
        value === "needs_reply" ||
        value === "reply-needed"
      ) {
        return gmailMessageNeedsResponse(message);
      }
      if (value === "in:anywhere") return true;
      if (value === "in:inbox") return labels.has("INBOX");
      if (value === "in:sent") return labels.has("SENT");
      if (value === "in:spam") return labels.has("SPAM");
      if (value === "in:trash") return labels.has("TRASH");
      if (value === "is:unread") return labels.has("UNREAD");
      if (value === "is:read") return !labels.has("UNREAD");
      if (value === "is:important") return labels.has("IMPORTANT");
      if (value.startsWith("label:")) {
        return labels.has(value.slice("label:".length).toUpperCase());
      }
      if (value.startsWith("category:")) {
        return labels.has(
          `CATEGORY_${value.slice("category:".length).toUpperCase()}`,
        );
      }
      if (value.startsWith("from:")) {
        return gmailHeaderValue(message, "From")
          .toLowerCase()
          .includes(value.slice("from:".length));
      }
      if (value.startsWith("to:")) {
        return gmailHeaderValue(message, "To")
          .toLowerCase()
          .includes(value.slice("to:".length));
      }
      if (value.startsWith("cc:")) {
        return gmailHeaderValue(message, "Cc")
          .toLowerCase()
          .includes(value.slice("cc:".length));
      }
      if (value.startsWith("subject:")) {
        return gmailHeaderValue(message, "Subject")
          .toLowerCase()
          .includes(value.slice("subject:".length));
      }
      return haystack.includes(value);
    })();
    return negated ? !matched : matched;
  };

  return gmailOrGroups(gmailQueryTokens(normalized)).some((group) =>
    group.every((token) => {
      const relative = token.match(/^(older|newer)_than:(\d+)([dmy])$/);
      if (relative) {
        const amount = Number.parseInt(relative[2] ?? "", 10);
        const unit = relative[3];
        const dayCount =
          unit === "d" ? amount : unit === "m" ? amount * 30 : amount * 365;
        const boundaryMs = dayCount * 24 * 60 * 60 * 1000;
        return relative[1] === "older"
          ? ageMs >= boundaryMs
          : ageMs <= boundaryMs;
      }
      return tokenMatches(token);
    }),
  );
}

function gmailLiveMessages(
  state: GoogleMockState,
  selection: GmailAccountSelection = null,
): GmailMockMessage[] {
  return [...state.gmailMessages.values()].filter(
    (message) => !message.deleted && gmailMessageVisible(message, selection),
  );
}

function isStringArray(value: JsonValue | undefined): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function readOptionalStringArray(
  body: RequestBody,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!isStringArray(value)) {
    throw new MockHttpError(400, `${key} must be an array of strings`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function readRequiredStringArray(body: RequestBody, key: string): string[] {
  const value = readOptionalStringArray(body, key);
  if (!value || value.length === 0) {
    throw new MockHttpError(400, `${key} must contain at least one string`);
  }
  return value;
}

function readRequiredString(body: RequestBody, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MockHttpError(400, `${key} must be a non-empty string`);
  }
  return value.trim();
}

function getMessageOrThrow(
  state: GoogleMockState,
  messageId: string,
  selection: GmailAccountSelection = null,
): GmailMockMessage {
  const message = state.gmailMessages.get(messageId);
  if (!message || message.deleted || !gmailMessageVisible(message, selection)) {
    throw new MockHttpError(404, "Requested entity was not found.");
  }
  return message;
}

function jsonError(
  statusCode: number,
  message: string,
): DynamicFixtureResponse {
  const status =
    statusCode === 401
      ? "UNAUTHENTICATED"
      : statusCode === 403
        ? "PERMISSION_DENIED"
        : statusCode === 404
          ? "NOT_FOUND"
          : "INVALID_ARGUMENT";
  return jsonFixture(
    {
      error: {
        code: statusCode,
        message,
        status,
      },
    },
    statusCode,
  );
}

function addHistoryRecord(
  state: GoogleMockState,
  record: Omit<GmailHistoryRecord, "id">,
): string {
  state.gmailHistoryId += 1;
  const id = String(state.gmailHistoryId);
  state.gmailHistory.push({ id, ...record });
  return id;
}

function gmailHistoryRecordResponse(
  record: GmailHistoryRecord,
): Record<string, JsonValue> {
  return {
    id: record.id,
    ...(record.messagesAdded
      ? {
          messagesAdded: record.messagesAdded.map((entry) => ({
            message: { ...entry.message },
          })),
        }
      : {}),
    ...(record.messagesDeleted
      ? {
          messagesDeleted: record.messagesDeleted.map((entry) => ({
            message: { ...entry.message },
          })),
        }
      : {}),
    ...(record.labelsAdded
      ? {
          labelsAdded: record.labelsAdded.map((entry) => ({
            message: { ...entry.message },
            labelIds: [...entry.labelIds],
          })),
        }
      : {}),
    ...(record.labelsRemoved
      ? {
          labelsRemoved: record.labelsRemoved.map((entry) => ({
            message: { ...entry.message },
            labelIds: [...entry.labelIds],
          })),
        }
      : {}),
  };
}

function applyLabelPatch(
  message: GmailMockMessage,
  addLabelIds: readonly string[] | undefined,
  removeLabelIds: readonly string[] | undefined,
): {
  added: string[];
  removed: string[];
} {
  const labels = new Set(message.labelIds ?? []);
  const added: string[] = [];
  const removed: string[] = [];
  for (const labelId of removeLabelIds ?? []) {
    if (labels.delete(labelId)) {
      removed.push(labelId);
    }
  }
  for (const labelId of addLabelIds ?? []) {
    if (!labels.has(labelId)) {
      labels.add(labelId);
      added.push(labelId);
    }
  }
  message.labelIds = [...labels];
  return { added, removed };
}

function modifyGmailMessages(
  state: GoogleMockState,
  ids: readonly string[],
  addLabelIds: readonly string[] | undefined,
  removeLabelIds: readonly string[] | undefined,
  selection: GmailAccountSelection = null,
): string {
  if (
    (!addLabelIds || addLabelIds.length === 0) &&
    (!removeLabelIds || removeLabelIds.length === 0)
  ) {
    throw new MockHttpError(
      400,
      "modify requires addLabelIds or removeLabelIds",
    );
  }

  const labelsAdded: GmailHistoryLabelRef[] = [];
  const labelsRemoved: GmailHistoryLabelRef[] = [];
  for (const id of ids) {
    const message = getMessageOrThrow(state, id, selection);
    const changed = applyLabelPatch(message, addLabelIds, removeLabelIds);
    if (changed.added.length > 0) {
      labelsAdded.push({
        message: { id: message.id, threadId: message.threadId },
        labelIds: changed.added,
      });
    }
    if (changed.removed.length > 0) {
      labelsRemoved.push({
        message: { id: message.id, threadId: message.threadId },
        labelIds: changed.removed,
      });
    }
  }

  const historyId = addHistoryRecord(state, {
    ...(labelsAdded.length > 0 ? { labelsAdded } : {}),
    ...(labelsRemoved.length > 0 ? { labelsRemoved } : {}),
  });
  for (const id of ids) {
    const message = state.gmailMessages.get(id);
    if (message && !message.deleted) message.historyId = historyId;
  }
  return historyId;
}

function deleteGmailMessages(
  state: GoogleMockState,
  ids: readonly string[],
  selection: GmailAccountSelection = null,
): string {
  const messagesDeleted: GmailHistoryMessageRef[] = [];
  for (const id of ids) {
    const message = getMessageOrThrow(state, id, selection);
    message.deleted = true;
    messagesDeleted.push({
      message: { id: message.id, threadId: message.threadId },
    });
  }
  return addHistoryRecord(state, { messagesDeleted });
}

function splitAddressHeader(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function decodeGmailRaw(raw: string): string {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) {
    throw new MockHttpError(400, "raw must be a base64url RFC 822 message");
  }
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (decoded.trim().length === 0 || !decoded.includes(":")) {
    throw new MockHttpError(400, "raw must decode to an RFC 822 message");
  }
  return decoded;
}

function parseRfc822(raw: string): {
  headers: Array<{ name: string; value: string }>;
  bodyText: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  const headerBlock =
    separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
  const bodyText =
    separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : "";
  const unfolded = headerBlock.replace(/\n[ \t]+/g, " ");
  const headers = unfolded
    .split("\n")
    .map((line) => {
      const index = line.indexOf(":");
      if (index <= 0) return null;
      return {
        name: line.slice(0, index).trim(),
        value: line.slice(index + 1).trim(),
      };
    })
    .filter(
      (header): header is { name: string; value: string } => header !== null,
    );
  return { headers, bodyText };
}

function readRfc822Header(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | null {
  const lower = name.toLowerCase();
  return (
    headers.find((header) => header.name.toLowerCase() === lower)?.value ?? null
  );
}

function decodedSendMetadata(raw: string): GmailDecodedSendMetadata {
  const decoded = decodeGmailRaw(raw);
  const parsed = parseRfc822(decoded);
  return {
    rawLength: raw.length,
    from: readRfc822Header(parsed.headers, "From"),
    to: splitAddressHeader(readRfc822Header(parsed.headers, "To")),
    cc: splitAddressHeader(readRfc822Header(parsed.headers, "Cc")),
    bcc: splitAddressHeader(readRfc822Header(parsed.headers, "Bcc")),
    subject: readRfc822Header(parsed.headers, "Subject"),
    messageId: readRfc822Header(parsed.headers, "Message-Id"),
    inReplyTo: readRfc822Header(parsed.headers, "In-Reply-To"),
    references: readRfc822Header(parsed.headers, "References"),
    runIdHeader:
      readRfc822Header(parsed.headers, "X-Eliza-Test-Run") ??
      readRfc822Header(parsed.headers, "X-Eliza-Run-Id"),
    bodyText: parsed.bodyText.trim(),
  };
}

function buildGmailMessageFromRaw(args: {
  id: string;
  threadId: string;
  labelIds: string[];
  raw: string;
  historyId: string;
  account?: GmailMockAccount;
}): GmailMockMessage {
  const decoded = decodeGmailRaw(args.raw);
  const parsed = parseRfc822(decoded);
  const subject = readRfc822Header(parsed.headers, "Subject") ?? "(no subject)";
  const account = args.account ?? GMAIL_MOCK_ACCOUNTS[0];
  if (!account) {
    throw new Error("Default Gmail mock account is missing.");
  }
  return {
    id: args.id,
    accountId: account.id,
    accountEmail: account.email,
    grantId: account.grantId,
    threadId: args.threadId,
    labelIds: [...args.labelIds],
    snippet: parsed.bodyText.trim().replace(/\s+/g, " ").slice(0, 160),
    internalDateMs: Date.now(),
    headers:
      parsed.headers.length > 0
        ? parsed.headers
        : [{ name: "Subject", value: subject }],
    bodyText: parsed.bodyText,
    historyId: args.historyId,
    deleted: false,
    raw: args.raw,
  };
}

function inferThreadIdFromRaw(
  state: GoogleMockState,
  raw: string,
  requestedThreadId: JsonValue | undefined,
  selection: GmailAccountSelection = null,
): string {
  if (
    typeof requestedThreadId === "string" &&
    requestedThreadId.trim().length > 0
  ) {
    return requestedThreadId.trim();
  }
  const decoded = decodedSendMetadata(raw);
  const referencedHeaders = [decoded.inReplyTo, decoded.references].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const message of gmailLiveMessages(state, selection)) {
    const messageId = readRfc822Header(message.headers, "Message-Id");
    if (
      messageId &&
      referencedHeaders.some((header) => header.includes(messageId))
    ) {
      return message.threadId;
    }
  }
  return `thr-sent-${randomFromAlphabet(
    "abcdefghijklmnopqrstuvwxyz0123456789",
    8,
  )}`;
}

function gmailListMessages(
  state: GoogleMockState,
  searchParams: URLSearchParams,
  selection: GmailAccountSelection,
  ledgerEntry: GoogleMockLedgerEntry,
): DynamicFixtureResponse {
  const includeSpamTrash = searchParams.get("includeSpamTrash") === "true";
  const query = searchParams.get("q") ?? "";
  const labelIds = searchParams.getAll("labelIds");
  const maxResults = Math.max(
    1,
    Math.min(Number.parseInt(searchParams.get("maxResults") ?? "20", 10), 50),
  );
  const pageOffset = Math.max(
    0,
    Number.parseInt(searchParams.get("pageToken") ?? "0", 10) || 0,
  );
  const queryTargetsSpamTrash = /\bin:(?:spam|trash|anywhere)\b/i.test(query);
  const labelTargetsSpamTrash = labelIds.some((labelId) =>
    /^(SPAM|TRASH)$/i.test(labelId),
  );
  const filtered = gmailLiveMessages(state, selection)
    .filter((message) => {
      const labels = new Set(
        (message.labelIds ?? []).map((label) => label.toUpperCase()),
      );
      if (
        !includeSpamTrash &&
        !queryTargetsSpamTrash &&
        !labelTargetsSpamTrash &&
        (labels.has("SPAM") || labels.has("TRASH"))
      ) {
        return false;
      }
      if (
        labelIds.length > 0 &&
        !labelIds.every((labelId) => labels.has(labelId.toUpperCase()))
      ) {
        return false;
      }
      return gmailQueryMatches(message, query);
    })
    .sort(
      (left, right) =>
        gmailFixtureInternalDate(right) - gmailFixtureInternalDate(left),
    );
  const page = filtered.slice(pageOffset, pageOffset + maxResults);
  ledgerEntry.gmail = {
    action: "messages.list",
    ...(query ? { query } : {}),
    ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
  };
  return jsonFixture({
    messages: page.map((message) => ({
      id: message.id,
      threadId: message.threadId,
    })),
    resultSizeEstimate: filtered.length,
    ...(pageOffset + maxResults < filtered.length
      ? { nextPageToken: String(pageOffset + maxResults) }
      : {}),
  });
}

function headerValue(
  headers: http.IncomingHttpHeaders,
  key: string,
): string | null {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function bearerToken(headers: http.IncomingHttpHeaders): string | null {
  const authorization = headerValue(headers, "authorization")?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function googleOAuthSearchDirs(): string[] {
  const explicitOAuthDir = process.env.ELIZA_OAUTH_DIR?.trim();
  if (explicitOAuthDir) {
    return [path.join(explicitOAuthDir, "lifeops", "google")];
  }
  const stateDir = process.env.ELIZA_STATE_DIR?.trim();
  return stateDir
    ? [path.join(stateDir, "credentials", "lifeops", "google")]
    : [];
}

function readJsonFilesRecursively(
  dir: string,
  out: string[],
  remaining: number,
): number {
  if (remaining <= 0 || !fs.existsSync(dir)) return remaining;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (remaining <= 0) break;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      remaining = readJsonFilesRecursively(fullPath, out, remaining);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(fullPath);
      remaining -= 1;
    }
  }
  return remaining;
}

function refreshGoogleTokensFromSeededGrants(state: GoogleMockState): void {
  const files: string[] = [];
  for (const dir of googleOAuthSearchDirs()) {
    readJsonFilesRecursively(dir, files, 100);
  }
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as JsonValue;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, JsonValue>;
    const accessToken = record.accessToken;
    const grantedScopes = record.grantedScopes;
    if (typeof accessToken !== "string" || !isStringArray(grantedScopes)) {
      continue;
    }
    state.googleTokens.set(accessToken, {
      scopes: new Set(grantedScopes),
      ...(typeof record.gmailAccountId === "string"
        ? { gmailAccountId: record.gmailAccountId }
        : {}),
      ...(typeof record.grantId === "string"
        ? { gmailGrantId: record.grantId }
        : {}),
      ...(typeof record.accountEmail === "string"
        ? { gmailAccountEmail: record.accountEmail }
        : typeof record.email === "string"
          ? { gmailAccountEmail: record.email }
          : {}),
    });
  }
}

function requiredGoogleScopes(
  method: string,
  pathname: string,
): readonly string[] {
  if (pathname === "/calendar/v3/users/me/calendarList") {
    return GOOGLE_CALENDAR_READ_SCOPES;
  }
  if (/^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/|$)/.test(pathname)) {
    return method === "GET"
      ? GOOGLE_CALENDAR_READ_SCOPES
      : GOOGLE_CALENDAR_WRITE_SCOPES;
  }
  if (!pathname.startsWith("/gmail/v1/users/me/")) return [];
  if (pathname.includes("/settings/filters")) {
    return GOOGLE_GMAIL_SETTINGS_SCOPES;
  }
  if (pathname.endsWith("/messages/send")) return GOOGLE_GMAIL_SEND_SCOPES;
  if (pathname.endsWith("/drafts/send")) return GOOGLE_GMAIL_SEND_SCOPES;
  if (pathname.includes("/drafts")) {
    return method === "GET"
      ? GOOGLE_GMAIL_READ_SCOPES
      : GOOGLE_GMAIL_DRAFT_SCOPES;
  }
  if (
    method === "POST" &&
    (pathname.includes("/modify") ||
      pathname.endsWith("/batchModify") ||
      pathname.endsWith("/batchDelete") ||
      pathname.endsWith("/trash") ||
      pathname.endsWith("/untrash"))
  ) {
    return GOOGLE_GMAIL_MODIFY_SCOPES;
  }
  if (method === "DELETE") return GOOGLE_GMAIL_MODIFY_SCOPES;
  return GOOGLE_GMAIL_READ_SCOPES;
}

function enforceGoogleAuthIfPresent(
  state: GoogleMockState,
  method: string,
  pathname: string,
  headers: http.IncomingHttpHeaders,
): DynamicFixtureResponse | null {
  const requiredScopes = requiredGoogleScopes(method, pathname);
  if (requiredScopes.length === 0) return null;
  const token = bearerToken(headers);
  if (!token) return null;
  if (!state.googleTokens.has(token)) {
    refreshGoogleTokensFromSeededGrants(state);
  }
  const scopes = state.googleTokens.get(token);
  if (!scopes) {
    return jsonError(401, "Unknown or expired mock Google access token");
  }
  return requiredScopes.some((scope) => scopes.scopes.has(scope))
    ? null
    : jsonError(403, "Google mock token is missing required scope");
}

function googleTokenForRequest(
  state: GoogleMockState,
  headers: http.IncomingHttpHeaders,
): GoogleMockToken | null {
  const token = bearerToken(headers);
  if (!token) return null;
  if (!state.googleTokens.has(token)) {
    refreshGoogleTokensFromSeededGrants(state);
  }
  return state.googleTokens.get(token) ?? null;
}

export function googleDynamicFixture(
  state: GoogleMockState,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  requestBody: RequestBody,
  headers: http.IncomingHttpHeaders,
  ledgerEntry: GoogleMockLedgerEntry,
): DynamicFixtureResponse | null {
  if (method === "POST" && pathname === "/token") {
    const scopeText =
      typeof requestBody.scope === "string"
        ? requestBody.scope
        : GOOGLE_DEFAULT_TOKEN_SCOPES.join(" ");
    const scopes = scopeText.split(/\s+/).filter(Boolean);
    const accessToken = `fake-${crypto.randomUUID()}`;
    const gmailAccountId =
      typeof requestBody.gmailAccountId === "string"
        ? requestBody.gmailAccountId
        : typeof requestBody.account === "string"
          ? requestBody.account
          : typeof requestBody.accountId === "string"
            ? requestBody.accountId
            : undefined;
    const gmailGrantId =
      typeof requestBody.grantId === "string" ? requestBody.grantId : undefined;
    const gmailAccountEmail =
      typeof requestBody.accountEmail === "string"
        ? requestBody.accountEmail
        : undefined;
    state.googleTokens.set(accessToken, {
      scopes: new Set(scopes),
      ...(gmailAccountId ? { gmailAccountId } : {}),
      ...(gmailGrantId ? { gmailGrantId } : {}),
      ...(gmailAccountEmail ? { gmailAccountEmail } : {}),
    });
    return jsonFixture({
      access_token: accessToken,
      expires_in: 3600,
      refresh_token: "mock-google-refresh-token",
      token_type: "Bearer",
      scope: scopes.join(" "),
    });
  }

  const authFailure = enforceGoogleAuthIfPresent(
    state,
    method,
    pathname,
    headers,
  );
  if (authFailure) return authFailure;
  const googleToken = googleTokenForRequest(state, headers);
  const gmailSelection = gmailAccountSelection(
    state,
    searchParams,
    googleToken,
  );

  const calendarResponse = googleCalendarDynamicFixture({
    state: state.calendar,
    method,
    pathname,
    searchParams,
    requestBody,
    ledgerEntry,
  });
  if (calendarResponse) return calendarResponse;

  if (!pathname.startsWith("/gmail/v1/users/me/")) return null;

  if (method === "GET" && pathname === "/gmail/v1/users/me/profile") {
    const account =
      gmailTokenAccount(state, googleToken) ??
      (gmailSelection && gmailSelection.size === 1
        ? state.gmailAccounts.get([...gmailSelection][0] ?? "")
        : null) ??
      defaultGmailAccount(state);
    const accountSelection = new Set([account.id]);
    const messages = gmailLiveMessages(state, accountSelection);
    return jsonFixture({
      emailAddress: account.email,
      messagesTotal: messages.length,
      threadsTotal: new Set(messages.map((message) => message.threadId)).size,
      historyId: String(state.gmailHistoryId),
    });
  }

  if (method === "GET" && pathname === "/gmail/v1/users/me/messages") {
    return gmailListMessages(state, searchParams, gmailSelection, ledgerEntry);
  }

  if (method === "GET" && pathname === "/gmail/v1/users/me/labels") {
    return jsonFixture({
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "DRAFT", name: "DRAFT", type: "system" },
        { id: "SPAM", name: "SPAM", type: "system" },
        { id: "TRASH", name: "TRASH", type: "system" },
        { id: "UNREAD", name: "UNREAD", type: "system" },
        { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        {
          id: "CATEGORY_PROMOTIONS",
          name: "CATEGORY_PROMOTIONS",
          type: "system",
        },
        { id: "Label_1", name: "eliza-e2e", type: "user" },
      ],
    });
  }

  if (
    method === "POST" &&
    pathname === "/gmail/v1/users/me/messages/batchModify"
  ) {
    const ids = readRequiredStringArray(requestBody, "ids");
    const addLabelIds = readOptionalStringArray(requestBody, "addLabelIds");
    const removeLabelIds = readOptionalStringArray(
      requestBody,
      "removeLabelIds",
    );
    const historyId = modifyGmailMessages(
      state,
      ids,
      addLabelIds,
      removeLabelIds,
      gmailSelection,
    );
    ledgerEntry.gmail = {
      action: "messages.batchModify",
      batchIds: ids,
      ids,
      ...(addLabelIds ? { addLabelIds } : {}),
      ...(removeLabelIds ? { removeLabelIds } : {}),
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({});
  }

  if (
    method === "POST" &&
    pathname === "/gmail/v1/users/me/messages/batchDelete"
  ) {
    const ids = readRequiredStringArray(requestBody, "ids");
    const historyId = deleteGmailMessages(state, ids, gmailSelection);
    ledgerEntry.gmail = {
      action: "messages.batchDelete",
      batchIds: ids,
      ids,
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({});
  }

  if (method === "POST" && pathname === "/gmail/v1/users/me/messages/send") {
    const raw = readRequiredString(requestBody, "raw");
    const metadata = decodedSendMetadata(raw);
    const message = buildGmailMessageFromRaw({
      id: `sent-${randomFromAlphabet(
        "abcdefghijklmnopqrstuvwxyz0123456789",
        12,
      )}`,
      threadId: inferThreadIdFromRaw(
        state,
        raw,
        requestBody.threadId,
        gmailSelection,
      ),
      labelIds: ["SENT"],
      raw,
      historyId: String(state.gmailHistoryId + 1),
      account: gmailWriteAccount(state, searchParams, googleToken),
    });
    state.gmailMessages.set(message.id, message);
    const finalHistoryId = addHistoryRecord(state, {
      messagesAdded: [
        { message: { id: message.id, threadId: message.threadId } },
      ],
    });
    message.historyId = finalHistoryId;
    ledgerEntry.gmail = {
      action: "messages.send",
      messageId: message.id,
      threadId: message.threadId,
      decodedSend: metadata,
      historyId: finalHistoryId,
      ...(metadata.runIdHeader ? { runId: metadata.runIdHeader } : {}),
    };
    return jsonFixture(gmailFixtureResponse(message));
  }

  const modifyMessageId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify\/?$/,
  );
  if (method === "POST" && modifyMessageId) {
    const addLabelIds = readOptionalStringArray(requestBody, "addLabelIds");
    const removeLabelIds = readOptionalStringArray(
      requestBody,
      "removeLabelIds",
    );
    const historyId = modifyGmailMessages(
      state,
      [modifyMessageId],
      addLabelIds,
      removeLabelIds,
      gmailSelection,
    );
    const message = getMessageOrThrow(state, modifyMessageId, gmailSelection);
    ledgerEntry.gmail = {
      action: "messages.modify",
      messageId: modifyMessageId,
      ids: [modifyMessageId],
      ...(addLabelIds ? { addLabelIds } : {}),
      ...(removeLabelIds ? { removeLabelIds } : {}),
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture(gmailFixtureResponse(message));
  }

  const trashMessageId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/trash\/?$/,
  );
  if (method === "POST" && trashMessageId) {
    const historyId = modifyGmailMessages(
      state,
      [trashMessageId],
      ["TRASH"],
      ["INBOX", "SPAM"],
      gmailSelection,
    );
    const message = getMessageOrThrow(state, trashMessageId, gmailSelection);
    ledgerEntry.gmail = {
      action: "messages.trash",
      messageId: trashMessageId,
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX", "SPAM"],
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture(gmailFixtureResponse(message));
  }

  const untrashMessageId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/untrash\/?$/,
  );
  if (method === "POST" && untrashMessageId) {
    const historyId = modifyGmailMessages(
      state,
      [untrashMessageId],
      ["INBOX"],
      ["TRASH"],
      gmailSelection,
    );
    const message = getMessageOrThrow(state, untrashMessageId, gmailSelection);
    ledgerEntry.gmail = {
      action: "messages.untrash",
      messageId: untrashMessageId,
      addLabelIds: ["INBOX"],
      removeLabelIds: ["TRASH"],
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture(gmailFixtureResponse(message));
  }

  const attachmentPath =
    /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)\/?$/.exec(
      pathname,
    );
  if (method === "GET" && attachmentPath) {
    const messageId = decodeURIComponent(attachmentPath[1] ?? "");
    const attachmentId = decodeURIComponent(attachmentPath[2] ?? "");
    const message = getMessageOrThrow(state, messageId, gmailSelection);
    const attachment = message.attachments?.find(
      (candidate) => candidate.attachmentId === attachmentId,
    );
    if (!attachment) {
      return jsonError(404, "Requested entity was not found.");
    }
    ledgerEntry.gmail = {
      action: "messages.attachments.get",
      messageId,
      attachmentId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({
      attachmentId,
      size: Buffer.byteLength(attachment.data, "utf8"),
      data: Buffer.from(attachment.data, "utf8").toString("base64url"),
    });
  }

  const deleteMessageId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/?$/,
  );
  if (method === "DELETE" && deleteMessageId) {
    const historyId = deleteGmailMessages(
      state,
      [deleteMessageId],
      gmailSelection,
    );
    ledgerEntry.gmail = {
      action: "messages.delete",
      messageId: deleteMessageId,
      ids: [deleteMessageId],
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({});
  }
  if (method === "GET" && deleteMessageId) {
    const message = state.gmailMessages.get(deleteMessageId);
    return message &&
      !message.deleted &&
      gmailMessageVisible(message, gmailSelection)
      ? jsonFixture(gmailFixtureResponse(message))
      : jsonError(404, "Requested entity was not found.");
  }

  if (method === "POST" && pathname === "/gmail/v1/users/me/drafts") {
    const messageBody = requestBody.message;
    if (
      !messageBody ||
      typeof messageBody !== "object" ||
      Array.isArray(messageBody)
    ) {
      throw new MockHttpError(400, "message must be an object");
    }
    const messageRecord = messageBody as Record<string, JsonValue>;
    const raw = messageRecord.raw;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new MockHttpError(400, "message.raw must be a non-empty string");
    }
    const historyId = addHistoryRecord(state, {});
    const draftMessage = buildGmailMessageFromRaw({
      id: `draft-message-${randomFromAlphabet(
        "abcdefghijklmnopqrstuvwxyz0123456789",
        10,
      )}`,
      threadId: inferThreadIdFromRaw(
        state,
        raw,
        messageRecord.threadId,
        gmailSelection,
      ),
      labelIds: ["DRAFT"],
      raw,
      historyId,
      account: gmailWriteAccount(state, searchParams, googleToken),
    });
    const draft: GmailMockDraft = {
      id: `draft-${randomFromAlphabet(
        "abcdefghijklmnopqrstuvwxyz0123456789",
        10,
      )}`,
      accountId: draftMessage.accountId,
      message: draftMessage,
    };
    state.gmailDrafts.set(draft.id, draft);
    ledgerEntry.gmail = {
      action: "drafts.create",
      draftId: draft.id,
      messageId: draft.message.id,
      threadId: draft.message.threadId,
      decodedSend: decodedSendMetadata(raw),
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({
      id: draft.id,
      message: gmailFixtureResponse(draft.message),
    });
  }

  if (method === "GET" && pathname === "/gmail/v1/users/me/drafts") {
    const drafts = [...state.gmailDrafts.values()].filter((draft) =>
      gmailSelection ? gmailSelection.has(draft.accountId) : true,
    );
    return jsonFixture({
      drafts: drafts.map((draft) => ({
        id: draft.id,
        message: {
          id: draft.message.id,
          threadId: draft.message.threadId,
        },
      })),
      resultSizeEstimate: drafts.length,
    });
  }

  const draftId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)\/?$/,
  );
  if (method === "GET" && draftId) {
    const draft = state.gmailDrafts.get(draftId);
    if (!draft || (gmailSelection && !gmailSelection.has(draft.accountId))) {
      return jsonError(404, "Requested entity was not found.");
    }
    return jsonFixture({
      id: draft.id,
      message: gmailFixtureResponse(draft.message),
    });
  }
  if (method === "DELETE" && draftId) {
    const draft = state.gmailDrafts.get(draftId);
    if (!draft || (gmailSelection && !gmailSelection.has(draft.accountId))) {
      return jsonError(404, "Requested entity was not found.");
    }
    state.gmailDrafts.delete(draftId);
    ledgerEntry.gmail = {
      action: "drafts.delete",
      draftId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({});
  }

  if (method === "POST" && pathname === "/gmail/v1/users/me/drafts/send") {
    const draftIdToSend = readRequiredString(requestBody, "id");
    const draft = state.gmailDrafts.get(draftIdToSend);
    if (!draft || (gmailSelection && !gmailSelection.has(draft.accountId))) {
      return jsonError(404, "Requested entity was not found.");
    }
    const raw = draft.message.raw;
    if (!raw) {
      throw new MockHttpError(400, "draft message is missing raw content");
    }
    const sentMessage = buildGmailMessageFromRaw({
      id: `sent-draft-${randomFromAlphabet(
        "abcdefghijklmnopqrstuvwxyz0123456789",
        12,
      )}`,
      threadId: draft.message.threadId,
      labelIds: ["SENT"],
      raw,
      historyId: String(state.gmailHistoryId + 1),
      account:
        state.gmailAccounts.get(draft.accountId) ?? defaultGmailAccount(state),
    });
    state.gmailDrafts.delete(draftIdToSend);
    state.gmailMessages.set(sentMessage.id, sentMessage);
    const finalHistoryId = addHistoryRecord(state, {
      messagesAdded: [
        { message: { id: sentMessage.id, threadId: sentMessage.threadId } },
      ],
    });
    sentMessage.historyId = finalHistoryId;
    ledgerEntry.gmail = {
      action: "drafts.send",
      draftId: draftIdToSend,
      messageId: sentMessage.id,
      threadId: sentMessage.threadId,
      decodedSend: decodedSendMetadata(raw),
      historyId: finalHistoryId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture(gmailFixtureResponse(sentMessage));
  }

  if (method === "POST" && pathname === "/gmail/v1/users/me/watch") {
    const topicName = requestBody.topicName;
    if (typeof topicName !== "string" || topicName.trim().length === 0) {
      throw new MockHttpError(400, "topicName must be a non-empty string");
    }
    const labelIds = readOptionalStringArray(requestBody, "labelIds");
    ledgerEntry.gmail = {
      action: "watch",
      ...(labelIds ? { ids: labelIds } : {}),
      historyId: String(state.gmailHistoryId),
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({
      historyId: String(state.gmailHistoryId),
      expiration: String(Date.now() + 60 * 60 * 1000),
    });
  }

  if (method === "GET" && pathname === "/gmail/v1/users/me/history") {
    const startHistoryId = Number.parseInt(
      searchParams.get("startHistoryId") ?? "0",
      10,
    );
    const history = state.gmailHistory.filter(
      (entry) => Number.parseInt(entry.id, 10) > startHistoryId,
    );
    return jsonFixture({
      history: history.map((entry) => gmailHistoryRecordResponse(entry)),
      historyId: String(state.gmailHistoryId),
    });
  }

  if (method === "GET" && pathname === "/gmail/v1/users/me/threads") {
    const liveMessages = gmailLiveMessages(state, gmailSelection);
    const threadIds = [
      ...new Set(liveMessages.map((message) => message.threadId)),
    ];
    return jsonFixture({
      threads: threadIds.map((id) => ({
        id,
        historyId: String(state.gmailHistoryId),
        snippet:
          liveMessages.find((message) => message.threadId === id)?.snippet ??
          "",
      })),
      resultSizeEstimate: threadIds.length,
    });
  }

  const threadId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/?$/,
  );
  if (method === "GET" && threadId) {
    const messages = gmailLiveMessages(state, gmailSelection).filter(
      (message) => message.threadId === threadId,
    );
    if (messages.length === 0) {
      return jsonError(404, "Requested entity was not found.");
    }
    return jsonFixture({
      id: threadId,
      historyId: String(state.gmailHistoryId),
      messages: messages.map((message) => gmailFixtureResponse(message)),
    });
  }

  const modifyThreadId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/modify\/?$/,
  );
  if (method === "POST" && modifyThreadId) {
    const ids = gmailLiveMessages(state, gmailSelection)
      .filter((message) => message.threadId === modifyThreadId)
      .map((message) => message.id);
    if (ids.length === 0) {
      return jsonError(404, "Requested entity was not found.");
    }
    const addLabelIds = readOptionalStringArray(requestBody, "addLabelIds");
    const removeLabelIds = readOptionalStringArray(
      requestBody,
      "removeLabelIds",
    );
    const historyId = modifyGmailMessages(
      state,
      ids,
      addLabelIds,
      removeLabelIds,
      gmailSelection,
    );
    ledgerEntry.gmail = {
      action: "threads.modify",
      threadId: modifyThreadId,
      ids,
      ...(addLabelIds ? { addLabelIds } : {}),
      ...(removeLabelIds ? { removeLabelIds } : {}),
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({
      id: modifyThreadId,
      historyId,
      messages: ids.map((id) =>
        gmailFixtureResponse(getMessageOrThrow(state, id, gmailSelection)),
      ),
    });
  }

  const trashThreadId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/trash\/?$/,
  );
  if (method === "POST" && trashThreadId) {
    const ids = gmailLiveMessages(state, gmailSelection)
      .filter((message) => message.threadId === trashThreadId)
      .map((message) => message.id);
    if (ids.length === 0) {
      return jsonError(404, "Requested entity was not found.");
    }
    const historyId = modifyGmailMessages(
      state,
      ids,
      ["TRASH"],
      ["INBOX", "SPAM"],
      gmailSelection,
    );
    ledgerEntry.gmail = {
      action: "threads.trash",
      threadId: trashThreadId,
      ids,
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX", "SPAM"],
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({
      id: trashThreadId,
      historyId,
      messages: ids.map((id) =>
        gmailFixtureResponse(getMessageOrThrow(state, id, gmailSelection)),
      ),
    });
  }

  const untrashThreadId = routeParam(
    pathname,
    /^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/untrash\/?$/,
  );
  if (method === "POST" && untrashThreadId) {
    const ids = gmailLiveMessages(state, gmailSelection)
      .filter((message) => message.threadId === untrashThreadId)
      .map((message) => message.id);
    if (ids.length === 0) {
      return jsonError(404, "Requested entity was not found.");
    }
    const historyId = modifyGmailMessages(
      state,
      ids,
      ["INBOX"],
      ["TRASH"],
      gmailSelection,
    );
    ledgerEntry.gmail = {
      action: "threads.untrash",
      threadId: untrashThreadId,
      ids,
      addLabelIds: ["INBOX"],
      removeLabelIds: ["TRASH"],
      historyId,
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({
      id: untrashThreadId,
      historyId,
      messages: ids.map((id) =>
        gmailFixtureResponse(getMessageOrThrow(state, id, gmailSelection)),
      ),
    });
  }

  if (method === "POST" && pathname === "/gmail/v1/users/me/settings/filters") {
    if (!requestBody.criteria || !requestBody.action) {
      throw new MockHttpError(400, "filter requires criteria and action");
    }
    ledgerEntry.gmail = {
      action: "settings.filters.create",
      ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
    };
    return jsonFixture({
      id: `filter-${randomFromAlphabet(
        "abcdefghijklmnopqrstuvwxyz0123456789",
        8,
      )}`,
      criteria: { from: "*@example.com" },
      action: { removeLabelIds: ["INBOX"] },
    });
  }

  return null;
}
