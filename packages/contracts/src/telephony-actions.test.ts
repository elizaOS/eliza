import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_WRITE_CAPABILITY,
  contactWriteReceiptOutcome,
  contactWriteResultText,
  isTelephonyAction,
  MESSAGES_READ_CAPABILITY,
  MESSAGES_READ_MAX,
  PHONE_CALL_CAPABILITY,
  phoneCallReceiptOutcome,
  phoneCallResultText,
  SMS_COMPOSE_CAPABILITY,
  smsComposeReceiptOutcome,
  smsComposeResultText,
  smsReplyReceiptOutcome,
  smsReplyResultText,
  TELEPHONY_ACTION_OPERATION_TYPES,
  telephonyActionCapabilities,
  telephonyActionCapability,
  VOICEMAIL_DELETE_CAPABILITY,
  VOICEMAIL_READ_CAPABILITY,
  validateContactWrite,
  validateContactWriteResult,
  validateMessagesRead,
  validateMessagesReadResult,
  validatePhoneCall,
  validatePhoneCallResult,
  validateSmsCompose,
  validateSmsComposeResult,
  validateSmsReply,
  validateSmsReplyResult,
  validateTelephonyAction,
  validateVoicemailDelete,
  validateVoicemailDeleteResult,
  validateVoicemailRead,
  validateVoicemailReadResult,
  voicemailDeleteResultText,
} from "./telephony-actions.ts";

const REJECTED = /Invalid|Unexpected|cannot|Only/;
const callNumber = validatePhoneCall({
  type: "phone_call",
  target: { kind: "number", number: "+15555550123" },
});
const callContact = validatePhoneCall({
  type: "phone_call",
  target: { kind: "contact", query: "Ada Lovelace" },
});
const contact = {
  displayName: "Ada Lovelace",
  phoneNumbers: ["+15555550123"],
  emailAddresses: ["ada@example.com"],
};
const create = validateContactWrite({ type: "contact_create", contact });
const update = validateContactWrite({
  type: "contact_update",
  query: "Ada",
  set: { phoneNumbers: [] },
});
const remove = validateContactWrite({ type: "contact_delete", query: "Ada" });

test("a call names an exact number or a contact search and nothing else", () => {
  assert.deepEqual(callNumber.target, {
    kind: "number",
    number: "+15555550123",
  });
  assert.deepEqual(callContact.target, {
    kind: "contact",
    query: "Ada Lovelace",
  });
  for (const bad of [
    { type: "phone_call" },
    { type: "phone_dial", target: { kind: "number", number: "5551234" } },
    { type: "phone_call", target: { kind: "number", number: "*#06#" } },
    { type: "phone_call", target: { kind: "number", number: "5" } },
    { type: "phone_call", target: { kind: "number", number: "55", x: 1 } },
    { type: "phone_call", target: { kind: "contact", query: "" } },
    { type: "phone_call", target: { kind: "contact", query: " Ada" } },
    { type: "phone_call", target: { kind: "contact", query: "A‮da" } },
    { type: "phone_call", target: { kind: "voicemail" } },
    {
      type: "phone_call",
      target: { kind: "number", number: "5551234" },
      speaker: true,
    },
    null,
    [],
  ])
    assert.throws(() => validatePhoneCall(bad), REJECTED);
});

test("a call result never claims a connected call or a contact a number call had", () => {
  const placed = validatePhoneCallResult(callNumber, {
    kind: "phone-call",
    status: "placed",
    contact: false,
  });
  assert.equal(phoneCallReceiptOutcome(placed), "applied");
  assert.match(phoneCallResultText(placed), /does not show whether/);
  const emergency = validatePhoneCallResult(callNumber, {
    kind: "phone-call",
    status: "emergency-handoff",
    contact: false,
  });
  assert.equal(phoneCallReceiptOutcome(emergency), "applied");
  assert.match(phoneCallResultText(emergency), /owner places that call/);
  for (const status of [
    "not-found",
    "busy",
    "unavailable",
    "cancelled",
    "failed",
  ] as const) {
    const result = validatePhoneCallResult(callContact, {
      kind: "phone-call",
      status,
      contact: false,
    });
    assert.equal(phoneCallReceiptOutcome(result), "failed");
    assert.match(phoneCallResultText(result), /Nothing was called/);
  }
  assert.equal(
    validatePhoneCallResult(callContact, {
      kind: "phone-call",
      status: "placed",
      contact: true,
    }).contact,
    true,
  );
  // A number call resolved no contact, so it can report neither.
  for (const bad of [
    { kind: "phone-call", status: "placed", contact: true },
    { kind: "phone-call", status: "not-found", contact: false },
  ])
    assert.throws(() => validatePhoneCallResult(callNumber, bad), REJECTED);
  for (const bad of [
    { kind: "phone-call", status: "connected", contact: false },
    { kind: "phone-call", status: "answered", contact: false },
    { kind: "phone-call", status: "handed-off", contact: false },
    { kind: "phone-dial", status: "placed", contact: false },
    { kind: "phone-call", status: "placed" },
    { kind: "phone-call", status: "placed", contact: "yes" },
    { kind: "phone-call", status: "placed", contact: false, number: "+1555" },
    { kind: "phone-call", status: "placed", contact: false, duration: 3 },
  ])
    assert.throws(() => validatePhoneCallResult(callContact, bad), REJECTED);
});

test("a contact change is exact and closed", () => {
  assert.deepEqual(create, { type: "contact_create", contact });
  assert.deepEqual(update, {
    type: "contact_update",
    query: "Ada",
    set: { phoneNumbers: [] },
  });
  assert.deepEqual(remove, { type: "contact_delete", query: "Ada" });
  assert.deepEqual(
    validateContactWrite({
      type: "contact_update",
      query: "Ada",
      set: { displayName: "Ada King", emailAddresses: ["a@b.co"] },
    }),
    {
      type: "contact_update",
      query: "Ada",
      set: { displayName: "Ada King", emailAddresses: ["a@b.co"] },
    },
  );
  for (const bad of [
    { type: "contact_create" },
    { type: "contact_create", contact: { displayName: "Ada" } },
    { type: "contact_create", contact: { ...contact, id: "7" } },
    { type: "contact_create", contact: { ...contact, displayName: "" } },
    { type: "contact_create", contact: { ...contact, displayName: " Ada" } },
    {
      type: "contact_create",
      contact: { ...contact, displayName: "x".repeat(129) },
    },
    {
      type: "contact_create",
      contact: { ...contact, displayName: "A\u0000da" },
    },
    {
      type: "contact_create",
      contact: { ...contact, phoneNumbers: ["555-1234"] },
    },
    {
      type: "contact_create",
      contact: { ...contact, phoneNumbers: ["5551234", "5551234"] },
    },
    {
      type: "contact_create",
      contact: {
        ...contact,
        phoneNumbers: Array.from({ length: 9 }, (_, i) => `555123${i}`),
      },
    },
    {
      type: "contact_create",
      contact: { ...contact, emailAddresses: ["not-an-email"] },
    },
    { type: "contact_create", contact, query: "Ada" },
    { type: "contact_update", query: "Ada", set: {} },
    { type: "contact_update", query: "Ada", set: { id: "7" } },
    { type: "contact_update", query: "Ada", set: { phoneNumbers: "5551234" } },
    { type: "contact_update", query: "", set: { displayName: "Ada" } },
    { type: "contact_update", set: { displayName: "Ada" } },
    { type: "contact_update", query: "Ada", set: [] },
    { type: "contact_delete", query: "Ada", contactId: "7" },
    { type: "contact_delete", query: " Ada " },
    { type: "contact_delete" },
    { type: "contact_merge", query: "Ada" },
  ])
    assert.throws(() => validateContactWrite(bad), REJECTED);
});

test("a contact result fits the change that was reviewed", () => {
  const result = (status: string) => ({ kind: "contact-write", status });
  const saved = validateContactWriteResult(create, result("saved"));
  assert.equal(contactWriteReceiptOutcome(saved), "applied");
  assert.match(contactWriteResultText(saved), /was saved/);
  assert.equal(
    validateContactWriteResult(update, result("saved")).status,
    "saved",
  );
  for (const operation of [create, update, remove]) {
    const unknown = validateContactWriteResult(operation, result("unknown"));
    assert.equal(contactWriteReceiptOutcome(unknown), "unknown");
    assert.match(contactWriteResultText(unknown), /could not confirm/);
    assert.doesNotMatch(contactWriteResultText(unknown), /Nothing was changed/);
  }
  const deleted = validateContactWriteResult(remove, result("deleted"));
  assert.equal(contactWriteReceiptOutcome(deleted), "applied");
  for (const status of ["not-found", "stale"]) {
    for (const operation of [update, remove]) {
      const failed = validateContactWriteResult(operation, result(status));
      assert.equal(contactWriteReceiptOutcome(failed), "failed");
      assert.match(contactWriteResultText(failed), /Nothing was changed/);
    }
    // A new contact has no earlier row to be missing or changed.
    assert.throws(
      () => validateContactWriteResult(create, result(status)),
      REJECTED,
    );
  }
  for (const status of ["unavailable", "cancelled", "failed"])
    for (const operation of [create, update, remove])
      assert.equal(
        contactWriteReceiptOutcome(
          validateContactWriteResult(operation, result(status)),
        ),
        "failed",
      );
  // Only a delete reports a deleted contact, and it never reports a saved one.
  assert.throws(
    () => validateContactWriteResult(create, result("deleted")),
    REJECTED,
  );
  assert.throws(
    () => validateContactWriteResult(update, result("deleted")),
    REJECTED,
  );
  assert.throws(
    () => validateContactWriteResult(remove, result("saved")),
    REJECTED,
  );
  for (const bad of [
    result("created"),
    { kind: "contact", status: "saved" },
    { kind: "contact-write", status: "saved", contact },
    { kind: "contact-write" },
    null,
  ])
    assert.throws(() => validateContactWriteResult(update, bad), REJECTED);
});

test("a contact SMS names a contact by text and keeps an unknown outcome unknown", () => {
  const compose = validateSmsCompose({
    type: "sms_compose",
    query: "Ada",
    body: "Running late.\nSee you at 5.",
  });
  assert.deepEqual(compose, {
    type: "sms_compose",
    query: "Ada",
    body: "Running late.\nSee you at 5.",
  });
  for (const bad of [
    { type: "sms_compose", query: "Ada" },
    { type: "sms_compose", query: "Ada", body: "" },
    { type: "sms_compose", query: "Ada", body: "   " },
    { type: "sms_compose", query: "Ada", body: "x".repeat(1601) },
    { type: "sms_compose", query: "Ada", body: "hi\u0007" },
    { type: "sms_compose", query: "Ada", body: "hi‮" },
    { type: "sms_compose", query: "", body: "hi" },
    { type: "sms_compose", query: "Ada", body: "hi", subscriptionId: 1 },
    { type: "sms_compose", query: "Ada", body: "hi", recipients: ["+1555"] },
    { type: "sms_send", query: "Ada", body: "hi" },
  ])
    assert.throws(() => validateSmsCompose(bad), REJECTED);
  const result = (status: string) =>
    validateSmsComposeResult({ kind: "sms-compose", status });
  for (const status of ["drafted", "submitted", "sent", "delivered"])
    assert.equal(smsComposeReceiptOutcome(result(status)), "applied");
  assert.equal(
    smsComposeResultText(result("drafted")),
    "The message is in that conversation's text field for the owner to edit and send. Nothing was sent.",
  );
  assert.equal(smsComposeReceiptOutcome(result("unknown")), "unknown");
  assert.match(smsComposeResultText(result("unknown")), /not sent again/);
  for (const status of ["not-found", "unavailable", "cancelled", "failed"])
    assert.equal(smsComposeReceiptOutcome(result(status)), "failed");
  assert.match(smsComposeResultText(result("submitted")), /not yet confirmed/);
  for (const bad of [
    { kind: "sms-compose", status: "queued" },
    { kind: "sms-send", status: "sent" },
    { kind: "sms-compose", status: "sent", recipient: "+15555550123" },
    { kind: "sms-compose" },
  ])
    assert.throws(() => validateSmsComposeResult(bad), REJECTED);
});

test("a reply draft names no recipient and is placed or not, never sent", () => {
  const reply = {
    type: "sms_reply_selected",
    body: "On my way.\nTen minutes.",
  };
  assert.deepEqual(validateSmsReply(reply), reply);
  for (const bad of [
    { type: "sms_reply_selected" },
    { type: "sms_reply_selected", body: "" },
    { type: "sms_reply_selected", body: "   " },
    { type: "sms_reply_selected", body: 5 },
    { type: "sms_reply_selected", body: "x".repeat(1601) },
    { type: "sms_reply_selected", body: "hi\u0007" },
    { type: "sms_reply_selected", body: "hi\u202e" },
    { type: "sms_reply_selected", body: "hi", query: "Ada" },
    { type: "sms_reply_selected", body: "hi", threadId: "4" },
    { type: "sms_reply_selected", body: "hi", recipients: ["+1555"] },
    { type: "sms_reply_selected", body: "hi", send: true },
    { type: "sms_compose", body: "hi" },
    null,
  ])
    assert.throws(() => validateSmsReply(bad), REJECTED);
  const result = (status: string) =>
    validateSmsReplyResult({ kind: "sms-reply", status });
  assert.equal(smsReplyReceiptOutcome(result("drafted")), "applied");
  for (const status of ["none-selected", "occupied", "unavailable"])
    assert.equal(smsReplyReceiptOutcome(result(status)), "failed");
  assert.deepEqual(
    ["drafted", "none-selected", "occupied", "unavailable"].map((status) =>
      smsReplyResultText(result(status)),
    ),
    [
      "The draft is in the open conversation's text field for the owner to edit and send. Nothing was sent.",
      "The owner has no conversation open. Nothing was drafted.",
      "The owner is writing their own message in that conversation. Nothing was changed.",
      "This phone cannot draft messages right now. Nothing was drafted.",
    ],
  );
  for (const bad of [
    { kind: "sms-reply", status: "sent" },
    { kind: "sms-reply", status: "submitted" },
    { kind: "sms-reply", status: "unknown" },
    { kind: "sms-reply", status: "cancelled" },
    { kind: "sms-compose", status: "drafted" },
    { kind: "sms-reply", status: "drafted", body: "hi" },
    { kind: "sms-reply" },
    null,
  ])
    assert.throws(() => validateSmsReplyResult(bad), REJECTED);
});

test("an open-thread read is a bounded, date-ordered tail with no numbers", () => {
  assert.deepEqual(validateMessagesRead({ type: "messages_read_selected" }), {
    type: "messages_read_selected",
  });
  for (const bad of [
    { type: "messages_read_selected", threadId: "4" },
    { type: "messages_read_selected", limit: 100 },
    { type: "messages_read_all" },
  ])
    assert.throws(() => validateMessagesRead(bad), REJECTED);
  const read = {
    kind: "messages-read",
    status: "read",
    participant: "Ada Lovelace",
    messages: [
      { direction: "in", date: 1000, body: "Lunch?" },
      { direction: "out", date: 1000, body: "Yes.\nNoon" },
      { direction: "in", date: 2000, body: "" },
    ],
    truncated: true,
  };
  assert.deepEqual(validateMessagesReadResult(read), read);
  assert.deepEqual(
    validateMessagesReadResult({ ...read, participant: null, messages: [] }),
    { ...read, participant: null, messages: [] },
  );
  const message = (date: number) => ({ direction: "in", date, body: "x" });
  assert.equal(
    validateMessagesReadResult({
      ...read,
      messages: Array.from({ length: MESSAGES_READ_MAX }, (_, i) => message(i)),
    }).status,
    "read",
  );
  for (const status of ["none-selected", "unavailable"])
    assert.deepEqual(
      validateMessagesReadResult({ kind: "messages-read", status }),
      { kind: "messages-read", status },
    );
  for (const bad of [
    // More than the bounded tail.
    {
      ...read,
      messages: Array.from({ length: MESSAGES_READ_MAX + 1 }, (_, i) =>
        message(i),
      ),
    },
    // Newest first.
    { ...read, messages: [message(2000), message(1000)] },
    { ...read, messages: [{ ...message(1), direction: "draft" }] },
    { ...read, messages: [{ ...message(1), address: "+15555550123" }] },
    { ...read, messages: [{ ...message(1), date: 1.5 }] },
    { ...read, messages: [{ ...message(1), body: "x".repeat(1601) }] },
    { ...read, messages: [{ ...message(1), body: "x\u0000" }] },
    { ...read, participant: "" },
    { ...read, participant: "A‮da" },
    { ...read, truncated: "no" },
    { ...read, address: "+15555550123" },
    { ...read, status: "none-selected" },
    { kind: "messages-read", status: "read" },
    { kind: "messages-read", status: "none-selected", messages: [] },
    { kind: "messages-read", status: "cancelled" },
    { kind: "voicemail-read", status: "none-selected" },
  ])
    assert.throws(() => validateMessagesReadResult(bad), REJECTED);
});

test("a voicemail read carries a transcript and its engine only when ready", () => {
  assert.deepEqual(validateVoicemailRead({ type: "voicemail_read_selected" }), {
    type: "voicemail_read_selected",
  });
  assert.throws(
    () => validateVoicemailRead({ type: "voicemail_read_selected", id: "3" }),
    REJECTED,
  );
  const ready = {
    kind: "voicemail-read",
    status: "read",
    caller: "Ada Lovelace",
    date: 1000,
    durationSeconds: 12,
    transcriptState: "ready",
    engine: "device",
    transcript: "Call me back.",
  };
  assert.deepEqual(validateVoicemailReadResult(ready), ready);
  for (const engine of ["cloud", "carrier"])
    assert.equal(
      validateVoicemailReadResult({ ...ready, engine }).engine,
      engine,
    );
  for (const transcriptState of ["pending", "unavailable", "failed"]) {
    const waiting = {
      ...ready,
      caller: null,
      transcriptState,
      engine: null,
      transcript: null,
    };
    assert.deepEqual(validateVoicemailReadResult(waiting), waiting);
    // A transcript that is not ready carries neither text nor an engine.
    for (const bad of [
      { ...waiting, transcript: "Call me back." },
      { ...waiting, engine: "device" },
      { ...waiting, transcript: "Call me back.", engine: "device" },
    ])
      assert.throws(() => validateVoicemailReadResult(bad), REJECTED);
  }
  for (const status of ["none-selected", "unavailable"])
    assert.deepEqual(
      validateVoicemailReadResult({ kind: "voicemail-read", status }),
      { kind: "voicemail-read", status },
    );
  for (const bad of [
    // A ready transcript needs both its text and its engine.
    { ...ready, transcript: null },
    { ...ready, transcript: "" },
    { ...ready, engine: null },
    { ...ready, engine: "whisper" },
    { ...ready, transcript: "x".repeat(8001) },
    { ...ready, transcript: "x\u0000" },
    { ...ready, transcriptState: "done" },
    { ...ready, durationSeconds: -1 },
    { ...ready, durationSeconds: 1.5 },
    { ...ready, date: "yesterday" },
    { ...ready, caller: "" },
    { ...ready, number: "+15555550123" },
    { ...ready, status: "unavailable" },
    { kind: "voicemail-read", status: "read" },
    { kind: "voicemail-read", status: "none-selected", transcript: null },
    { kind: "messages-read", status: "none-selected" },
  ])
    assert.throws(() => validateVoicemailReadResult(bad), REJECTED);
});

test("a voicemail delete targets only the open voicemail", () => {
  assert.deepEqual(
    validateVoicemailDelete({ type: "voicemail_delete_selected" }),
    { type: "voicemail_delete_selected" },
  );
  for (const bad of [
    { type: "voicemail_delete_selected", id: "3" },
    { type: "voicemail_delete_all" },
  ])
    assert.throws(() => validateVoicemailDelete(bad), REJECTED);
  const deleted = validateVoicemailDeleteResult({
    kind: "voicemail-delete",
    status: "deleted",
  });
  assert.match(voicemailDeleteResultText(deleted), /voicemail was deleted/);
  for (const status of [
    "none-selected",
    "unavailable",
    "cancelled",
    "failed",
  ] as const)
    assert.doesNotMatch(
      voicemailDeleteResultText(
        validateVoicemailDeleteResult({ kind: "voicemail-delete", status }),
      ),
      /voicemail was deleted/,
    );
  for (const bad of [
    { kind: "voicemail-delete", status: "saved" },
    { kind: "voicemail-delete", status: "deleted", count: 2 },
    { kind: "voicemail-read", status: "deleted" },
    { kind: "voicemail-delete" },
  ])
    assert.throws(() => validateVoicemailDeleteResult(bad), REJECTED);
});

test("each operation type has one capability and one validator", () => {
  assert.deepEqual(
    TELEPHONY_ACTION_OPERATION_TYPES.map((type) => [
      type,
      telephonyActionCapability(type),
    ]),
    [
      ["phone_call", PHONE_CALL_CAPABILITY],
      ["contact_create", CONTACT_WRITE_CAPABILITY],
      ["contact_update", CONTACT_WRITE_CAPABILITY],
      ["contact_delete", CONTACT_WRITE_CAPABILITY],
      ["sms_compose", SMS_COMPOSE_CAPABILITY],
      ["sms_reply_selected", SMS_COMPOSE_CAPABILITY],
      ["messages_read_selected", MESSAGES_READ_CAPABILITY],
      ["voicemail_read_selected", VOICEMAIL_READ_CAPABILITY],
      ["voicemail_delete_selected", VOICEMAIL_DELETE_CAPABILITY],
    ],
  );
  for (const operation of [
    callNumber,
    create,
    update,
    remove,
    { type: "sms_compose", query: "Ada", body: "hi" },
    { type: "sms_reply_selected", body: "hi" },
    { type: "messages_read_selected" },
    { type: "voicemail_read_selected" },
    { type: "voicemail_delete_selected" },
  ]) {
    assert.equal(isTelephonyAction(operation), true);
    assert.deepEqual(validateTelephonyAction(operation), operation);
  }
  for (const other of [
    { type: "phone_dial", target: { kind: "number", number: "5551234" } },
    { type: "sms_send" },
    { type: "notes_read_selected" },
  ]) {
    assert.equal(isTelephonyAction(other), false);
    assert.throws(() => validateTelephonyAction(other), REJECTED);
  }
  assert.throws(() => validateTelephonyAction(null), REJECTED);
});

test("capabilities follow the native profile and its parts", () => {
  const all = {
    present: true,
    call: true,
    contactsWrite: true,
    sms: true,
    voicemail: true,
  };
  assert.deepEqual(telephonyActionCapabilities(all), [
    PHONE_CALL_CAPABILITY,
    CONTACT_WRITE_CAPABILITY,
    SMS_COMPOSE_CAPABILITY,
    MESSAGES_READ_CAPABILITY,
    VOICEMAIL_READ_CAPABILITY,
    VOICEMAIL_DELETE_CAPABILITY,
  ]);
  assert.deepEqual(telephonyActionCapabilities({ ...all, present: false }), []);
  assert.deepEqual(
    telephonyActionCapabilities({ ...all, sms: false, voicemail: false }),
    [PHONE_CALL_CAPABILITY, CONTACT_WRITE_CAPABILITY],
  );
  assert.deepEqual(
    telephonyActionCapabilities({
      ...all,
      call: false,
      contactsWrite: false,
      voicemail: false,
    }),
    [SMS_COMPOSE_CAPABILITY, MESSAGES_READ_CAPABILITY],
  );
});
