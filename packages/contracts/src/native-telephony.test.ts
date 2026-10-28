import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createTelephonyClient,
  detectTelephonyProfile,
  normalizePhoneNumber,
  parseHandoff,
  parseMessages,
  parseSmsJournal,
  parseSmsSendResult,
  parseTelephonyStatus,
  parseThreads,
  reviewSms,
  smsBindingHash,
  smsBindingText,
  TelephonyUnavailable,
} from "./native-telephony.ts";

const status = (patch: Record<string, unknown> = {}) => ({
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
  roles: {
    dialer: { available: true, held: false, eligible: false },
    sms: { available: true, held: false, eligible: false },
  },
  defaultDialer: "com.android.dialer",
  defaultSms: "com.android.messaging",
  subscriptions: [
    {
      id: 3,
      slot: 0,
      displayName: "Work",
      carrierName: "Carrier A",
      defaultSms: true,
      defaultVoice: true,
    },
  ],
  defaultSmsSubscriptionId: 3,
  ...patch,
});
type Call = [string, unknown];
function stub(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const listeners: [string, (data: unknown) => void][] = [];
  const plugin = new Proxy(
    {},
    {
      get: (_, method: string) =>
        method === "then"
          ? undefined
          : method === "addListener"
            ? async (event: string, listener: (data: unknown) => void) => {
                listeners.push([event, listener]);
                return {
                  remove: async () => {
                    calls.push(["remove", event]);
                  },
                };
              }
            : async (options: unknown) => {
                calls.push([method, options]);
                const answer = answers[method];
                if (answer instanceof Error) throw answer;
                return typeof answer === "function" ? answer(options) : answer;
              },
    },
  );
  // biome-ignore lint/suspicious/noExplicitAny: recording stub of the native bridge
  return { plugin: plugin as any, calls, listeners };
}

test("the profile is detected only from the native plugin header", () => {
  const headers = [
    { name: "HostTelephony", methods: [{ name: "imageCapability" }] },
  ];
  assert.equal(
    detectTelephonyProfile("android", headers, "HostTelephony"),
    true,
  );
  assert.equal(detectTelephonyProfile("web", headers, "HostTelephony"), false);
  assert.equal(detectTelephonyProfile("android", headers, "Other"), false);
  assert.equal(
    detectTelephonyProfile(
      "android",
      [{ name: "HostTelephony", methods: [{ name: "status" }] }],
      "HostTelephony",
    ),
    false,
  );
  assert.equal(detectTelephonyProfile("android", null, "HostTelephony"), false);
});

test("without the admitted profile nothing reaches native code", async () => {
  const { plugin, calls } = stub();
  for (const client of [
    createTelephonyClient(null, false),
    createTelephonyClient(plugin, false, {
      unavailableMessage: "Host image only.",
    }),
  ]) {
    assert.equal(client.available, false);
    await assert.rejects(client.status(), TelephonyUnavailable);
    await assert.rejects(client.listThreads(), TelephonyUnavailable);
    await assert.rejects(client.listMessages("thread:1"), TelephonyUnavailable);
    await assert.rejects(
      client.observeMessages(() => {}),
      TelephonyUnavailable,
    );
    await assert.rejects(
      client.sendSms(
        { recipients: ["+15555550100"], body: "x", subscriptionId: 3 },
        "op-1",
      ),
      TelephonyUnavailable,
    );
    await assert.rejects(client.requestAccess("sms"), TelephonyUnavailable);
    await assert.rejects(client.dial("+15555550100"), TelephonyUnavailable);
    await assert.rejects(
      client.markThreadRead("thread:1", 1_700_000_000_000),
      TelephonyUnavailable,
    );
  }
  await assert.rejects(
    createTelephonyClient(null, false, {
      unavailableMessage: "Host image only.",
    }).status(),
    /Host image only\./,
  );
  assert.deepEqual(calls, []);
});

test("status reports roles, SIMs and send mode truthfully", () => {
  assert.equal(parseTelephonyStatus(status()).sendMode, "direct");
  assert.equal(parseTelephonyStatus(status()).defaultSmsSubscriptionId, 3);
  assert.throws(
    () =>
      parseTelephonyStatus(
        status({
          permissions: {
            contacts: "granted",
            phoneState: "granted",
            sms: "granted",
            sendSms: "denied",
          },
        }),
      ),
    /send mode/,
  );
  assert.throws(
    () => parseTelephonyStatus(status({ smsCapable: false })),
    /send mode/,
  );
  assert.throws(
    () => parseTelephonyStatus(status({ defaultSmsSubscriptionId: 9 })),
    /default SMS subscription/,
  );
  assert.throws(
    () =>
      parseTelephonyStatus(
        status({
          permissions: {
            contacts: "granted",
            phoneState: "denied",
            sms: "granted",
            sendSms: "denied",
          },
          sendMode: "handoff",
        }),
      ),
    /subscriptions/,
    "a SIM list without phone-state access is never trusted",
  );
  assert.throws(
    () =>
      parseTelephonyStatus(
        status({
          roles: {
            dialer: { available: false, held: true, eligible: false },
            sms: { available: true, held: false, eligible: false },
          },
        }),
      ),
    /dialer role/,
  );
  const none = parseTelephonyStatus(
    status({
      sendMode: "handoff",
      permissions: {
        contacts: "granted",
        phoneState: "prompt",
        sms: "prompt",
        sendSms: "denied",
      },
      subscriptions: null,
      defaultSmsSubscriptionId: null,
    }),
  );
  assert.equal(none.subscriptions, null);
  assert.equal(none.sendMode, "handoff");
});

test("reviews follow the handoff and shared direct-send bounds", () => {
  const s = parseTelephonyStatus(status());
  assert.deepEqual(
    reviewSms(
      {
        recipients: ["1", "2", "3", "4", "5", "6"].map(
          (n) => `+1555555010${n}`,
        ),
        body: "x",
      },
      s,
      "direct",
    ),
    { problem: "too-many-recipients" },
  );
  assert.deepEqual(
    reviewSms(
      { recipients: ["+15555550100"], body: "x".repeat(1601) },
      s,
      "direct",
    ),
    {
      problem: "body-too-long",
    },
  );
  assert.deepEqual(
    reviewSms({ recipients: ["+15555550100"], body: "a\ud800" }, s, "direct"),
    {
      problem: "invalid-body",
    },
  );
  const handoff = reviewSms(
    { recipients: ["+1 (555) 555-0100"], body: "x".repeat(1601) },
    s,
  );
  assert.ok(
    "review" in handoff &&
      handoff.review.body.length === 1601 &&
      handoff.review.recipients[0] === "+15555550100",
  );
  assert.deepEqual(
    reviewSms(
      { recipients: ["+15555550100"], body: "hi", subscriptionId: 3 },
      s,
    ),
    {
      problem: "sim-not-selectable",
    },
  );
  const direct = reviewSms(
    { recipients: ["+15555550100"], body: "hi" },
    s,
    "direct",
  );
  assert.ok("review" in direct && direct.review.subscriptionId === 3);
  const two = parseTelephonyStatus(
    status({
      subscriptions: [
        {
          id: 3,
          slot: 0,
          displayName: "Work",
          carrierName: "A",
          defaultSms: false,
          defaultVoice: true,
        },
        {
          id: 4,
          slot: 1,
          displayName: "Home",
          carrierName: "B",
          defaultSms: false,
          defaultVoice: false,
        },
      ],
      defaultSmsSubscriptionId: null,
    }),
  );
  assert.deepEqual(
    reviewSms({ recipients: ["+15555550100"], body: "hi" }, two, "direct"),
    { problem: "sim-required" },
  );
  assert.deepEqual(
    reviewSms(
      { recipients: ["+15555550100"], body: "hi", subscriptionId: 9 },
      two,
      "direct",
    ),
    {
      problem: "sim-unknown",
    },
  );
  assert.equal(
    normalizePhoneNumber("*#06#"),
    null,
    "MMI codes stay with the system dialer",
  );
});

test("handoffs never report a call or a send", async () => {
  const { plugin, calls } = stub({
    dial: {
      status: "handed-off",
      target: "dialer",
      handler: "com.android.dialer",
      message: "open",
    },
    composeSms: {
      status: "handed-off",
      target: "sms",
      handler: null,
      message: "open",
    },
  });
  const client = createTelephonyClient(plugin, true);
  assert.equal((await client.dial("+1 555 555 0100")).status, "handed-off");
  assert.deepEqual(calls[0], ["dial", { number: "+15555550100" }]);
  await assert.rejects(client.dial("*#06#"), RangeError);
  await assert.rejects(
    client.composeSms({
      recipients: ["+15555550100"],
      body: "hi",
      subscriptionId: 3,
    }),
    RangeError,
  );
  assert.throws(
    () =>
      parseHandoff(
        { status: "sent", target: "sms", handler: null, message: "x" },
        "sms",
      ),
    /handoff/,
  );
  assert.throws(
    () =>
      parseHandoff(
        { status: "handed-off", target: "sms", handler: null, message: "x" },
        "dialer",
      ),
    /handoff/,
  );
});

test("threads and messages are bounded, stable and truthful about status", async () => {
  const thread = {
    id: "thread:4",
    date: 1700000000000,
    messageCount: 2,
    snippet: "hi",
    unread: true,
    addresses: ["+15555550100"],
  };
  const sms = {
    id: "sms:9",
    kind: "sms",
    threadId: "thread:4",
    direction: "outgoing",
    status: "delivered",
    date: 1700000000000,
    read: true,
    subscriptionId: 3,
    addresses: ["+15555550100"],
    body: "hi",
    deliveryReport: "complete",
    attachments: 0,
  };
  const mms = {
    id: "mms:9",
    kind: "mms",
    threadId: "thread:4",
    direction: "incoming",
    status: "received",
    date: 1699999999000,
    read: false,
    subscriptionId: null,
    addresses: ["+15555550100"],
    body: "",
    deliveryReport: null,
    attachments: 1,
  };
  const { plugin, calls } = stub({
    listThreads: (options: { cursor?: string }) => ({
      threads: [thread],
      next: options.cursor ? null : "1700000000000:thread:4",
    }),
    listMessages: { messages: [sms, mms] },
  });
  const client = createTelephonyClient(plugin, true);
  assert.deepEqual(await client.listThreads(10), [thread]);
  assert.deepEqual(await client.listMessages("thread:4", 10, 1700000000001), [
    sms,
    mms,
  ]);
  assert.deepEqual(calls.slice(0, 2), [
    ["listThreads", { limit: 10 }],
    [
      "listMessages",
      { threadId: "thread:4", limit: 10, before: 1700000000001 },
    ],
  ]);
  assert.equal((await client.threadPage()).next, "1700000000000:thread:4");
  assert.equal((await client.threadPage("1700000000000:thread:4")).next, null);
  await assert.rejects(client.threadPage("1:sms:4"), RangeError);
  await assert.rejects(client.listThreads(51), RangeError);
  await assert.rejects(client.listMessages("4", 10), RangeError);
  await assert.rejects(client.listMessages("thread:4", 10, -1), RangeError);
  assert.throws(
    () => parseThreads({ threads: [thread, thread] }, 5),
    /thread id/,
  );
  assert.throws(
    () => parseThreads({ threads: [thread, { ...thread, id: "thread:5" }] }, 1),
    /threads/,
  );
  assert.throws(
    () =>
      parseMessages(
        { messages: [{ ...sms, deliveryReport: "pending" }] },
        "thread:4",
        5,
      ),
    /message status/,
  );
  assert.throws(
    () =>
      parseMessages(
        {
          messages: [
            {
              ...mms,
              status: "delivered",
              direction: "outgoing",
              deliveryReport: "complete",
            },
          ],
        },
        "thread:4",
        5,
      ),
    /delivery report/,
    "MMS delivery is never claimed",
  );
  assert.throws(
    () =>
      parseMessages({ messages: [{ ...mms, status: "sent" }] }, "thread:4", 5),
    /message status/,
  );
  assert.throws(
    () =>
      parseMessages(
        { messages: [{ ...sms, threadId: "thread:5" }] },
        "thread:4",
        5,
      ),
    /message id/,
  );
  assert.throws(
    () => parseMessages({ messages: [{ ...sms, id: "mms:9" }] }, "thread:4", 5),
    /message id/,
  );
  assert.throws(
    () =>
      parseMessages(
        { messages: [{ ...sms, body: "x".repeat(2001) }] },
        "thread:4",
        5,
      ),
    /message body/,
  );
});

test("change notices carry no content and stop cleanly", async () => {
  const { plugin, calls, listeners } = stub({ observeMessages: undefined });
  const client = createTelephonyClient(plugin, true);
  let changes = 0;
  const updated: string[] = [];
  const stop = await client.observeMessages(
    () => changes++,
    (id) => updated.push(id),
  );
  for (const [event, listener] of listeners)
    listener(
      event === "messagesChanged" ? { sequence: 1 } : { operationId: "op-1" },
    );
  listeners[1][1]({ operationId: "bad id!" });
  assert.equal(changes, 1);
  assert.deepEqual(updated, ["op-1"]);
  await stop();
  assert.deepEqual(
    calls.filter(([m]) => m === "observeMessages").map(([, o]) => o),
    [{ enabled: true }, { enabled: false }],
  );
  const refused = stub({ observeMessages: new Error("permission-required") });
  await assert.rejects(
    createTelephonyClient(refused.plugin, true).observeMessages(() => {}),
    /permission-required/,
  );
  assert.equal(refused.calls.filter(([m]) => m === "remove").length, 1);
});

test("a conversation is marked read only through the shown message, by the SMS app", async () => {
  const { plugin, calls } = stub({
    markThreadRead: { defaultSmsApp: true, updated: 2 },
  });
  const client = createTelephonyClient(plugin, true);
  assert.deepEqual(await client.markThreadRead("thread:7", 1_700_000_000_123), {
    defaultSmsApp: true,
    updated: 2,
  });
  assert.deepEqual(calls, [
    [
      "markThreadRead",
      { threadId: "thread:7", throughDate: 1_700_000_000_123 },
    ],
  ]);
  // Malformed requests never reach native code.
  for (const [thread, date] of [
    ["thread:0", 1],
    ["7", 1],
    ["thread:7 OR 1=1", 1],
    ["thread:7", 0],
    ["thread:7", -1],
    ["thread:7", 1.5],
    ["thread:7", Number.MAX_SAFE_INTEGER + 1],
  ] as const)
    await assert.rejects(client.markThreadRead(thread, date), RangeError);
  assert.equal(calls.length, 1);
  // Another app holds the SMS role: nothing changed, and a claimed change is refused.
  const other = stub({ markThreadRead: { defaultSmsApp: false, updated: 0 } });
  assert.deepEqual(
    await createTelephonyClient(other.plugin, true).markThreadRead(
      "thread:7",
      5,
    ),
    { defaultSmsApp: false, updated: 0 },
  );
  for (const answer of [
    { defaultSmsApp: false, updated: 1 },
    { defaultSmsApp: true, updated: -1 },
    { defaultSmsApp: "yes", updated: 0 },
    null,
  ])
    await assert.rejects(
      createTelephonyClient(
        stub({ markThreadRead: answer }).plugin,
        true,
      ).markThreadRead("thread:7", 5),
      /invalid read marker/,
    );
});

test("native sends: exact binding, evidence-backed status, no resend", async () => {
  const review = {
    recipients: ["+15555550100", "+15555550101"],
    body: "On my way",
    subscriptionId: 3,
  };
  const hash = await smsBindingHash(review);
  assert.equal(
    smsBindingText(review),
    JSON.stringify({
      body: review.body,
      recipients: review.recipients,
      subscriptionId: 3,
      type: "sms_send",
    }),
  );
  assert.equal(
    hash,
    createHash("sha256").update(smsBindingText(review)).digest("hex"),
  );
  // The native JVM journal test pins this exact hash for the same fixture.
  assert.equal(
    await smsBindingHash({
      recipients: ["+15555550100", "5550101"],
      body: 'Running late "5" min\né😀\t\u0001',
      subscriptionId: 3,
    }),
    "53d0ac9b4312697932a9a85525df8ee38a1a0bc23ebfbb22687fcc1d67b41e90",
  );
  const part = (
    index: number,
    recipientIndex: number,
    partIndex: number,
    sent = "unknown",
    delivery = "unknown",
  ) => ({
    index,
    recipientIndex,
    partIndex,
    sent,
    delivery,
  });
  const result = (patch: Record<string, unknown> = {}) => ({
    kind: "sms-send",
    operationId: "op-1",
    subscriptionId: 3,
    bindingHash: hash,
    status: "submitted",
    parts: [part(0, 0, 0), part(1, 1, 0)],
    createdAt: 1,
    ...patch,
  });
  const { plugin, calls } = stub({
    sendSms: result(),
    smsSendResult: result({
      status: "sent",
      parts: [part(0, 0, 0, "success"), part(1, 1, 0, "success")],
    }),
    cancelSmsReview: undefined,
  });
  const client = createTelephonyClient(plugin, true);
  assert.equal((await client.sendSms(review, "op-1")).status, "submitted");
  assert.deepEqual(calls[0], [
    "sendSms",
    {
      operationId: "op-1",
      recipients: review.recipients,
      body: review.body,
      subscriptionId: 3,
    },
  ]);
  assert.equal((await client.smsSendResult(review, "op-1")).status, "sent");
  assert.deepEqual(
    calls[1],
    ["smsSendResult", { operationId: "op-1" }],
    "reading a result never sends",
  );
  await client.cancelSmsReview("op-1");
  assert.deepEqual(calls[2], ["cancelSmsReview", { operationId: "op-1" }]);
  await assert.rejects(
    client.sendSms({ ...review, subscriptionId: null }, "op-2"),
    RangeError,
  );
  await assert.rejects(client.sendSms(review, "bad id"), RangeError);
  for (const [patch, why] of [
    [{ status: "sent" }, "sent without sent callbacks"],
    [
      {
        status: "delivered",
        parts: [part(0, 0, 0, "success"), part(1, 1, 0, "success")],
      },
      "delivered without delivery reports",
    ],
    [{ status: "cancelled" }, "cancelled with parts"],
    [{ bindingHash: "0".repeat(64) }, "other content"],
    [{ subscriptionId: 4 }, "other SIM"],
    [{ operationId: "op-2" }, "other operation"],
    [{ parts: [part(0, 0, 0)] }, "a recipient without parts"],
    [
      { parts: [part(0, 0, 0, "unknown", "success"), part(1, 1, 0)] },
      "delivery before sent",
    ],
    [{ parts: [part(0, 1, 0), part(1, 0, 0)] }, "part order"],
    [{ extra: true }, "extra fields"],
  ] as const)
    assert.throws(
      () => parseSmsSendResult(result(patch), review, "op-1", hash),
      /SMS/,
      why,
    );
  assert.equal(
    parseSmsSendResult(
      result({
        status: "failed",
        parts: [part(0, 0, 0, "failed"), part(1, 1, 0, "success")],
      }),
      review,
      "op-1",
      hash,
    ).status,
    "failed",
  );
  assert.equal(
    parseSmsSendResult(
      result({ status: "denied", parts: [] }),
      review,
      "op-1",
      hash,
    ).parts.length,
    0,
  );
});

test("journal history restores unknown operations without content or optimistic delivery", async () => {
  const row = {
    kind: "sms-send",
    operationId: "lost-transport",
    subscriptionId: 3,
    bindingHash: "a".repeat(64),
    status: "unknown",
    parts: [
      {
        index: 0,
        recipientIndex: 0,
        partIndex: 0,
        sent: "unknown",
        delivery: "unknown",
      },
    ],
    createdAt: 1,
  };
  assert.equal(
    parseSmsJournal({ receipts: [row] })[0].operationId,
    "lost-transport",
  );
  assert.throws(() => parseSmsJournal({ receipts: [row, row] }), /journal/);
  assert.throws(
    () => parseSmsJournal({ receipts: [{ ...row, status: "delivered" }] }),
    /SMS/,
  );
  assert.throws(
    () => parseSmsJournal({ receipts: [{ ...row, body: "must not leak" }] }),
    /SMS/,
  );
  const { plugin, calls } = stub({ smsSendHistory: { receipts: [row] } });
  assert.equal(
    (await createTelephonyClient(plugin, true).smsSendHistory())[0].status,
    "unknown",
  );
  assert.deepEqual(
    calls.map(([method]) => method),
    ["smsSendHistory"],
  );
});
