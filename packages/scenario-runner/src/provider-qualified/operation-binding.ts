/**
 * Validates provider-native canary targets and operation inputs before reducing
 * them to domain-separated canonical hashes. Raw operator values remain outside
 * the publishable manifest; this module only returns them from the explicit
 * validation API used at the private controller boundary.
 */

import { createHash } from "node:crypto";

export const PROVIDER_OPERATION_BINDING_SCHEMA =
  "eliza.provider-operation-binding.v1" as const;

export const PROVIDER_OPERATION_KINDS = [
  "bluebubbles.message-send",
  "discord.message-send",
  "duffel.booking-hold-create",
  "gmail.email-send",
  "google-calendar.event-create",
  "google-sheets.spreadsheet-create",
  "signal.message-send",
  "slack.message-send",
  "telegram.message-send",
  "twilio.sms-send",
  "twilio.call-create",
  "whatsapp.message-send",
  "x.direct-message-send",
] as const;

export type ProviderOperationKind = (typeof PROVIDER_OPERATION_KINDS)[number];

export interface ProviderOperationContract {
  provider: string;
  connectorProvider: string;
  operation: string;
}

/** Canonical observer system, account-provider namespace, and effect operation for each canary. */
export const PROVIDER_OPERATION_CONTRACT_BY_KIND = {
  "bluebubbles.message-send": {
    provider: "bluebubbles",
    connectorProvider: "bluebubbles",
    operation: "message-send",
  },
  "discord.message-send": {
    provider: "discord",
    connectorProvider: "discord",
    operation: "message-send",
  },
  "duffel.booking-hold-create": {
    provider: "duffel",
    connectorProvider: "duffel",
    operation: "booking-hold-create",
  },
  "gmail.email-send": {
    provider: "gmail",
    connectorProvider: "google",
    operation: "email-send",
  },
  "google-calendar.event-create": {
    provider: "google-calendar",
    connectorProvider: "google",
    operation: "event-create",
  },
  "google-sheets.spreadsheet-create": {
    provider: "google-drive",
    connectorProvider: "google",
    operation: "spreadsheet-create",
  },
  "signal.message-send": {
    provider: "signal",
    connectorProvider: "signal",
    operation: "message-send",
  },
  "slack.message-send": {
    provider: "slack",
    connectorProvider: "slack",
    operation: "message-send",
  },
  "telegram.message-send": {
    provider: "telegram",
    connectorProvider: "telegram",
    operation: "message-send",
  },
  "twilio.sms-send": {
    provider: "twilio",
    connectorProvider: "twilio",
    operation: "sms-send",
  },
  "twilio.call-create": {
    provider: "twilio",
    connectorProvider: "twilio",
    operation: "call-create",
  },
  "whatsapp.message-send": {
    provider: "whatsapp",
    connectorProvider: "whatsapp",
    operation: "message-send",
  },
  "x.direct-message-send": {
    provider: "x",
    connectorProvider: "x",
    operation: "message-send",
  },
} as const satisfies Record<ProviderOperationKind, ProviderOperationContract>;

type NullableString = string | null;

export interface DuffelCanaryPassenger {
  offerPassengerId: string;
  givenName: string;
  familyName: string;
  bornOn: string;
  email: NullableString;
  phoneNumber: NullableString;
  title: NullableString;
  gender: NullableString;
}

export interface ProviderOperationTargetByKind {
  "bluebubbles.message-send": { chatGuid: string };
  "discord.message-send": { guildId: string; channelId: string };
  "duffel.booking-hold-create": {
    offerId: string;
    itinerary: {
      origin: string;
      destination: string;
      departureDate: string;
      returnDate: NullableString;
      passengerCount: number;
    };
  };
  "gmail.email-send": { recipientEmail: string };
  "google-calendar.event-create": { calendarId: string };
  "google-sheets.spreadsheet-create": { parentFolderId: string };
  "signal.message-send": { recipientKind: "direct"; channelId: string };
  "slack.message-send": {
    teamId: string;
    channelId: string;
    threadTs: null;
  };
  "telegram.message-send": { chatId: string; threadId: null };
  "twilio.sms-send": { fromE164: string; toE164: string };
  "twilio.call-create": { fromE164: string; toE164: string };
  "whatsapp.message-send": {
    transport: "cloud-api" | "baileys";
    chatId: string;
  };
  "x.direct-message-send": { participantId: string };
}

export interface ProviderOperationInputByKind {
  "bluebubbles.message-send": {
    text: string;
    replyToMessageGuid: null;
  };
  "discord.message-send": { text: string; attachments: [] };
  "duffel.booking-hold-create": {
    orderType: "hold";
    totalCents: number;
    currency: string;
    passengers: [DuffelCanaryPassenger, ...DuffelCanaryPassenger[]];
    calendarSync: {
      enabled: boolean;
      calendarId: NullableString;
      title: NullableString;
      description: NullableString;
      location: NullableString;
      timeZone: NullableString;
    };
  };
  "gmail.email-send": {
    subject: string;
    bodyText: string;
    cc: [];
    bcc: [];
  };
  "google-calendar.event-create": {
    title: string;
    start: string;
    end: string;
    timeZone: string;
    attendees: [];
    location: null;
    description: null;
    createMeetLink: false;
    sendUpdates: "none";
    recurrence: [];
    idempotencyKey: string;
  };
  "google-sheets.spreadsheet-create": {
    name: string;
    mimeType: "application/vnd.google-apps.spreadsheet";
    content: null;
  };
  "signal.message-send": { text: string };
  "slack.message-send": { text: string; attachments: [] };
  "telegram.message-send": { text: string };
  "twilio.sms-send": { body: string; idempotencyKey: string };
  "twilio.call-create": { message: string; idempotencyKey: string };
  "whatsapp.message-send": {
    text: string;
    replyToMessageId: null;
    attachments: [];
  };
  "x.direct-message-send": { text: string };
}

export type ProviderOperationRawBinding = {
  [Kind in ProviderOperationKind]: {
    kind: Kind;
    providerTarget: ProviderOperationTargetByKind[Kind];
    operationInput: ProviderOperationInputByKind[Kind];
  };
}[ProviderOperationKind];

export interface ProviderOperationBinding {
  schema: typeof PROVIDER_OPERATION_BINDING_SCHEMA;
  kind: ProviderOperationKind;
  providerTargetRefSha256: string;
  operationInputSha256: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NUMERIC_ID_PATTERN = /^\d+$/;
const SLACK_ID_PATTERN = /^[A-Z][A-Z0-9]{5,}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IATA_PATTERN = /^[A-Z]{3}$/;
const BAILEYS_USER_JID_PATTERN = /^\d+(?::\d+)?@s\.whatsapp\.net$/i;
const BAILEYS_LID_PATTERN = /^\d+@lid$/i;
const BAILEYS_GROUP_JID_PATTERN = /^\d+(?:-\d+)*@g\.us$/i;
const PROVIDER_OPERATION_KIND_SET = new Set<string>(PROVIDER_OPERATION_KINDS);

type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function fail(path: string, message: string): never {
  throw new Error(`provider operation binding ${path} ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "cannot contain symbol properties");
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key}`, "must be an enumerable data property");
    }
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const candidate = record(value, path);
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    fail(path, `must contain exactly: ${expected.join(", ")}`);
  }
  return candidate;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value.trim();
}

function stringMatching(
  value: unknown,
  path: string,
  pattern: RegExp,
  description: string,
): string {
  const candidate = string(value, path);
  if (!pattern.test(candidate)) fail(path, `must be ${description}`);
  return candidate;
}

function nullableString(value: unknown, path: string): NullableString {
  return value === null ? null : string(value, path);
}

function literal<T extends string | boolean | null>(
  value: unknown,
  path: string,
  expected: T,
): T {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(path, "must be a positive safe integer");
  }
  return value;
}

function emptyArray(value: unknown, path: string): [] {
  if (!Array.isArray(value) || value.length !== 0) {
    fail(path, "must be an empty array");
  }
  return [];
}

function isoDate(value: unknown, path: string): string {
  const candidate = stringMatching(
    value,
    path,
    ISO_DATE_PATTERN,
    "an ISO date (YYYY-MM-DD)",
  );
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== candidate
  ) {
    fail(path, "must be a real calendar date");
  }
  return candidate;
}

function isoDateTime(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!candidate.includes("T") || Number.isNaN(Date.parse(candidate))) {
    fail(path, "must be an ISO date-time");
  }
  return candidate;
}

function validatePassenger(
  value: unknown,
  path: string,
): DuffelCanaryPassenger {
  const passenger = exactRecord(value, path, [
    "offerPassengerId",
    "givenName",
    "familyName",
    "bornOn",
    "email",
    "phoneNumber",
    "title",
    "gender",
  ]);
  const email = nullableString(passenger.email, `${path}.email`);
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    fail(`${path}.email`, "must be an email address or null");
  }
  const phoneNumber = nullableString(
    passenger.phoneNumber,
    `${path}.phoneNumber`,
  );
  if (phoneNumber !== null && !E164_PATTERN.test(phoneNumber)) {
    fail(`${path}.phoneNumber`, "must be E.164 or null");
  }
  return {
    offerPassengerId: string(
      passenger.offerPassengerId,
      `${path}.offerPassengerId`,
    ),
    givenName: string(passenger.givenName, `${path}.givenName`),
    familyName: string(passenger.familyName, `${path}.familyName`),
    bornOn: isoDate(passenger.bornOn, `${path}.bornOn`),
    email,
    phoneNumber,
    title: nullableString(passenger.title, `${path}.title`),
    gender: nullableString(passenger.gender, `${path}.gender`),
  };
}

function targetFor(kind: ProviderOperationKind, value: unknown): unknown {
  const path = "raw.providerTarget";
  switch (kind) {
    case "bluebubbles.message-send": {
      const target = exactRecord(value, path, ["chatGuid"]);
      return { chatGuid: string(target.chatGuid, `${path}.chatGuid`) };
    }
    case "discord.message-send": {
      const target = exactRecord(value, path, ["guildId", "channelId"]);
      return {
        guildId: stringMatching(
          target.guildId,
          `${path}.guildId`,
          NUMERIC_ID_PATTERN,
          "a numeric Discord snowflake",
        ),
        channelId: stringMatching(
          target.channelId,
          `${path}.channelId`,
          NUMERIC_ID_PATTERN,
          "a numeric Discord snowflake",
        ),
      };
    }
    case "duffel.booking-hold-create": {
      const target = exactRecord(value, path, ["offerId", "itinerary"]);
      const itineraryPath = `${path}.itinerary`;
      const itinerary = exactRecord(target.itinerary, itineraryPath, [
        "origin",
        "destination",
        "departureDate",
        "returnDate",
        "passengerCount",
      ]);
      const departureDate = isoDate(
        itinerary.departureDate,
        `${itineraryPath}.departureDate`,
      );
      const returnDate =
        itinerary.returnDate === null
          ? null
          : isoDate(itinerary.returnDate, `${itineraryPath}.returnDate`);
      if (returnDate !== null && returnDate < departureDate) {
        fail(`${itineraryPath}.returnDate`, "cannot precede departureDate");
      }
      return {
        offerId: string(target.offerId, `${path}.offerId`),
        itinerary: {
          origin: stringMatching(
            itinerary.origin,
            `${itineraryPath}.origin`,
            IATA_PATTERN,
            "an uppercase three-letter IATA code",
          ),
          destination: stringMatching(
            itinerary.destination,
            `${itineraryPath}.destination`,
            IATA_PATTERN,
            "an uppercase three-letter IATA code",
          ),
          departureDate,
          returnDate,
          passengerCount: positiveInteger(
            itinerary.passengerCount,
            `${itineraryPath}.passengerCount`,
          ),
        },
      };
    }
    case "gmail.email-send": {
      const target = exactRecord(value, path, ["recipientEmail"]);
      return {
        recipientEmail: stringMatching(
          target.recipientEmail,
          `${path}.recipientEmail`,
          EMAIL_PATTERN,
          "an email address",
        ),
      };
    }
    case "google-calendar.event-create": {
      const target = exactRecord(value, path, ["calendarId"]);
      return { calendarId: string(target.calendarId, `${path}.calendarId`) };
    }
    case "google-sheets.spreadsheet-create": {
      const target = exactRecord(value, path, ["parentFolderId"]);
      return {
        parentFolderId: string(target.parentFolderId, `${path}.parentFolderId`),
      };
    }
    case "signal.message-send": {
      const target = exactRecord(value, path, ["recipientKind", "channelId"]);
      return {
        recipientKind: literal(
          target.recipientKind,
          `${path}.recipientKind`,
          "direct",
        ),
        channelId: stringMatching(
          target.channelId,
          `${path}.channelId`,
          E164_PATTERN,
          "an E.164 phone number",
        ),
      };
    }
    case "slack.message-send": {
      const target = exactRecord(value, path, [
        "teamId",
        "channelId",
        "threadTs",
      ]);
      return {
        teamId: stringMatching(
          target.teamId,
          `${path}.teamId`,
          SLACK_ID_PATTERN,
          "a Slack team ID",
        ),
        channelId: stringMatching(
          target.channelId,
          `${path}.channelId`,
          SLACK_ID_PATTERN,
          "a Slack channel ID",
        ),
        threadTs: literal(target.threadTs, `${path}.threadTs`, null),
      };
    }
    case "telegram.message-send": {
      const target = exactRecord(value, path, ["chatId", "threadId"]);
      const chatId = stringMatching(
        target.chatId,
        `${path}.chatId`,
        NUMERIC_ID_PATTERN,
        "a positive numeric private-chat ID",
      );
      if (chatId === "0") fail(`${path}.chatId`, "must be positive");
      return {
        chatId,
        threadId: literal(target.threadId, `${path}.threadId`, null),
      };
    }
    case "twilio.sms-send":
    case "twilio.call-create": {
      const target = exactRecord(value, path, ["fromE164", "toE164"]);
      return {
        fromE164: stringMatching(
          target.fromE164,
          `${path}.fromE164`,
          E164_PATTERN,
          "an E.164 phone number",
        ),
        toE164: stringMatching(
          target.toE164,
          `${path}.toE164`,
          E164_PATTERN,
          "an E.164 phone number",
        ),
      };
    }
    case "whatsapp.message-send": {
      const target = exactRecord(value, path, ["transport", "chatId"]);
      if (target.transport !== "cloud-api" && target.transport !== "baileys") {
        fail(`${path}.transport`, 'must equal "cloud-api" or "baileys"');
      }
      const chatId = string(target.chatId, `${path}.chatId`);
      if (target.transport === "cloud-api" && !E164_PATTERN.test(chatId)) {
        fail(`${path}.chatId`, "must be E.164 for Cloud API transport");
      }
      if (
        target.transport === "baileys" &&
        !BAILEYS_USER_JID_PATTERN.test(chatId) &&
        !BAILEYS_LID_PATTERN.test(chatId) &&
        !BAILEYS_GROUP_JID_PATTERN.test(chatId)
      ) {
        fail(`${path}.chatId`, "must be a supported Baileys JID");
      }
      return { transport: target.transport, chatId };
    }
    case "x.direct-message-send": {
      const target = exactRecord(value, path, ["participantId"]);
      return {
        participantId: stringMatching(
          target.participantId,
          `${path}.participantId`,
          NUMERIC_ID_PATTERN,
          "a numeric X user ID",
        ),
      };
    }
  }
}

function textOnly(value: unknown, path: string): { text: string } {
  const input = exactRecord(value, path, ["text"]);
  return { text: string(input.text, `${path}.text`) };
}

function inputFor(kind: ProviderOperationKind, value: unknown): unknown {
  const path = "raw.operationInput";
  switch (kind) {
    case "bluebubbles.message-send": {
      const input = exactRecord(value, path, ["text", "replyToMessageGuid"]);
      return {
        text: string(input.text, `${path}.text`),
        replyToMessageGuid: literal(
          input.replyToMessageGuid,
          `${path}.replyToMessageGuid`,
          null,
        ),
      };
    }
    case "discord.message-send":
    case "slack.message-send": {
      const input = exactRecord(value, path, ["text", "attachments"]);
      return {
        text: string(input.text, `${path}.text`),
        attachments: emptyArray(input.attachments, `${path}.attachments`),
      };
    }
    case "duffel.booking-hold-create": {
      const input = exactRecord(value, path, [
        "orderType",
        "totalCents",
        "currency",
        "passengers",
        "calendarSync",
      ]);
      literal(input.orderType, `${path}.orderType`, "hold");
      if (!Array.isArray(input.passengers) || input.passengers.length === 0) {
        fail(`${path}.passengers`, "must be a non-empty array");
      }
      const calendarPath = `${path}.calendarSync`;
      const calendar = exactRecord(input.calendarSync, calendarPath, [
        "enabled",
        "calendarId",
        "title",
        "description",
        "location",
        "timeZone",
      ]);
      return {
        orderType: "hold",
        totalCents: positiveInteger(input.totalCents, `${path}.totalCents`),
        currency: stringMatching(
          input.currency,
          `${path}.currency`,
          /^[A-Z]{3}$/,
          "an uppercase ISO 4217 currency code",
        ),
        passengers: input.passengers.map((passenger, index) =>
          validatePassenger(passenger, `${path}.passengers[${index}]`),
        ),
        calendarSync: {
          enabled: boolean(calendar.enabled, `${calendarPath}.enabled`),
          calendarId: nullableString(
            calendar.calendarId,
            `${calendarPath}.calendarId`,
          ),
          title: nullableString(calendar.title, `${calendarPath}.title`),
          description: nullableString(
            calendar.description,
            `${calendarPath}.description`,
          ),
          location: nullableString(
            calendar.location,
            `${calendarPath}.location`,
          ),
          timeZone: nullableString(
            calendar.timeZone,
            `${calendarPath}.timeZone`,
          ),
        },
      };
    }
    case "gmail.email-send": {
      const input = exactRecord(value, path, [
        "subject",
        "bodyText",
        "cc",
        "bcc",
      ]);
      return {
        subject: string(input.subject, `${path}.subject`),
        bodyText: string(input.bodyText, `${path}.bodyText`),
        cc: emptyArray(input.cc, `${path}.cc`),
        bcc: emptyArray(input.bcc, `${path}.bcc`),
      };
    }
    case "google-calendar.event-create": {
      const input = exactRecord(value, path, [
        "title",
        "start",
        "end",
        "timeZone",
        "attendees",
        "location",
        "description",
        "createMeetLink",
        "sendUpdates",
        "recurrence",
        "idempotencyKey",
      ]);
      const start = isoDateTime(input.start, `${path}.start`);
      const end = isoDateTime(input.end, `${path}.end`);
      if (Date.parse(end) <= Date.parse(start))
        fail(`${path}.end`, "must follow start");
      return {
        title: string(input.title, `${path}.title`),
        start,
        end,
        timeZone: string(input.timeZone, `${path}.timeZone`),
        attendees: emptyArray(input.attendees, `${path}.attendees`),
        location: literal(input.location, `${path}.location`, null),
        description: literal(input.description, `${path}.description`, null),
        createMeetLink: literal(
          input.createMeetLink,
          `${path}.createMeetLink`,
          false,
        ),
        sendUpdates: literal(input.sendUpdates, `${path}.sendUpdates`, "none"),
        recurrence: emptyArray(input.recurrence, `${path}.recurrence`),
        idempotencyKey: string(input.idempotencyKey, `${path}.idempotencyKey`),
      };
    }
    case "google-sheets.spreadsheet-create": {
      const input = exactRecord(value, path, ["name", "mimeType", "content"]);
      return {
        name: string(input.name, `${path}.name`),
        mimeType: literal(
          input.mimeType,
          `${path}.mimeType`,
          "application/vnd.google-apps.spreadsheet",
        ),
        content: literal(input.content, `${path}.content`, null),
      };
    }
    case "signal.message-send":
    case "telegram.message-send":
    case "x.direct-message-send":
      return textOnly(value, path);
    case "twilio.sms-send": {
      const input = exactRecord(value, path, ["body", "idempotencyKey"]);
      return {
        body: string(input.body, `${path}.body`),
        idempotencyKey: string(input.idempotencyKey, `${path}.idempotencyKey`),
      };
    }
    case "twilio.call-create": {
      const input = exactRecord(value, path, ["message", "idempotencyKey"]);
      return {
        message: string(input.message, `${path}.message`),
        idempotencyKey: string(input.idempotencyKey, `${path}.idempotencyKey`),
      };
    }
    case "whatsapp.message-send": {
      const input = exactRecord(value, path, [
        "text",
        "replyToMessageId",
        "attachments",
      ]);
      return {
        text: string(input.text, `${path}.text`),
        replyToMessageId: literal(
          input.replyToMessageId,
          `${path}.replyToMessageId`,
          null,
        ),
        attachments: emptyArray(input.attachments, `${path}.attachments`),
      };
    }
  }
}

function canonical(value: unknown, path: string): CanonicalValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail(path, "cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail(path, "cannot contain symbol properties");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: CanonicalValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail(`${path}[${index}]`, "must be an enumerable data property");
      }
      result.push(canonical(descriptor.value, `${path}[${index}]`));
    }
    const unknownKeys = Object.keys(descriptors).filter(
      (key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key),
    );
    if (unknownKeys.length > 0) {
      fail(path, `cannot contain array properties: ${unknownKeys.join(", ")}`);
    }
    return result;
  }
  const source = record(value, path);
  const result: { [key: string]: CanonicalValue } = {};
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key}`, "must be an enumerable data property");
    }
    const entry = descriptor.value;
    if (entry === undefined) fail(`${path}.${key}`, "cannot be undefined");
    result[key] = canonical(entry, `${path}.${key}`);
  }
  return result;
}

function hash(
  kind: ProviderOperationKind,
  role: "target" | "input",
  value: unknown,
): string {
  const envelope = canonical(
    { domain: `provider-operation-${role}:${kind}:v1`, value },
    `${role}HashEnvelope`,
  );
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Validate and normalize private raw operation material against its closed provider schema. */
export function validateProviderOperationRawBinding(
  value: unknown,
): ProviderOperationRawBinding {
  const snapshot = canonical(value, "raw");
  const raw = exactRecord(snapshot, "raw", [
    "kind",
    "providerTarget",
    "operationInput",
  ]);
  const kind = string(raw.kind, "raw.kind");
  if (!PROVIDER_OPERATION_KIND_SET.has(kind))
    fail("raw.kind", "is unsupported");
  const typedKind = kind as ProviderOperationKind;
  const providerTarget = targetFor(typedKind, raw.providerTarget);
  const operationInput = inputFor(typedKind, raw.operationInput);
  if (typedKind === "duffel.booking-hold-create") {
    const target =
      providerTarget as ProviderOperationTargetByKind["duffel.booking-hold-create"];
    const input =
      operationInput as ProviderOperationInputByKind["duffel.booking-hold-create"];
    if (target.itinerary.origin === target.itinerary.destination) {
      fail(
        "raw.providerTarget.itinerary.destination",
        "must differ from origin",
      );
    }
    if (target.itinerary.passengerCount !== input.passengers.length) {
      fail(
        "raw.providerTarget.itinerary.passengerCount",
        "must equal operationInput.passengers length",
      );
    }
    const passengerIds = input.passengers.map(
      (passenger) => passenger.offerPassengerId,
    );
    if (new Set(passengerIds).size !== passengerIds.length) {
      fail(
        "raw.operationInput.passengers",
        "must bind unique offerPassengerId values",
      );
    }
  }
  return deepFreeze({
    kind: typedKind,
    providerTarget,
    operationInput,
  } as ProviderOperationRawBinding);
}

/** Create the hash-only binding safe to copy into a signed provider manifest. */
export function createProviderOperationBinding(
  value: unknown,
): ProviderOperationBinding {
  const raw = validateProviderOperationRawBinding(value);
  return deepFreeze({
    schema: PROVIDER_OPERATION_BINDING_SCHEMA,
    kind: raw.kind,
    providerTargetRefSha256: hash(raw.kind, "target", raw.providerTarget),
    operationInputSha256: hash(raw.kind, "input", raw.operationInput),
  });
}

/** Validate a hash-only operation binding received across a process boundary. */
export function validateProviderOperationBinding(
  value: unknown,
): ProviderOperationBinding {
  const binding = exactRecord(value, "binding", [
    "schema",
    "kind",
    "providerTargetRefSha256",
    "operationInputSha256",
  ]);
  if (binding.schema !== PROVIDER_OPERATION_BINDING_SCHEMA) {
    fail("binding.schema", "is unsupported");
  }
  const kind = string(binding.kind, "binding.kind");
  if (!PROVIDER_OPERATION_KIND_SET.has(kind))
    fail("binding.kind", "is unsupported");
  return deepFreeze({
    schema: PROVIDER_OPERATION_BINDING_SCHEMA,
    kind: kind as ProviderOperationKind,
    providerTargetRefSha256: stringMatching(
      binding.providerTargetRefSha256,
      "binding.providerTargetRefSha256",
      SHA256_PATTERN,
      "a lowercase SHA-256 digest",
    ),
    operationInputSha256: stringMatching(
      binding.operationInputSha256,
      "binding.operationInputSha256",
      SHA256_PATTERN,
      "a lowercase SHA-256 digest",
    ),
  });
}
