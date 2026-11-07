import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  mmsBindingText,
  mmsReceiptOutcome,
  validateMmsResult,
  validateMmsSend,
} from "./mms-send.ts";
import {
  createTelephonyClient,
  mmsBinding,
  parseTelephonyStatus,
  reviewMms,
} from "./native-telephony.ts";

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const op = () => ({
  type: "mms_send" as const,
  recipients: ["+15555550100", "5550101"],
  body: "Dinner at 7 ✓",
  attachments: [
    {
      contentType: "image/jpeg" as const,
      name: "photo.jpg",
      sha256: sha(image),
      size: image.length,
    },
  ],
  subscriptionId: 3,
});
const status = (patch: Record<string, unknown> = {}) =>
  parseTelephonyStatus({
    version: 2,
    voiceCapable: true,
    smsCapable: true,
    permissions: {
      contacts: "granted",
      phoneState: "granted",
      sms: "granted",
      sendSms: "granted",
    },
    sendMode: "direct",
    mmsSend: true,
    roles: {
      dialer: { available: true, held: false, eligible: true },
      sms: { available: true, held: true, eligible: true },
    },
    defaultDialer: null,
    defaultSms: "app",
    subscriptions: [
      {
        id: 3,
        slot: 0,
        displayName: "Work",
        carrierName: "Carrier",
        defaultSms: true,
        defaultVoice: true,
      },
    ],
    defaultSmsSubscriptionId: 3,
    ...patch,
  });

test("the mms.send.v1 binding has a fixed field order shared with the native journal", () => {
  assert.equal(
    mmsBindingText(op()),
    `{"attachments":[{"contentType":"image/jpeg","name":"photo.jpg","sha256":"${sha(image)}","size":7}],"body":"Dinner at 7 ✓","recipients":["+15555550100","5550101"],"subscriptionId":3,"type":"mms_send"}`,
  );
});

test("reviewed MMS operations are bounded and exact", () => {
  assert.deepEqual(validateMmsSend(op()), op());
  const bad: Record<string, unknown>[] = [
    { ...op(), body: "", attachments: [] },
    { ...op(), recipients: [] },
    { ...op(), recipients: ["+15555550100", "+15555550100"] },
    { ...op(), recipients: Array.from({ length: 11 }, (_, i) => `55501${i}0`) },
    { ...op(), body: "x".repeat(1601) },
    { ...op(), body: "\uD800" },
    { ...op(), subscriptionId: -1 },
    { ...op(), extra: true },
    {
      ...op(),
      attachments: [{ ...op().attachments[0], contentType: "text/html" }],
    },
    { ...op(), attachments: [{ ...op().attachments[0], name: "../x" }] },
    {
      ...op(),
      attachments: [op().attachments[0], op().attachments[0]],
    },
    {
      ...op(),
      attachments: [{ ...op().attachments[0], size: 1024 * 1024 + 1 }],
    },
  ];
  for (const value of bad) assert.throws(() => validateMmsSend(value));
  // Text-only group message and attachment-only picture message are both valid.
  validateMmsSend({ ...op(), attachments: [] });
  validateMmsSend({ ...op(), body: "" });
});

test("MMS results are bound to the reviewed operation and never claim delivery", () => {
  const hash = sha(mmsBindingText(op()));
  const result = {
    kind: "mms-send",
    operationId: "op-1",
    subscriptionId: 3,
    bindingHash: hash,
    status: "sent",
    createdAt: 1,
  };
  assert.equal(validateMmsResult(op(), result, "op-1", hash).status, "sent");
  assert.equal(
    mmsReceiptOutcome(validateMmsResult(op(), result, "op-1", hash)),
    "applied",
  );
  assert.throws(() =>
    validateMmsResult(op(), { ...result, status: "delivered" }, "op-1", hash),
  );
  assert.throws(() =>
    validateMmsResult(
      op(),
      { ...result, bindingHash: "0".repeat(64) },
      "op-1",
      hash,
    ),
  );
  assert.throws(() => validateMmsResult(op(), result, "op-2", hash));
  assert.throws(() =>
    validateMmsResult(op(), { ...result, subscriptionId: 4 }, "op-1", hash),
  );
  assert.equal(
    mmsReceiptOutcome({
      ...validateMmsResult(op(), result, "op-1", hash),
      status: "cancelled",
    }),
    "failed",
  );
  assert.equal(
    mmsReceiptOutcome({
      ...validateMmsResult(op(), result, "op-1", hash),
      status: "unknown",
    }),
    "unknown",
  );
});

test("status reports MMS sends only with direct sends", () => {
  assert.equal(status().mmsSend, true);
  const { mmsSend: _, ...without } = {
    ...status(),
    mmsSend: undefined,
    version: 2,
  };
  assert.equal(
    parseTelephonyStatus({ ...without, sendMode: "direct" }).mmsSend,
    false,
  );
  assert.throws(() =>
    status({
      sendMode: "handoff",
      permissions: {
        contacts: "granted",
        phoneState: "granted",
        sms: "granted",
        sendSms: "denied",
      },
    }),
  );
  assert.throws(() => status({ mmsSend: "yes" }));
});

test("MMS reviews: group messages, attachments, SIM rules and bounds", () => {
  const ok = reviewMms(
    {
      recipients: ["+1 555 555 0100", "555-0101", "+15555550100"],
      body: "",
      attachments: [{ contentType: "image/png", name: "a.png", bytes: image }],
    },
    status(),
  );
  assert.ok("review" in ok);
  assert.deepEqual(ok.review.recipients, ["+15555550100", "5550101"]);
  assert.equal(ok.review.subscriptionId, 3);
  const problem = (draft: Parameters<typeof reviewMms>[0], s = status()) => {
    const r = reviewMms(draft, s);
    return "problem" in r ? r.problem : null;
  };
  assert.equal(
    problem(
      { recipients: ["5550100"], body: "hi" },
      status({ mmsSend: false }),
    ),
    "mms-unavailable",
  );
  assert.equal(
    problem({ recipients: ["5550100"], body: "  " }),
    "empty-message",
  );
  assert.equal(problem({ recipients: [], body: "hi" }), "no-recipient");
  assert.equal(
    problem({ recipients: ["abc"], body: "hi" }),
    "invalid-recipient",
  );
  assert.equal(
    problem({
      recipients: ["5550100"],
      body: "",
      attachments: [
        { contentType: "application/pdf", name: "a.pdf", bytes: image },
      ],
    }),
    "attachment-type",
  );
  assert.equal(
    problem({
      recipients: ["5550100"],
      body: "",
      attachments: [
        {
          contentType: "image/png",
          name: "a.png",
          bytes: new Uint8Array(1024 * 1024 + 1),
        },
      ],
    }),
    "too-large",
  );
  assert.equal(
    problem({ recipients: ["5550100"], body: "hi", subscriptionId: 9 }),
    "sim-unknown",
  );
});

test("the client sends the exact reviewed bytes and checks the bound receipt", async () => {
  const calls: unknown[] = [];
  const review = {
    recipients: ["+15555550100", "5550101"],
    body: "Dinner",
    attachments: [
      { contentType: "image/jpeg" as const, name: "photo.jpg", bytes: image },
    ],
    subscriptionId: 3,
  };
  const { hash } = await mmsBinding(review);
  const plugin = {
    sendMms: async (options: unknown) => {
      calls.push(options);
      return {
        kind: "mms-send",
        operationId: "op-1",
        subscriptionId: 3,
        bindingHash: hash,
        status: "submitted",
        createdAt: 5,
      };
    },
    mmsSendResult: async () => ({
      kind: "mms-send",
      operationId: "op-1",
      subscriptionId: 3,
      bindingHash: hash,
      status: "sent",
      createdAt: 5,
    }),
  };
  const client = createTelephonyClient(
    plugin as unknown as Parameters<typeof createTelephonyClient>[0],
    true,
  );
  assert.equal((await client.sendMms(review, "op-1")).status, "submitted");
  const sent = calls[0] as { attachments: { data: string; sha256: string }[] };
  assert.equal(
    Buffer.from(sent.attachments[0].data, "base64").toString("hex"),
    Buffer.from(image).toString("hex"),
  );
  assert.equal(sent.attachments[0].sha256, sha(image));
  assert.equal((await client.mmsSendResult(review, "op-1")).status, "sent");
  await assert.rejects(client.sendMms(review, "bad id"), RangeError);
  await assert.rejects(
    client.mmsSendResult({ ...review, body: "changed" }, "op-1"),
    /binding changed/,
  );
  const unavailable = createTelephonyClient(null, false);
  await assert.rejects(unavailable.sendMms(review, "op-1"));
});
