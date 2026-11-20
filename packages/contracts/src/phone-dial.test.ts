import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePhoneNumber } from "./native-telephony.ts";
import {
  CONTACT_LOOKUP_CAPABILITY,
  contactLookupMatches,
  PHONE_DIAL_CAPABILITY,
  phoneDialCapabilityAvailable,
  phoneDialNumber,
  phoneDialReceiptOutcome,
  phoneDialResultText,
  telephonyDeviceCapabilities,
  validateContactLookupQuery,
  validatePhoneDial,
  validatePhoneDialResult,
} from "./phone-dial.ts";

const byNumber = validatePhoneDial({
  type: "phone_dial",
  target: { kind: "number", number: "+15555550100" },
});
const byContact = validatePhoneDial({
  type: "phone_dial",
  target: { kind: "contact", query: "Ada Lovelace" },
});

test("a written number becomes the exact dial form or is rejected with the format", () => {
  for (const [written, exact] of [
    ["555-0100", "5550100"],
    ["+1 (415) 555-0100", "+14155550100"],
    // A trunk "(0)" after the country code is not dialed with it.
    ["+44 (0)20 7946 0958", "+442079460958"],
    ["+49(0)30 1234567", "+49301234567"],
    ["+41 (0) 44 668 18 00", "+41446681800"],
    // Italy, San Marino and Côte d'Ivoire dial the 0 with the country code.
    ["+39 (0)55 123 4567", "+390551234567"],
    ["+39 (0)6 1234 5678", "+390612345678"],
    ["+378 (0)549 882 123", "+3780549882123"],
    ["+225 (0)7 07 12 34 56", "+2250707123456"],
    ["415.555.0100", "4155550100"],
    ["+15555550100", "+15555550100"],
    ["+1 415 555-0100", "+14155550100"],
    ["(415)555-0100", "4155550100"],
    [" 01.23.45.67.89 ", "0123456789"],
  ])
    assert.equal(phoneDialNumber(written), exact);
  for (const bad of [
    "1-800-FLOWERS",
    "*#06#",
    "5",
    "",
    "++1555",
    "+44 (0)",
    // More than one number, a range, a date or an address is not one number.
    "555-0100 555-0199",
    "5550100\n5550101",
    "+1 415 555 0100 - 0105",
    "415 555 0100 415 555 0199",
    "(415) (555) 0100",
    "555--0100",
    "2026-11-17",
    "192.168.1.1",
    "1.5",
    5550100,
    null,
  ])
    assert.throws(
      () => phoneDialNumber(bad),
      /digits with an optional leading \+/,
    );
});

test("a dial operation is exact and closed", () => {
  assert.deepEqual(byNumber.target, { kind: "number", number: "+15555550100" });
  assert.deepEqual(byContact.target, {
    kind: "contact",
    query: "Ada Lovelace",
  });
  for (const bad of [
    { type: "phone_dial", target: { kind: "number", number: "*#06#" } },
    {
      type: "phone_dial",
      target: { kind: "number", number: "+1 555 555 0100" },
    },
    { type: "phone_dial", target: { kind: "number", number: "5", extra: 1 } },
    { type: "phone_dial", target: { kind: "contact", query: "" } },
    { type: "phone_dial", target: { kind: "contact", query: " Ada" } },
    { type: "phone_dial", target: { kind: "contact", query: "A\u202eda" } },
    { type: "phone_dial", target: { kind: "contact", query: "x".repeat(129) } },
    { type: "phone_dial", target: { kind: "voicemail" } },
    {
      type: "phone_dial",
      target: { kind: "number", number: "+15555550100" },
      place: true,
    },
    { type: "phone_call", target: { kind: "number", number: "+15555550100" } },
  ])
    assert.throws(() => validatePhoneDial(bad), /Invalid|Unexpected/);
  assert.throws(() => validateContactLookupQuery(7), /Invalid/);
});

test("capabilities are advertised only with the native telephony profile", () => {
  assert.deepEqual(
    telephonyDeviceCapabilities({
      present: false,
      dial: true,
      contactLookup: true,
    }),
    [],
  );
  assert.deepEqual(
    telephonyDeviceCapabilities({
      present: true,
      dial: false,
      contactLookup: true,
    }),
    [],
  );
  assert.deepEqual(
    telephonyDeviceCapabilities({
      present: true,
      dial: true,
      contactLookup: false,
    }),
    [PHONE_DIAL_CAPABILITY],
  );
  assert.deepEqual(
    telephonyDeviceCapabilities({
      present: true,
      dial: true,
      contactLookup: true,
    }),
    [PHONE_DIAL_CAPABILITY, CONTACT_LOOKUP_CAPABILITY],
  );
  assert.equal(
    phoneDialCapabilityAvailable(byNumber, [PHONE_DIAL_CAPABILITY]),
    true,
  );
  assert.equal(
    phoneDialCapabilityAvailable(byContact, [PHONE_DIAL_CAPABILITY]),
    false,
  );
  assert.equal(
    phoneDialCapabilityAvailable(byContact, [
      PHONE_DIAL_CAPABILITY,
      CONTACT_LOOKUP_CAPABILITY,
    ]),
    true,
  );
  assert.equal(
    phoneDialCapabilityAvailable(byNumber, [CONTACT_LOOKUP_CAPABILITY]),
    false,
  );
  assert.equal(phoneDialCapabilityAvailable(byNumber, undefined), false);
});

test("a dial result names a handoff and never a placed call", () => {
  const opened = validatePhoneDialResult(byNumber, {
    kind: "phone-dial",
    status: "handed-off",
    handler: "com.android.dialer",
    contact: false,
  });
  assert.equal(phoneDialReceiptOutcome(opened), "applied");
  assert.match(
    phoneDialResultText(opened),
    /does not show whether a call was placed/,
  );
  const cancelled = validatePhoneDialResult(byContact, {
    kind: "phone-dial",
    status: "cancelled",
    handler: null,
    contact: true,
  });
  assert.equal(phoneDialReceiptOutcome(cancelled), "failed");
  assert.match(phoneDialResultText(cancelled), /Nothing was dialed/);
  for (const bad of [
    { kind: "phone-dial", status: "placed", handler: null, contact: false },
    { kind: "phone-dial", status: "connected", handler: null, contact: false },
    {
      kind: "phone-dial",
      status: "handed-off",
      handler: null,
      contact: false,
      durationSeconds: 3,
    },
    {
      kind: "phone-dial",
      status: "cancelled",
      handler: "com.android.dialer",
      contact: false,
    },
    { kind: "phone-dial", status: "handed-off", handler: "", contact: false },
    { kind: "sms-send", status: "handed-off", handler: null, contact: false },
  ])
    assert.throws(
      () => validatePhoneDialResult(byNumber, bad),
      /Invalid|Unexpected|handler/,
    );
  assert.throws(
    () =>
      validatePhoneDialResult(byNumber, {
        kind: "phone-dial",
        status: "handed-off",
        handler: null,
        contact: true,
      }),
    /contact choice/,
  );
});

test("contact lookup keeps only bounded dialable numbers", () => {
  const rows = [
    {
      id: "1",
      displayName: "Ada",
      phoneNumbers: ["+1 (555) 555-0100", "+15555550100", "*#06#"],
    },
    { id: "2", displayName: "No phone", phoneNumbers: [] },
    { id: "3", displayName: " ", phoneNumbers: ["555-0101"] },
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`,
      displayName: `P${i}`,
      phoneNumbers: [`+1555555${String(i).padStart(4, "0")}`],
    })),
  ];
  const matches = contactLookupMatches(rows, normalizePhoneNumber);
  assert.equal(matches.length, 10);
  assert.deepEqual(matches[0], {
    id: "1",
    displayName: "Ada",
    phoneNumbers: ["+15555550100"],
  });
  assert.deepEqual(matches[1], {
    id: "3",
    displayName: "Unnamed contact",
    phoneNumbers: ["5550101"],
  });
  assert.equal(contactLookupMatches(rows, normalizePhoneNumber, 1).length, 1);
  assert.throws(
    () => contactLookupMatches(rows, normalizePhoneNumber, 11),
    RangeError,
  );
});
