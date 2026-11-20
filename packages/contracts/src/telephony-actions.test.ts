import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_READ_CAPABILITY,
  CONTACT_READ_FIELD_MAX,
  CONTACT_SHOW_CAPABILITY,
  CONTACT_UPDATE_VALUES_CAPABILITY,
  CONTACT_WRITE_CAPABILITY,
  contactShowResultText,
  contactWriteCapabilityAvailable,
  contactWriteReceiptOutcome,
  contactWriteResultText,
  directSmsRequest,
  isSmsSenderLookup,
  isTelephonyAction,
  MESSAGES_READ_CAPABILITY,
  MESSAGES_READ_MAX,
  PHONE_CALL_CAPABILITY,
  PHONE_KEYPAD_CAPABILITY,
  phoneCallReceiptOutcome,
  phoneCallResultText,
  phoneKeypadResultText,
  requestedSmsDraftRecipient,
  SMS_COMPOSE_CAPABILITY,
  SMS_COMPOSE_TARGET_CAPABILITY,
  SMS_LATEST_SENDER_CAPABILITY,
  smsComposeCapabilityAvailable,
  smsComposeReceiptOutcome,
  smsComposeResultText,
  smsComposeTarget,
  smsLatestSenderReply,
  smsReplyReceiptOutcome,
  smsReplyResultText,
  smsSenderDisclosure,
  TELEPHONY_ACTION_OPERATION_TYPES,
  telephonyActionCapabilities,
  telephonyActionCapability,
  VOICEMAIL_DELETE_CAPABILITY,
  VOICEMAIL_READ_CAPABILITY,
  validateContactRead,
  validateContactReadResult,
  validateContactShow,
  validateContactShowResult,
  validateContactWrite,
  validateContactWriteResult,
  validateMessagesRead,
  validateMessagesReadResult,
  validatePhoneCall,
  validatePhoneCallResult,
  validatePhoneKeypad,
  validatePhoneKeypadResult,
  validateSmsCompose,
  validateSmsComposeResult,
  validateSmsLatestSenderResult,
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
    { type: "contact_update", query: "Ada" },
    { type: "contact_update", query: "Ada", add: {} },
    { type: "contact_update", query: "Ada", add: { phoneNumbers: [] } },
    { type: "contact_update", query: "Ada", add: { displayName: "Ada King" } },
    { type: "contact_update", query: "Ada", remove: { phoneNumbers: ["x"] } },
    {
      type: "contact_update",
      query: "Ada",
      set: { emailAddresses: [] },
      add: { emailAddresses: ["a@b.co"] },
    },
    {
      type: "contact_update",
      query: "Ada",
      add: { phoneNumbers: ["5551234"] },
      remove: { phoneNumbers: ["5551234"] },
    },
    { type: "contact_delete", query: "Ada", contactId: "7" },
    { type: "contact_delete", query: " Ada " },
    { type: "contact_delete" },
    { type: "contact_merge", query: "Ada" },
  ])
    assert.throws(() => validateContactWrite(bad), REJECTED);
});

test("a contact update adds or removes single values only with contacts.write.v2", () => {
  const addEmail = {
    type: "contact_update",
    query: "Ada",
    add: { emailAddresses: ["ada@work.example"] },
  };
  const mixed = {
    type: "contact_update",
    query: "Ada",
    set: { displayName: "Ada King" },
    add: { phoneNumbers: ["+15555550199"] },
    remove: { phoneNumbers: ["5551234"], emailAddresses: ["old@b.co"] },
  };
  assert.deepEqual(validateContactWrite(addEmail), addEmail);
  assert.deepEqual(validateContactWrite(mixed), mixed);
  const v1 = [CONTACT_WRITE_CAPABILITY];
  const v2 = [...v1, CONTACT_UPDATE_VALUES_CAPABILITY];
  for (const operation of [addEmail, mixed].map(validateContactWrite)) {
    assert.equal(contactWriteCapabilityAvailable(operation, v1), false);
    assert.equal(contactWriteCapabilityAvailable(operation, v2), true);
    assert.equal(
      contactWriteCapabilityAvailable(operation, [
        CONTACT_UPDATE_VALUES_CAPABILITY,
      ]),
      false,
    );
  }
  // The forms an older phone knows need nothing new.
  for (const operation of [create, update, remove])
    assert.equal(contactWriteCapabilityAvailable(operation, v1), true);
  assert.equal(contactWriteCapabilityAvailable(update, undefined), false);
});

test("a contact search returns only shown or not-found", () => {
  const show = { type: "contact_show", query: "Sam" };
  assert.deepEqual(validateContactShow(show), show);
  for (const bad of [
    { type: "contact_show" },
    { type: "contact_show", query: " Sam " },
    { type: "contact_show", query: "Sam", limit: 5 },
    { type: "contact_read_selected" },
  ])
    assert.throws(() => validateContactShow(bad), REJECTED);
  for (const status of ["shown", "not-found", "unavailable"] as const) {
    const result = validateContactShowResult({ kind: "contact-show", status });
    assert.deepEqual(result, { kind: "contact-show", status });
    assert.ok(contactShowResultText(result));
  }
  assert.match(
    contactShowResultText({ kind: "contact-show", status: "shown" }),
    /No contact detail was shared/,
  );
  for (const bad of [
    { kind: "contact-show", status: "read" },
    { kind: "contact-show", status: "shown", count: 2 },
    { kind: "contact-show", status: "shown", displayName: "Sam Lee" },
    { kind: "contact-write", status: "shown" },
  ])
    assert.throws(() => validateContactShowResult(bad), REJECTED);
});

test("an open-contact read is one bounded contact and nothing else", () => {
  assert.deepEqual(validateContactRead({ type: "contact_read_selected" }), {
    type: "contact_read_selected",
  });
  assert.throws(
    () => validateContactRead({ type: "contact_read_selected", query: "Sam" }),
    REJECTED,
  );
  const read = {
    kind: "contact-read",
    status: "read",
    contact: {
      displayName: "Sam Lee",
      phoneNumbers: ["(415) 555-0100", "+15555550123"],
      emailAddresses: ["sam@example.com"],
    },
  };
  assert.deepEqual(validateContactReadResult(read), read);
  const unnamed = {
    ...read,
    contact: { displayName: null, phoneNumbers: [], emailAddresses: [] },
  };
  assert.deepEqual(validateContactReadResult(unnamed), unnamed);
  for (const status of ["none-selected", "unavailable"])
    assert.deepEqual(
      validateContactReadResult({ kind: "contact-read", status }),
      { kind: "contact-read", status },
    );
  const withContact = (contact: object) => ({
    ...read,
    contact: { ...read.contact, ...contact },
  });
  for (const bad of [
    { kind: "contact-read", status: "read" },
    { kind: "contact-read", status: "none-selected", contact: read.contact },
    { ...read, contacts: [read.contact] },
    withContact({ id: "7" }),
    withContact({ displayName: "" }),
    withContact({ phoneNumbers: ["5551234\u0000"] }),
    withContact({ phoneNumbers: ["5".repeat(65)] }),
    withContact({
      phoneNumbers: Array.from(
        { length: CONTACT_READ_FIELD_MAX + 1 },
        (_, i) => `555${i}`,
      ),
    }),
    withContact({ emailAddresses: [""] }),
  ])
    assert.throws(() => validateContactReadResult(bad), REJECTED);
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
    validateSmsComposeResult(compose, { kind: "sms-compose", status });
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
    assert.throws(() => validateSmsComposeResult(compose, bad), REJECTED);
});

test("a targeted SMS names a number or a contact and needs its own capability", () => {
  const toNumber = {
    type: "sms_compose",
    target: { kind: "number", number: "+15555550123" },
    body: "Running late.",
  };
  const draft = {
    type: "sms_compose",
    target: { kind: "contact", query: "Ada" },
    body: "Running late.",
    draft: true,
  };
  assert.deepEqual(validateSmsCompose(toNumber), toNumber);
  assert.deepEqual(validateSmsCompose(draft), draft);
  // A send is the default; an explicit false is the same request.
  assert.deepEqual(validateSmsCompose({ ...toNumber, draft: false }), toNumber);
  assert.deepEqual(smsComposeTarget(validateSmsCompose(toNumber)), {
    kind: "number",
    number: "+15555550123",
  });
  assert.deepEqual(
    smsComposeTarget(
      validateSmsCompose({ type: "sms_compose", query: "Ada", body: "hi" }),
    ),
    { kind: "contact", query: "Ada" },
  );
  for (const bad of [
    { ...toNumber, query: "Ada" },
    { ...toNumber, draft: "yes" },
    { ...toNumber, subscriptionId: 1 },
    { ...toNumber, target: { kind: "number", number: "555-0100" } },
    { ...toNumber, target: { kind: "number", number: "5", query: "Ada" } },
    { ...toNumber, target: { kind: "thread", id: "4" } },
    { type: "sms_compose", query: "Ada", body: "hi", draft: true },
  ])
    assert.throws(() => validateSmsCompose(bad), REJECTED);
  const v1 = [SMS_COMPOSE_CAPABILITY];
  const v2 = [SMS_COMPOSE_CAPABILITY, SMS_COMPOSE_TARGET_CAPABILITY];
  const byQuery = validateSmsCompose({
    type: "sms_compose",
    query: "Ada",
    body: "hi",
  });
  assert.equal(smsComposeCapabilityAvailable(byQuery, v1), true);
  assert.equal(smsComposeCapabilityAvailable(byQuery, v2), true);
  for (const operation of [toNumber, draft].map(validateSmsCompose)) {
    assert.equal(smsComposeCapabilityAvailable(operation, v1), false);
    assert.equal(smsComposeCapabilityAvailable(operation, v2), true);
    assert.equal(
      smsComposeCapabilityAvailable(operation, [SMS_COMPOSE_TARGET_CAPABILITY]),
      false,
    );
    assert.equal(smsComposeCapabilityAvailable(operation, undefined), false);
  }
  // The result is bound to the reviewed form: a draft never sends, and a
  // number has no contact to miss.
  const reported = (operation: unknown, status: string) =>
    validateSmsComposeResult(validateSmsCompose(operation), {
      kind: "sms-compose",
      status,
    });
  for (const status of ["drafted", "not-found", "cancelled", "unavailable"])
    assert.equal(reported(draft, status).status, status);
  for (const status of ["submitted", "sent", "delivered", "unknown"]) {
    assert.throws(() => reported(draft, status), /draft message cannot/);
    assert.equal(reported(toNumber, status).status, status);
  }
  assert.throws(() => reported(toNumber, "not-found"), /Only a contact/);
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

test("latest SMS sender exposes only the reviewed suffix", () => {
  const result = {
    kind: "sms-latest-sender",
    status: "found",
    numberEnding: "0123",
  };
  assert.deepEqual(validateSmsLatestSenderResult(result), result);
  assert.match(
    smsLatestSenderReply(validateSmsLatestSenderResult(result)),
    /ending in 0123/,
  );
  assert.throws(
    () =>
      validateSmsLatestSenderResult({ ...result, numberEnding: "5555550123" }),
    REJECTED,
  );
  assert.throws(
    () => validateSmsLatestSenderResult({ ...result, body: "private" }),
    REJECTED,
  );
  assert.throws(
    () => validateTelephonyAction({ type: "sms_latest_sender", since: 1 }),
    REJECTED,
  );
});

test("address lookup and a reply draft use the complete negotiated address", () => {
  const operation = {
    type: "sms_latest_sender",
    includeAddress: true,
  } as const;
  const result = {
    kind: "sms-latest-sender",
    status: "found",
    address: "+14155550123",
  };
  assert.deepEqual(validateTelephonyAction(operation), operation);
  assert.deepEqual(validateSmsLatestSenderResult(result, true), result);
  assert.match(
    smsLatestSenderReply(validateSmsLatestSenderResult(result, true)),
    /\+14155550123/,
  );
  assert.throws(() => validateSmsLatestSenderResult(result));
  assert.throws(() =>
    validateSmsLatestSenderResult({ ...result, address: "incorrect" }, true),
  );
  assert.throws(() =>
    validateSmsLatestSenderResult({ ...result, body: "private" }, true),
  );
  const linked = {
    kind: "sms-latest-sender",
    status: "found",
    address: "+14155550123",
    threadId: "thread:42",
  };
  assert.deepEqual(validateSmsLatestSenderResult(linked, true), linked);
  assert.throws(() =>
    validateSmsLatestSenderResult({ ...linked, threadId: "-1" }, true),
  );
  const bound = {
    type: "sms_compose",
    target: { kind: "number", number: "+14155550123" },
    body: "Tripod",
    draft: true,
    replyThreadId: "thread:42",
  };
  assert.deepEqual(validateTelephonyAction(bound), bound);
  assert.throws(() => validateTelephonyAction({ ...bound, draft: false }));
  assert.throws(() =>
    validateTelephonyAction({
      ...bound,
      target: { kind: "contact", query: "Ada" },
    }),
  );
  const request = "Look up the sender of my newest incoming SMS on this phone.";
  assert.ok(directSmsRequest(operation, request));
  assert.ok(
    !directSmsRequest(operation, "Show a review card before you " + request),
  );
  assert.ok(!directSmsRequest({ type: "sms_latest_sender" }, request));
  assert.equal(smsSenderDisclosure(request), "address");
  assert.equal(smsSenderDisclosure("Who just texted me?"), "address");
  assert.equal(
    smsSenderDisclosure("Who sent my latest SMS? Last four digits only."),
    "last-four",
  );
  assert.equal(
    smsSenderDisclosure("Who sent my latest SMS? Last two digits only."),
    "clarify",
  );
  assert.equal(
    smsSenderDisclosure(
      "Look up my latest SMS sender: ending digits, no full number.",
    ),
    "clarify",
  );
  assert.equal(
    smsSenderDisclosure(
      "Who sent my latest SMS? Don’t show me the last four digits.",
    ),
    "clarify",
  );
  const followUp =
    "Draft a quick text asking them to bring the tripod tomorrow. Show me the draft here.";
  assert.equal(requestedSmsDraftRecipient(followUp)?.kind, "previous-sender");
  for (const request of [
    "Draft a reply to this conversation",
    "Write a reply for the current thread saying I’m on my way.",
  ]) {
    assert.equal(requestedSmsDraftRecipient(request)?.kind, "unaddressed");
  }
  assert.ok(
    requestedSmsDraftRecipient(
      "Draft a text to Ada asking them to bring the tripod.",
    )?.kind === "contact",
  );
  assert.ok(
    directSmsRequest(
      { type: "sms_compose", draft: true, replyThreadId: "thread:42" },
      followUp,
    ),
  );
  assert.ok(!directSmsRequest({ type: "sms_compose" }, followUp));
  assert.ok(!directSmsRequest({ type: "sms_send" }, followUp));
  const typedRequest =
    "Draft a text to +1 (415) 555-0124 saying call +14155550199.";
  const typed = {
    type: "sms_compose",
    draft: true,
    target: { kind: "number", number: "+14155550124" },
  };
  assert.ok(directSmsRequest(typed, typedRequest));
  assert.ok(
    !directSmsRequest(
      { ...typed, target: { kind: "number", number: "+14155550199" } },
      typedRequest,
    ),
  );
  assert.ok(
    !directSmsRequest(
      typed,
      "Draft a text to Ada asking them to call +14155550124.",
    ),
  );
  for (const request of [
    "Reply to her saying I mean it",
    'Reply to them saying "hi, but send it to Mom"',
  ]) {
    assert.equal(requestedSmsDraftRecipient(request)?.kind, "previous-sender");
  }
  for (const request of [
    "Draft a text to them; actually send it to Ada instead.",
    "Write a text to them saying hi, but send it to Mom",
    "Draft a text to them saying hi and send it to Mom",
    "Reply to them, no wait, to Sam, saying I'm late",
    "Reply to her. I mean Sam. Say I'm late",
    "Draft a text to +14155550124 or +14155550199 asking about the tripod.",
  ]) {
    assert.equal(requestedSmsDraftRecipient(request)?.kind, "ambiguous");
    assert.ok(!directSmsRequest(bound, request));
  }
  for (const request of [
    "Look up the sender of my newest incoming SMS, last four digits only.",
    "Who texted me last? Don't show the full number.",
  ]) {
    assert.ok(!directSmsRequest(operation, request));
  }
  // The open or named thread a reply belongs to, or a recipient after the
  // body, is not an addressing clause.
  for (const request of [
    "Draft a reply to this conversation",
    "Reply to Sam's text saying I'm on my way",
    "Reply to the thread with Ada saying hi",
    "Draft a text saying I'm late to Sam",
  ]) {
    assert.equal(
      requestedSmsDraftRecipient(request)?.kind,
      "unaddressed",
      request,
    );
    assert.ok(!directSmsRequest(bound, request));
  }
  // A purpose clause after the recipient is the message, not part of the
  // recipient.
  for (const request of [
    "Draft a text to Sam to ask him about dinner tonight",
    "Write a message to Sam to tell him I'm running late",
    "Draft a text to Sam to remind him about the tripod",
    "Draft a text to Sam to see if he's free tonight",
    "Draft a text to Sam to check if he got home",
    "Draft a text to Sam to let him know I'm running late",
    "Draft a text to Sam letting him know I'm running late",
  ]) {
    assert.deepEqual(
      requestedSmsDraftRecipient(request),
      { kind: "contact", query: "Sam" },
      request,
    );
  }
  assert.deepEqual(
    requestedSmsDraftRecipient(
      "Draft a text to +1 (415) 555-0124 to ask about the tripod",
    ),
    { kind: "number", number: "+14155550124" },
  );
  // Only a question about the sender reads one, wherever the owner says it is
  // on this phone. A message from a named sender or another service's inbox
  // is the planner's.
  for (const request of [
    "Who was my latest text from?",
    "What's the number on my latest text?",
    "Who sent the last text message in my inbox?",
    "Who sent me the latest text in the last hour?",
    "Check who sent my latest text in Messages",
    "Who sent my most recent text, from what number?",
    "Who sent my latest text from this morning?",
  ]) {
    assert.ok(isSmsSenderLookup(request), request);
    assert.equal(smsSenderDisclosure(request), "address", request);
  }
  for (const request of [
    "What was the last message from Sam?",
    "Show me the latest text from Mom",
    "Who sent the latest message from Sam?",
    "What's the number of the latest text from Sam?",
    "Check the latest message from Sam on Slack",
    "Who sent my latest message in Gmail?",
    "Who sent my latest message on WhatsApp?",
    "Who sent my latest text over email?",
  ]) {
    assert.ok(!isSmsSenderLookup(request), request);
    assert.equal(smsSenderDisclosure(request), "last-four");
  }
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
      ["contact_show", CONTACT_SHOW_CAPABILITY],
      ["contact_read_selected", CONTACT_READ_CAPABILITY],
      ["sms_compose", SMS_COMPOSE_CAPABILITY],
      ["sms_reply_selected", SMS_COMPOSE_CAPABILITY],
      ["phone_keypad", PHONE_KEYPAD_CAPABILITY],
      ["messages_read_selected", MESSAGES_READ_CAPABILITY],
      ["sms_latest_sender", SMS_LATEST_SENDER_CAPABILITY],
      ["voicemail_read_selected", VOICEMAIL_READ_CAPABILITY],
      ["voicemail_delete_selected", VOICEMAIL_DELETE_CAPABILITY],
    ],
  );
  for (const operation of [
    callNumber,
    create,
    update,
    remove,
    { type: "contact_show", query: "Ada" },
    { type: "contact_read_selected" },
    { type: "sms_compose", query: "Ada", body: "hi" },
    { type: "sms_reply_selected", body: "hi" },
    { type: "messages_read_selected" },
    { type: "sms_latest_sender" },
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
  // A host opts in to each contact addition; adding values needs the write.
  assert.deepEqual(
    telephonyActionCapabilities({
      ...all,
      call: false,
      sms: false,
      voicemail: false,
      contactValues: true,
      contactsShow: true,
      contactsRead: true,
    }),
    [
      CONTACT_WRITE_CAPABILITY,
      CONTACT_UPDATE_VALUES_CAPABILITY,
      CONTACT_SHOW_CAPABILITY,
      CONTACT_READ_CAPABILITY,
    ],
  );
  assert.deepEqual(
    telephonyActionCapabilities({
      ...all,
      call: false,
      contactsWrite: false,
      sms: false,
      voicemail: false,
      contactValues: true,
    }),
    [],
  );
});

test("phone_keypad opens the keypad, filled in at most, and never calls", () => {
  assert.equal(isTelephonyAction({ type: "phone_keypad" }), true);
  assert.equal(
    telephonyActionCapability("phone_keypad"),
    PHONE_KEYPAD_CAPABILITY,
  );
  assert.deepEqual(validatePhoneKeypad({ type: "phone_keypad" }), {
    type: "phone_keypad",
  });
  assert.deepEqual(
    validateTelephonyAction({ type: "phone_keypad", number: "+14155550100" }),
    { type: "phone_keypad", number: "+14155550100" },
  );
  for (const refused of [
    { type: "phone_keypad", number: "415-555-0100" },
    { type: "phone_keypad", number: "" },
    { type: "phone_keypad", number: 4155550100 },
    { type: "phone_keypad", number: "4155550100", call: true },
    { type: "phone_keypad", target: { kind: "number", number: "4155550100" } },
  ])
    assert.throws(() => validateTelephonyAction(refused), REJECTED);
  assert.deepEqual(
    validatePhoneKeypadResult({ kind: "phone-keypad", status: "opened" }),
    { kind: "phone-keypad", status: "opened" },
  );
  for (const refused of [
    { kind: "phone-keypad", status: "placed" },
    { kind: "phone-keypad", status: "opened", number: "1" },
  ])
    assert.throws(() => validatePhoneKeypadResult(refused), REJECTED);
  assert.match(
    phoneKeypadResultText({ kind: "phone-keypad", status: "opened" }),
    /Nothing was dialed or called/,
  );
  assert.deepEqual(
    telephonyActionCapabilities({
      present: true,
      call: false,
      contactsWrite: false,
      sms: false,
      voicemail: false,
      keypad: true,
    }),
    [PHONE_KEYPAD_CAPABILITY],
  );
  assert.deepEqual(
    telephonyActionCapabilities({
      present: false,
      call: true,
      contactsWrite: true,
      sms: true,
      voicemail: true,
      keypad: true,
    }),
    [],
  );
});
