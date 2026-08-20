/**
 * Exercises every production provider operation schema with deterministic raw
 * fixtures and adversarial boundary mutations. The harness is local and does
 * not contact providers; it proves only validation and hash binding behavior.
 */

import { describe, expect, it } from "vitest";
import {
  createProviderOperationBinding,
  PROVIDER_OPERATION_BINDING_SCHEMA,
  PROVIDER_OPERATION_CONTRACT_BY_KIND,
  PROVIDER_OPERATION_KINDS,
  validateProviderOperationBinding,
  validateProviderOperationRawBinding,
} from "./operation-binding.ts";

const fixtures: readonly unknown[] = [
  {
    kind: "bluebubbles.message-send",
    providerTarget: { chatGuid: "iMessage;+;chat-guid" },
    operationInput: { text: "canary", replyToMessageGuid: null },
  },
  {
    kind: "discord.message-send",
    providerTarget: {
      guildId: "123456789012345678",
      channelId: "234567890123456789",
    },
    operationInput: { text: "canary", attachments: [] },
  },
  {
    kind: "duffel.booking-hold-create",
    providerTarget: {
      offerId: "off_canary",
      itinerary: {
        origin: "LAX",
        destination: "JFK",
        departureDate: "2027-01-10",
        returnDate: null,
        passengerCount: 1,
      },
    },
    operationInput: {
      orderType: "hold",
      totalCents: 29950,
      currency: "USD",
      passengers: [
        {
          offerPassengerId: "pas_canary",
          givenName: "Canary",
          familyName: "Operator",
          bornOn: "1990-05-20",
          email: "canary@example.com",
          phoneNumber: "+14155552671",
          title: "mr",
          gender: "m",
        },
      ],
      calendarSync: {
        enabled: false,
        calendarId: null,
        title: null,
        description: null,
        location: null,
        timeZone: null,
      },
    },
  },
  {
    kind: "gmail.email-send",
    providerTarget: { recipientEmail: "canary@example.com" },
    operationInput: { subject: "canary", bodyText: "canary", cc: [], bcc: [] },
  },
  {
    kind: "google-calendar.event-create",
    providerTarget: { calendarId: "canary@example.com" },
    operationInput: {
      title: "canary",
      start: "2027-01-10T09:00:00-08:00",
      end: "2027-01-10T09:15:00-08:00",
      timeZone: "America/Los_Angeles",
      attendees: [],
      location: null,
      description: null,
      createMeetLink: false,
      sendUpdates: "none",
      recurrence: [],
      idempotencyKey: "calendar-canary-1",
    },
  },
  {
    kind: "google-sheets.spreadsheet-create",
    providerTarget: { parentFolderId: "folder-canary" },
    operationInput: {
      name: "canary",
      mimeType: "application/vnd.google-apps.spreadsheet",
      content: null,
    },
  },
  {
    kind: "signal.message-send",
    providerTarget: { recipientKind: "direct", channelId: "+14155552671" },
    operationInput: { text: "canary" },
  },
  {
    kind: "slack.message-send",
    providerTarget: { teamId: "T123ABC", channelId: "C123ABC", threadTs: null },
    operationInput: { text: "canary", attachments: [] },
  },
  {
    kind: "telegram.message-send",
    providerTarget: { chatId: "123456789", threadId: null },
    operationInput: { text: "canary" },
  },
  {
    kind: "twilio.sms-send",
    providerTarget: { fromE164: "+14155552671", toE164: "+14155552672" },
    operationInput: { body: "canary", idempotencyKey: "sms-canary-1" },
  },
  {
    kind: "twilio.call-create",
    providerTarget: { fromE164: "+14155552671", toE164: "+14155552672" },
    operationInput: { message: "canary", idempotencyKey: "call-canary-1" },
  },
  {
    kind: "whatsapp.message-send",
    providerTarget: { transport: "cloud-api", chatId: "+14155552671" },
    operationInput: { text: "canary", replyToMessageId: null, attachments: [] },
  },
  {
    kind: "x.direct-message-send",
    providerTarget: { participantId: "123456789012345678" },
    operationInput: { text: "canary" },
  },
];

function mutableCopy<T>(value: T): T {
  return structuredClone(value);
}

describe("provider operation binding", () => {
  it("defines exactly one canonical contract for every production operation", () => {
    const keys = Object.keys(PROVIDER_OPERATION_CONTRACT_BY_KIND);
    expect(keys).toEqual(PROVIDER_OPERATION_KINDS);
    expect(new Set(keys).size).toBe(13);
    expect(Object.values(PROVIDER_OPERATION_CONTRACT_BY_KIND)).toHaveLength(13);
  });

  it("covers and hashes every production canary operation", () => {
    const bindings = fixtures.map(createProviderOperationBinding);
    expect(bindings.map((binding) => binding.kind)).toEqual(
      PROVIDER_OPERATION_KINDS,
    );
    expect(
      new Set(bindings.map((binding) => binding.providerTargetRefSha256)).size,
    ).toBe(13);
    for (const binding of bindings) {
      expect(binding).toEqual({
        schema: PROVIDER_OPERATION_BINDING_SCHEMA,
        kind: binding.kind,
        providerTargetRefSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        operationInputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(Object.isFrozen(binding)).toBe(true);
      expect(validateProviderOperationBinding(binding)).toEqual(binding);
    }
  });

  it("normalizes whitespace before hashing and never returns raw material in the manifest binding", () => {
    const fixture = fixtures[0];
    const padded = mutableCopy(fixture) as {
      providerTarget: { chatGuid: string };
      operationInput: { text: string };
    };
    padded.providerTarget.chatGuid = `  ${padded.providerTarget.chatGuid}  `;
    padded.operationInput.text = `  ${padded.operationInput.text}  `;
    const canonical = createProviderOperationBinding(fixture);
    const normalized = createProviderOperationBinding(padded);
    expect(normalized).toEqual(canonical);
    expect(JSON.stringify(normalized)).not.toContain("chat-guid");
    expect(JSON.stringify(normalized)).not.toContain("canary");
  });

  it("domain-separates target and input hashes", () => {
    const fixture = {
      kind: "x.direct-message-send",
      providerTarget: { participantId: "123456789" },
      operationInput: { text: "123456789" },
    };
    const binding = createProviderOperationBinding(fixture);
    expect(binding.providerTargetRefSha256).not.toBe(
      binding.operationInputSha256,
    );
  });

  it("rejects extra and missing keys at every public boundary", () => {
    const raw = mutableCopy(fixtures[3]) as Record<string, unknown>;
    raw.untrusted = true;
    expect(() => validateProviderOperationRawBinding(raw)).toThrow(
      /must contain exactly/,
    );

    const nested = mutableCopy(fixtures[3]) as {
      providerTarget: Record<string, unknown>;
    };
    nested.providerTarget.untrusted = true;
    expect(() => validateProviderOperationRawBinding(nested)).toThrow(
      /must contain exactly/,
    );

    const binding = createProviderOperationBinding(
      fixtures[3],
    ) as unknown as Record<string, unknown>;
    const missing = { ...binding };
    delete missing.operationInputSha256;
    expect(() => validateProviderOperationBinding(missing)).toThrow(
      /must contain exactly/,
    );
  });

  it("rejects accessors and hidden properties without invoking them", () => {
    let getterCalls = 0;
    const accessorBacked = mutableCopy(fixtures[3]) as Record<string, unknown>;
    Object.defineProperty(accessorBacked, "providerTarget", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { recipientEmail: "operator@example.test" };
      },
    });
    expect(() => createProviderOperationBinding(accessorBacked)).toThrow(
      /enumerable data property/,
    );
    expect(getterCalls).toBe(0);

    const hidden = mutableCopy(fixtures[3]) as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: "must not be ignored",
    });
    expect(() => createProviderOperationBinding(hidden)).toThrow(
      /enumerable data property/,
    );

    const arrayProperty = mutableCopy(fixtures[2]) as {
      operationInput: { passengers: unknown[] };
    };
    Object.defineProperty(arrayProperty.operationInput.passengers, "hidden", {
      enumerable: true,
      value: "must not be ignored",
    });
    expect(() => createProviderOperationBinding(arrayProperty)).toThrow(
      /cannot contain array properties/,
    );
  });

  it.each([
    ["signal E.164", 6, ["providerTarget", "channelId"], "4155552671"],
    ["Telegram private chat", 8, ["providerTarget", "chatId"], "-100123"],
    [
      "X numeric participant",
      12,
      ["providerTarget", "participantId"],
      "@canary",
    ],
    [
      "Discord snowflake",
      1,
      ["providerTarget", "channelId"],
      "not-a-snowflake",
    ],
    ["Duffel IATA", 2, ["providerTarget", "itinerary", "origin"], "lax"],
  ])(
    "rejects malformed %s identifiers",
    (_label, fixtureIndex, path, replacement) => {
      const candidate = mutableCopy(fixtures[fixtureIndex]) as Record<
        string,
        unknown
      >;
      let cursor = candidate;
      for (const segment of path.slice(0, -1)) {
        cursor = cursor[segment] as Record<string, unknown>;
      }
      cursor[path.at(-1) as string] = replacement;
      expect(() => createProviderOperationBinding(candidate)).toThrow();
    },
  );

  it("enforces bot-compatible Telegram and transport-specific WhatsApp targets", () => {
    const telegram = mutableCopy(fixtures[8]) as {
      providerTarget: { chatId: string };
    };
    telegram.providerTarget.chatId = "@canary_bot";
    expect(() => createProviderOperationBinding(telegram)).toThrow(
      /positive numeric private-chat ID/,
    );

    const whatsapp = mutableCopy(fixtures[11]) as {
      providerTarget: { transport: string; chatId: string };
    };
    whatsapp.providerTarget.chatId = "123456@g.us";
    expect(() => createProviderOperationBinding(whatsapp)).toThrow(/E\.164/);
    whatsapp.providerTarget.transport = "baileys";
    expect(createProviderOperationBinding(whatsapp).kind).toBe(
      "whatsapp.message-send",
    );
  });

  it("rejects nondeterministic or instant Duffel inputs", () => {
    const instant = mutableCopy(fixtures[2]) as {
      operationInput: { orderType: string };
    };
    instant.operationInput.orderType = "instant";
    expect(() => createProviderOperationBinding(instant)).toThrow(
      /must equal "hold"/,
    );

    const emptyPassengers = mutableCopy(fixtures[2]) as {
      operationInput: { passengers: unknown[] };
    };
    emptyPassengers.operationInput.passengers = [];
    expect(() => createProviderOperationBinding(emptyPassengers)).toThrow(
      /non-empty array/,
    );

    const countMismatch = mutableCopy(fixtures[2]) as {
      providerTarget: { itinerary: { passengerCount: number } };
    };
    countMismatch.providerTarget.itinerary.passengerCount = 2;
    expect(() => createProviderOperationBinding(countMismatch)).toThrow(
      /must equal operationInput\.passengers length/,
    );
  });

  it("treats passenger order and any operation mutation as binding-significant", () => {
    const twoPassengers = mutableCopy(fixtures[2]) as {
      providerTarget: { itinerary: { passengerCount: number } };
      operationInput: { passengers: Array<Record<string, unknown>> };
    };
    const second = mutableCopy(twoPassengers.operationInput.passengers[0]);
    second.offerPassengerId = "pas_second";
    second.givenName = "Second";
    twoPassengers.operationInput.passengers.push(second);
    twoPassengers.providerTarget.itinerary.passengerCount = 2;
    const forward = createProviderOperationBinding(twoPassengers);
    twoPassengers.operationInput.passengers.reverse();
    const reverse = createProviderOperationBinding(twoPassengers);
    expect(reverse.operationInputSha256).not.toBe(forward.operationInputSha256);
  });
});
