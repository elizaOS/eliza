import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  createNativeGoogleCloudPort,
  startManagedGoogleAgentHost,
  startNativeGoogleAgentHost,
} from "../../src/runtime/managed-google-agent/index.ts";

const user = "11111111-1111-4111-8111-111111111111",
  org = "22222222-2222-4222-8222-222222222222",
  grant = "33333333-3333-4333-8333-333333333333";
const binding = () => ({
  credentialId: "44444444-4444-4444-8444-444444444444",
  userId: user,
  organizationId: org,
  accountRef: JSON.stringify(["cloud", "production", user, org]),
  sessionGeneration: "native-generation-1",
  token: "synthetic-native-cloud-key",
});
// The Android SDK emits 48 random bytes as 64 URL-safe Base64 characters.
const apiToken = "Z_-q".repeat(16);
const hostOptions = {
  apiOrigin: "https://api.eliza.app",
  userAgent: "Eliza-Native-Google/1",
  access: () => ({ gmailChanges: true, calendarEdits: true }),
};
async function fixture({
  accounts,
  retireAfterCalendars = false,
  access = hostOptions.access,
  gmailReadBodyMaxCharacters,
} = {}) {
  const calls = [],
    receipts = new Map();
  let current = true,
    otherOwner = false,
    dispatches = 0,
    messageBody = "A complete message",
    messageSubject = "A &amp; B";
  const request = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname);
    assert.equal(
      init.headers.Authorization,
      "Bearer synthetic-native-cloud-key",
    );
    assert.equal(init.redirect, "error");
    if (u.pathname === "/api/v1/user")
      return Response.json({
        success: true,
        data: { id: otherOwner ? grant : user, organization_id: org },
      });
    if (u.pathname.endsWith("/accounts"))
      return Response.json(
        accounts ?? [
          {
            configured: true,
            connected: true,
            reason: "connected",
            connectionId: grant,
            identity: { email: "owned@example.invalid" },
            grantedCapabilities: [
              "google.gmail.triage",
              "google.gmail.send",
              "google.gmail.mailbox",
              "google.calendar.read",
              "google.calendar.write",
            ],
          },
        ],
      );
    if (u.pathname.endsWith("/search"))
      return Response.json({
        messages: [
          {
            externalId: "mail1",
            threadId: "thread1",
            subject: "A &amp; B",
            from: "Sender",
            to: [],
            snippet: "Hello",
            receivedAt: "2026-10-16T00:00:00Z",
            isUnread: true,
          },
        ],
        syncedAt: "2026-10-16T00:00:00Z",
      });
    if (u.pathname.endsWith("/read"))
      return Response.json({
        message: {
          externalId: "mail1",
          threadId: "thread1",
          subject: messageSubject,
          from: "Sender",
          to: [],
          snippet: "Hello",
          receivedAt: "2026-10-16T00:00:00Z",
          isUnread: true,
        },
        bodyText: messageBody,
      });
    if (u.pathname.endsWith("/calendars")) {
      if (retireAfterCalendars) current = false;
      return Response.json([
        {
          calendarId: "primary",
          summary: "Owned",
          primary: true,
          selected: true,
          accessRole: accounts ? "reader" : "owner",
        },
      ]);
    }
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname.endsWith("/operations")) {
      const review = { from: "owned@example.invalid", ...body.proposal },
        reviewDigest = createHash("sha256")
          .update(JSON.stringify(review))
          .digest("hex");
      const receipt = {
        requestId: body.requestId,
        kind: "send",
        state: "prepared",
        reviewDigest,
        providerResult: null,
        rejectionCode: null,
      };
      receipts.set(body.requestId, { receipt, proposal: body.proposal });
      return Response.json({
        version: 1,
        providerExactlyOnce: false,
        receipt,
        review,
      });
    }
    const id = u.pathname.split("/").at(init.method === "POST" ? -2 : -1),
      saved = receipts.get(id);
    if (saved) {
      if (init.method === "POST") {
        dispatches++;
        assert.equal(body.reviewDigest, saved.receipt.reviewDigest);
        assert.deepEqual(body.proposal, saved.proposal);
        saved.receipt = {
          ...saved.receipt,
          state: "succeeded",
          providerResult: { messageId: "accepted-mail" },
        };
      }
      return Response.json({
        version: 1,
        providerExactlyOnce: false,
        receipt: saved.receipt,
      });
    }
    throw Error("Unexpected fixture route");
  };
  const host = await startNativeGoogleAgentHost({
    ...hostOptions,
    access,
    gmailReadBodyMaxCharacters,
    binding: binding(),
    apiToken,
    request,
    assertCurrent() {
      if (!current) throw Error("Native owner retired");
    },
  });
  const call = async (body, headers = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${host.port}/__alpha-owner-gmail`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
          ...headers,
        },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  return {
    host,
    call,
    calls,
    receipts,
    dispatches: () => dispatches,
    messageBody: (value) => {
      messageBody = value;
    },
    messageSubject: (value) => {
      messageSubject = value;
    },
    retire: () => {
      current = false;
    },
    otherOwner: () => {
      otherOwner = true;
    },
  };
}
test("native HTTP host uses the SDK token and prepares, dispatches and reads one immutable send receipt", async () => {
  const f = await fixture();
  try {
    const read = await f.call({ limit: 1 });
    assert.equal(read.status, 200);
    assert.equal(read.data.items[0].threadTopic, "A & B");
    const messageId = read.data.items[0].id;
    const fullBody = `${"complete message 😀 ".repeat(3000)}End of message`;
    f.messageBody(fullBody);
    const message = await f.call({ messageId });
    assert.equal(message.status, 200);
    assert.equal(message.data.message.bodyText, fullBody);
    assert.equal(Object.hasOwn(message.data.message, "truncated"), false);
    f.messageBody("x".repeat(256 * 1024));
    const oversized = await f.call({ messageId });
    assert.equal(oversized.status, 409);
    assert.equal(oversized.data.reason, "result-too-large");
    assert.equal(oversized.data.message, undefined);
    const calendars = await f.call({ calendar: { operation: "sources" } });
    assert.equal(calendars.status, 200);
    assert.equal(calendars.data.calendars[0].calendarId, "primary");
    const content = {
      requestId: randomUUID(),
      to: ["self@example.invalid"],
      subject: "Native QA",
      bodyText: "Synthetic only",
    };
    const prepared = await f.call({
      send: { operation: "prepare", ...content },
    });
    assert.equal(prepared.status, 200);
    assert.equal(f.dispatches(), 0);
    const { id, reviewDigest } = prepared.data.send;
    const send = {
      operation: "dispatch",
      id,
      reviewDigest,
      to: content.to,
      subject: content.subject,
      bodyText: content.bodyText,
    };
    assert.equal((await f.call({ send })).data.send.state, "succeeded");
    assert.equal((await f.call({ send })).data.send.state, "succeeded");
    assert.equal(f.dispatches(), 1);
    assert.equal(
      (await f.call({ send: { operation: "receipt", id } })).data.send
        .providerResult.messageId,
      "accepted-mail",
    );
  } finally {
    await f.host.close();
  }
});
test("configured native Gmail limits mark truncation without splitting a Unicode character", async () => {
  for (const maximum of [32_000, 7]) {
    const f = await fixture({ gmailReadBodyMaxCharacters: maximum });
    try {
      const messageId = (await f.call({ limit: 1 })).data.items[0].id;
      for (const [body, expected, truncated] of [
        ["a".repeat(maximum), "a".repeat(maximum), false],
        ["a".repeat(maximum + 1), "a".repeat(maximum), true],
        [`${"a".repeat(maximum - 1)}😀tail`, "a".repeat(maximum - 1), true],
        [`${"a".repeat(maximum - 2)}😀`, `${"a".repeat(maximum - 2)}😀`, false],
        ["x".repeat(256 * 1024), "x".repeat(maximum), true],
      ]) {
        f.messageBody(body);
        const result = await f.call({ messageId });
        assert.equal(result.status, 200);
        assert.equal(result.data.message.bodyText, expected);
        assert.equal(
          Object.hasOwn(result.data.message, "truncated"),
          truncated,
        );
        if (truncated) assert.equal(result.data.message.truncated, true);
      }
      // A caller's body limit does not waive the complete response bound.
      f.messageBody("A complete message");
      f.messageSubject("x".repeat(256 * 1024));
      const oversized = await f.call({ messageId });
      assert.equal(oversized.status, 409);
      assert.equal(oversized.data.reason, "result-too-large");
      assert.equal(oversized.data.message, undefined);
      assert.equal(f.dispatches(), 0);
    } finally {
      await f.host.close();
    }
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      fixture({ gmailReadBodyMaxCharacters: invalid }),
      /gmailReadBodyMaxCharacters must be a positive safe integer/,
    );
  }
});
test("native host refuses foreign callers, browser origins, wrong Cloud owners and retired native bindings", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.call({ limit: 1 }, { Authorization: "Bearer wrong" })).status,
      401,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.call({ limit: 1 }, { Origin: "https://example.invalid" }))
        .status,
      403,
    );
    assert.equal(f.calls.length, 0);
    f.otherOwner();
    assert.equal((await f.call({ limit: 1 })).status, 409);
    assert.deepEqual(f.calls, ["/api/v1/user"]);
    f.retire();
    assert.equal((await f.call({ limit: 1 })).status, 409);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.host.close();
  }
});
test("native service port never becomes a general Cloud or credential proxy", async () => {
  let calls = 0;
  const options = {
    ...hostOptions,
    assertCurrent() {},
    request: async () => {
      calls++;
      throw Error("No request expected");
    },
  };
  for (const apiOrigin of [
    "http://api.eliza.app",
    "https://user:secret@api.eliza.app",
    "https://api.eliza.app/api/v1",
  ])
    assert.throws(
      () => createNativeGoogleCloudPort(binding(), { ...options, apiOrigin }),
      /Invalid Cloud API origin/,
    );
  const port = createNativeGoogleCloudPort(binding(), options);
  const credential = await port.agentCredential();
  for (const url of [
    "https://api-staging.eliza.app/api/v1/user",
    "https://api.eliza.app/api/v1/api-keys/current",
    "https://example.invalid/api/v1/user",
  ])
    await assert.rejects(
      port.agentGmailOperation({
        url,
        method: "GET",
        credentialReference: credential.credentialReference,
        signal: AbortSignal.timeout(1000),
      }),
    );
  assert.equal(calls, 0);
});

test("shared private broker validates tokens before startup and closes idempotently", async () => {
  const port = {
    async agentCredential() {
      throw Error("No credential read expected");
    },
    async agentRead() {
      throw Error("No provider read expected");
    },
    async agentGmailOperation() {
      throw Error("No provider write expected");
    },
    async agentCalendarOperation() {
      throw Error("No provider write expected");
    },
  };
  await assert.rejects(
    startManagedGoogleAgentHost({ ...hostOptions, port, apiToken: "invalid" }),
    /authentication is unavailable/,
  );
  const host = await startManagedGoogleAgentHost({
    ...hostOptions,
    port,
    apiToken: "a".repeat(64),
    access: () => ({ gmailChanges: false, calendarEdits: false }),
  });
  await Promise.all([host.close(), host.close()]);
  await host.close();
});

test("native Calendar sources bind exact verified Google connections, not duplicate account labels", async () => {
  const second = "55555555-5555-4555-8555-555555555555";
  const accounts = [grant, second].map((connectionId) => ({
    configured: true,
    connected: true,
    reason: "connected",
    connectionId,
    identity: { email: "same@example.invalid" },
    grantedCapabilities: ["google.calendar.read"],
  }));
  const f = await fixture({ accounts });
  try {
    const result = await f.call({ calendar: { operation: "sources" } });
    assert.equal(result.status, 200);
    const sources = result.data.calendars;
    assert.deepEqual(
      sources.map((s) => s.managedGoogleConnectionId),
      [grant, second],
    );
    assert.notEqual(sources[0].grantId, sources[1].grantId);
    assert.equal(sources[0].calendarId, sources[1].calendarId);
    for (const source of sources) {
      assert.equal(source.connectorAccountId, source.grantId);
      assert.equal(source.accessRole, "reader");
      assert.equal(source.write, undefined);
    }
    const encoded = JSON.stringify(sources);
    for (const secret of [
      binding().token,
      binding().credentialId,
      binding().sessionGeneration,
    ])
      assert.equal(encoded.includes(secret), false);
  } finally {
    await f.host.close();
  }
});
test("native Calendar sources publish no stale association after owner retirement during discovery", async () => {
  const f = await fixture({ retireAfterCalendars: true });
  try {
    const result = await f.call({ calendar: { operation: "sources" } });
    assert.equal(result.status, 409);
    assert.equal(result.data.calendars, undefined);
  } finally {
    await f.host.close();
  }
});

test("switches revoke Gmail and Calendar writes before provider dispatch", async () => {
  let enabled = true;
  const f = await fixture({
    access: () => ({ gmailChanges: enabled, calendarEdits: enabled }),
  });
  try {
    const content = {
      requestId: randomUUID(),
      to: ["self@example.invalid"],
      subject: "Native QA",
      bodyText: "Synthetic only",
    };
    const prepared = await f.call({
      send: { operation: "prepare", ...content },
    });
    assert.equal(prepared.status, 200);
    const { id, reviewDigest } = prepared.data.send;
    enabled = false;
    const before = f.calls.length;
    const blocked = await f.call({
      send: {
        operation: "dispatch",
        id,
        reviewDigest,
        to: content.to,
        subject: content.subject,
        bodyText: content.bodyText,
      },
    });
    assert.equal(blocked.data.reason, "changes-off");
    const calendar = await f.call({
      calendar: {
        operation: "write-capabilities",
        grantId: "ignored",
        calendarId: "primary",
      },
    });
    assert.equal(calendar.data.reason, "changes-off");
    assert.equal(f.calls.length, before);
    assert.equal(f.dispatches(), 0);
    const receipt = await f.call({ send: { operation: "receipt", id } });
    assert.equal(receipt.data.send.state, "prepared");
  } finally {
    await f.host.close();
  }
});
