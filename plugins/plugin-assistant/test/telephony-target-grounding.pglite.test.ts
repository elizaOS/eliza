import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  AgentRuntime,
  bindIncomingMessagePersistence,
  conversationClientUserMemoryId,
  type IDatabaseAdapter,
  type Memory,
  runWithTrajectoryContext,
  SecretSwapSession,
  type UUID,
} from "@elizaos/core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, expect, it, vi } from "vitest";
import { approvalDispatchControlTable } from "../../plugin-sql/src/schema/approvalDispatchControl.ts";
import { approvalRequestTable } from "../../plugin-sql/src/schema/approvalRequests.ts";
import { PgApprovalQueue } from "../src/services/approval/store.ts";
import { proposeDeviceAction } from "../src/services/device-actions/action.ts";
import {
  DeviceActionService,
  setDeviceReadReplyContext,
  setDeviceReadReplyConversation,
} from "../src/services/device-actions/service.ts";
import { withOwnerDeviceActionTurn } from "./device-owner-turn.ts";

/**
 * A call, dial, text or keypad prefill names the recipient the owner wrote in
 * this message. v612 (Pixel): "call 415-555-0100" was proposed, reviewed and
 * placed as a call to 6505715862, a number in no prompt, contact or memory.
 */
afterEach(() => vi.restoreAllMocks());
async function createTable(
  pg: PGlite,
  table: Parameters<typeof getTableConfig>[0],
  legacy = false,
) {
  const config = getTableConfig(table),
    dialect = new PgDialect();
  const literal = (v: unknown): string =>
    typeof v === "object" && v && "getSQL" in v
      ? dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql
      : typeof v === "object"
        ? `'${JSON.stringify(v)}'::jsonb`
        : typeof v === "string"
          ? `'${v.replaceAll("'", "''")}'`
          : String(v);
  await pg.exec(
    `CREATE TABLE ${config.name} (${config.columns
      .filter((c) => !legacy || c.name !== "device_read_completion")
      .map(
        (c) =>
          `${c.name} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? " DEFAULT " + literal(c.default) : ""}${c.primary ? " PRIMARY KEY" : ""}`,
      )
      .join(
        ",",
      )}${config.primaryKeys.length ? ", " + config.primaryKeys.map((k) => `PRIMARY KEY(${k.columns.map((c) => c.name).join(",")})`).join(",") : ""})`,
  );
}

const CAPABILITIES = [
  "phone.call.v1",
  "phone.dial.v1",
  "contacts.lookup.v1",
  "sms.compose.v1",
  "sms.compose.v2",
  "sms.send.v1",
  "phone.keypad.v1",
];

async function fixture(capabilities: string[] = CAPABILITIES) {
  const pg = new PGlite();
  await createTable(pg, approvalRequestTable);
  await createTable(pg, approvalDispatchControlTable);
  await pg.exec(
    "CREATE UNIQUE INDEX approval_unique ON approval_requests(agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL;CREATE TABLE original_memories(id uuid PRIMARY KEY,data jsonb NOT NULL);CREATE TABLE client_devices(agent_id uuid,subject_user_id text,installation_id text,enrollment_id uuid,key_hash text,label text,workflow_protocol integer NOT NULL DEFAULT 0,view_profile text,workflow_owner_id text,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(agent_id,subject_user_id,installation_id));",
  );
  const runtime = new AgentRuntime({
    character: { name: "Eliza", bio: [] },
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter({
    db: drizzle(pg),
  } as unknown as IDatabaseAdapter);
  Object.assign(runtime, {
    getService: (type: string) =>
      type === "notification" ? { notify: vi.fn() } : null,
    redactSecrets: (v: string) => v,
    getSetting: () => null,
  });
  const owner = randomUUID(),
    room = randomUUID() as UUID;
  const credential = {
    subjectUserId: owner,
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities,
  };
  await new DeviceActionService(runtime).register(
    credential,
    "Synthetic phone",
  );
  runtime.registerAction(proposeDeviceAction);
  const enqueue = vi.spyOn(PgApprovalQueue.prototype, "enqueueTransactional");
  async function run(
    request: string,
    operation: unknown,
    options: { document?: string; bound?: boolean } = {},
  ) {
    return withOwnerDeviceActionTurn(runtime, credential, async () => {
      const nonce = randomUUID(),
        scope = JSON.stringify([runtime.agentId, room, owner]);
      const original: Memory = {
        id: conversationClientUserMemoryId(scope, nonce),
        agentId: runtime.agentId,
        entityId: owner as UUID,
        roomId: room,
        createdAt: Date.now(),
        content: {
          text: request,
          source: "client_chat",
          channelType: "DM",
          chatIdempotency: {
            version: 1,
            scope,
            clientMessageId: nonce,
            fingerprint: "e".repeat(64),
          },
          metadata: { agentActionMode: "direct-request-v1" },
        },
      };
      await pg.query("INSERT INTO original_memories VALUES($1,$2)", [
        original.id,
        JSON.stringify(original),
      ]);
      vi.spyOn(runtime, "getMemoryById").mockImplementation(async (id) => {
        const stored = (
          await pg.query<{ data: Memory }>(
            "SELECT data FROM original_memories WHERE id=$1",
            [id],
          )
        ).rows[0]?.data;
        return stored && id === original.id ? stored : null;
      });
      setDeviceReadReplyConversation(runtime, randomUUID(), room);
      if (options.document !== undefined) {
        // The chat host's prompt-only document envelope, bound to the
        // persisted message as generateChatResponse binds it.
        bindIncomingMessagePersistence(original, structuredClone(original));
        original.content.text = [
          "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
          "",
          "<contextual_documents>",
          '<source title="Vendors" similarity="1.000">',
          options.document,
          "</source>",
          "</contextual_documents>",
          "",
          "<user_request>",
          request,
          "</user_request>",
        ].join("\n");
      }
      if (options.bound !== false)
        setDeviceReadReplyContext(runtime, original, {
          id: original.id!,
          events: [],
        });
      return proposeDeviceAction.handler!(runtime, original, undefined, {
        parameters: {
          operation,
          operationKey: randomUUID(),
          reason: "Call the number 415-555-0100",
        },
      });
    });
  }
  async function rows() {
    return (
      await pg.query<{ operation: unknown; reason: string }>(
        "SELECT payload->'operation' AS operation, reason FROM approval_requests ORDER BY created_at",
      )
    ).rows;
  }
  return { pg, enqueue, run, rows };
}

const call = (number: string) => ({
  type: "phone_call",
  target: { kind: "number", number },
});

async function refused(
  f: Awaited<ReturnType<typeof fixture>>,
  result: unknown,
) {
  expect(result).toMatchObject({
    success: false,
    verifiedUserFacing: true,
    data: {
      code: "DEVICE_TELEPHONY_TARGET_NOT_REQUESTED",
      proposalCreated: false,
      executed: false,
    },
  });
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual([]);
}

it("reviews the owner's number when the model invents another (v612)", async () => {
  const f = await fixture();
  try {
    const result = await f.run("call 415-555-0100", call("6505715862"));
    expect(result).toMatchObject({ success: true });
    expect(await f.rows()).toEqual([
      {
        operation: call("4155550100"),
        reason: "Call the recipient the owner wrote.",
      },
    ]);
  } finally {
    await f.pg.close();
  }
});

it.each([
  [
    "a matching number",
    "can you call 415-555-0100 when you get a sec",
    "4155550100",
  ],
  [
    "an added country code",
    "can you call 415-555-0100 when you get a sec",
    "+14155550100",
  ],
  [
    "an international number",
    "could you ring +44 20 7946 0958 after lunch",
    "+442079460958",
  ],
])("keeps %s in the owner's dial form", async (_label, request, proposed) => {
  const f = await fixture();
  try {
    expect(await f.run(request, call(proposed))).toMatchObject({
      success: true,
    });
    const [row] = await f.rows();
    expect(row.operation).toEqual(
      call(proposed === "+442079460958" ? "+442079460958" : "4155550100"),
    );
    // Not a whole-message command: the model's own reason is kept.
    expect(row.reason).toBe("Call the number 415-555-0100");
  } finally {
    await f.pg.close();
  }
});

it.each([
  ["a different number", "can you call 415-555-0100 when you get a sec"],
  ["no written number", "call the pharmacy back"],
])("refuses %s before persistence", async (_label, request) => {
  const f = await fixture();
  try {
    const result = await f.run(request, call("6505715862"));
    await refused(f, result);
    expect((result as { userFacingText: string }).userFacingText).toContain(
      "Nothing was called or sent",
    );
  } finally {
    await f.pg.close();
  }
});

// A voice request reaches grounding as its transcript: the owner's number is
// words or ASR fragments, never the digit string the model proposes.
it.each([
  ["call four one five, five five five, zero one zero zero", "4155550100"],
  ["call four one five five five five oh one double oh", "+14155550100"],
  ["call four one five 555 0100", "4155550100"],
  ["Call for 15. 5550160.", "4155550160"],
])("reviews the number the owner spoke: %s", async (request, proposed) => {
  const f = await fixture();
  try {
    expect(await f.run(request, call(proposed))).toMatchObject({
      success: true,
    });
    expect((await f.rows())[0].operation).toEqual(
      call(proposed.replace("+1", "")),
    );
  } finally {
    await f.pg.close();
  }
});

it.each([
  ["call four one five five five five oh one double oh", "6505715862"],
  ["call me at four", "4444444444"],
])("refuses digits the owner did not speak: %s", async (request, proposed) => {
  const f = await fixture();
  try {
    await refused(f, await f.run(request, call(proposed)));
  } finally {
    await f.pg.close();
  }
});

it("never takes an SMS recipient from a spoken body", async () => {
  const f = await fixture();
  try {
    await refused(
      f,
      await f.run(
        "send Sam a text: call me at four one five five five five oh one double oh",
        {
          type: "sms_compose",
          target: { kind: "number", number: "4155550100" },
          body: "Call me at 415-555-0100.",
        },
      ),
    );
  } finally {
    await f.pg.close();
  }
});

it("refuses a number that only a document carried", async () => {
  const f = await fixture();
  try {
    await refused(
      f,
      await f.run(
        "could you phone our vendor when you get a sec",
        call("6505715862"),
        {
          document: "Acme Supply main line: 650-571-5862",
        },
      ),
    );
  } finally {
    await f.pg.close();
  }
});

it("grounds a document-augmented message in the owner's own words", async () => {
  const f = await fixture();
  try {
    expect(
      await f.run("call 415-555-0100", call("6505715862"), {
        document: "Acme Supply main line: 650-571-5862",
      }),
    ).toMatchObject({ success: true });
    expect((await f.rows())[0].operation).toEqual(call("4155550100"));
  } finally {
    await f.pg.close();
  }
});

it("refuses when there is no bound original request", async () => {
  const f = await fixture();
  try {
    await refused(
      f,
      await f.run("call 415-555-0100", call("4155550100"), { bound: false }),
    );
  } finally {
    await f.pg.close();
  }
});

it("hands a named contact to the phone's own lookup", async () => {
  const f = await fixture();
  try {
    expect(await f.run("call shaw", call("6505715862"))).toMatchObject({
      success: true,
    });
    expect((await f.rows())[0].operation).toEqual({
      type: "phone_call",
      target: { kind: "contact", query: "shaw" },
    });
  } finally {
    await f.pg.close();
  }
});

it("refuses a named contact when the phone cannot look contacts up", async () => {
  const f = await fixture(["phone.dial.v1"]);
  try {
    await refused(
      f,
      await f.run("call shaw", {
        type: "phone_dial",
        target: { kind: "number", number: "6505715862" },
      }),
    );
  } finally {
    await f.pg.close();
  }
});

it("refuses a contact name the owner did not write", async () => {
  const f = await fixture();
  try {
    await refused(
      f,
      await f.run("call my landlord back today", {
        type: "phone_call",
        target: { kind: "contact", query: "Shaw" },
      }),
    );
  } finally {
    await f.pg.close();
  }
});

it("never takes an SMS recipient from the body", async () => {
  const f = await fixture();
  try {
    await refused(
      f,
      await f.run("send Sam a text: call me at 415-555-0100", {
        type: "sms_compose",
        target: { kind: "number", number: "4155550100" },
        body: "call me at 415-555-0100",
      }),
    );
    expect(
      await f.run("text Sam saying call me at 415-555-0100", {
        type: "sms_compose",
        target: { kind: "number", number: "4155550100" },
        body: "call me at 415-555-0100",
      }),
    ).toMatchObject({ success: true });
    expect(await f.rows()).toEqual([
      {
        operation: {
          type: "sms_compose",
          target: { kind: "contact", query: "Sam" },
          body: "call me at 415-555-0100",
        },
        reason: "Text the recipient the owner wrote.",
      },
    ]);
  } finally {
    await f.pg.close();
  }
});

it("prefills the keypad only with the owner's number", async () => {
  const f = await fixture();
  try {
    expect(
      await f.run("open the dialer and type 415 555 0100", {
        type: "phone_keypad",
        number: "6505715862",
      }),
    ).toMatchObject({ success: true });
    expect((await f.rows())[0].operation).toEqual({
      type: "phone_keypad",
      number: "4155550100",
    });
  } finally {
    await f.pg.close();
  }
});

it("refuses a keypad prefill the owner did not write", async () => {
  const f = await fixture();
  try {
    await refused(
      f,
      await f.run("show me the dialer with my office number on it", {
        type: "phone_keypad",
        number: "6505715862",
      }),
    );
  } finally {
    await f.pg.close();
  }
});

/**
 * Review (2026-11-20): "call an ambulance" with 911 proposed was refused as
 * "that number isn't one you wrote". It opens the empty keypad with no review,
 * and the owner is told to dial their local emergency number.
 */
it.each([
  ["call an ambulance", call("911")],
  ["call the police", { type: "phone_keypad", number: "911" }],
  [
    "call emergency services",
    {
      type: "phone_call",
      target: { kind: "contact", query: "emergency services" },
    },
  ],
])(
  "opens the keypad for the emergency request %s",
  async (request, operation) => {
    const f = await fixture();
    try {
      const result = await f.run(request, operation);
      expect(result).toMatchObject({
        success: true,
        userFacingText: expect.stringContaining(
          "Dial your local emergency number",
        ),
        data: { directRequest: true, approvalRequired: false },
      });
      expect((await f.rows())[0].operation).toEqual({ type: "phone_keypad" });
    } finally {
      await f.pg.close();
    }
  },
);

it("tells the owner to dial when the phone has no keypad", async () => {
  const f = await fixture(CAPABILITIES.filter((c) => c !== "phone.keypad.v1"));
  try {
    const result = await f.run("call an ambulance", call("911"));
    await refused(f, result);
    expect((result as { userFacingText: string }).userFacingText).toContain(
      "dial your local emergency number",
    );
  } finally {
    await f.pg.close();
  }
});

it("reviews a call to the emergency number the owner wrote", async () => {
  const f = await fixture();
  try {
    expect(await f.run("call 911", call("911"))).toMatchObject({
      success: true,
    });
    expect((await f.rows())[0].operation).toEqual(call("911"));
  } finally {
    await f.pg.close();
  }
});

it("looks up the owner's contact without trailing words", async () => {
  const f = await fixture();
  try {
    expect(
      await f.run("call mom again", {
        type: "phone_call",
        target: { kind: "contact", query: "mom" },
      }),
    ).toMatchObject({ success: true });
    expect((await f.rows())[0].operation).toEqual({
      type: "phone_call",
      target: { kind: "contact", query: "mom" },
    });
  } finally {
    await f.pg.close();
  }
});

it.each([
  ["call 415 - 555 - 0100", "Type the number again with digits only"],
  ["call the pharmacy back", "your message doesn't include a phone number"],
])("explains the refusal of %s truthfully", async (request, reply) => {
  const f = await fixture();
  try {
    const result = await f.run(request, call("4155550100"));
    await refused(f, result);
    expect((result as { userFacingText: string }).userFacingText).toContain(
      reply,
    );
  } finally {
    await f.pg.close();
  }
});

/**
 * v613 (Pixel): secret swap showed the planner "call __ELIZA_CONTACT_<s>_6__"
 * in place of the owner's number, and the model wrote 6505715862. The model
 * must copy the reference; the execution boundary restores it.
 */
function swapped(request: string, history = "") {
  const session = new SecretSwapSession();
  const prompt = session.substituteText(`${history}\n${request}`);
  const reference = session.entries.find((entry) => entry.kind === "phone")
    ?.placeholder as string;
  return { session, prompt, reference };
}

/** The model's raw arguments, restored as executePlannedToolCall restores them. */
function restored(session: SecretSwapSession, operation: unknown) {
  return session.restoreInValue(operation, { failOnUnresolved: true });
}

function inTurn<T>(session: SecretSwapSession, fn: () => Promise<T>) {
  return runWithTrajectoryContext(
    { secretSwapSession: session },
    fn,
  ) as Promise<T>;
}

const REQUEST = "can you call 415-555-0100 when you get a sec";

it("refuses invented digits for a swapped number and names its reference", async () => {
  const f = await fixture();
  try {
    const { session, prompt, reference } = swapped(REQUEST);
    expect(reference).toMatch(/^__ELIZA_CONTACT_[0-9a-f]+_\d+__$/);
    expect(prompt).not.toContain("415-555-0100");
    const result = await inTurn(session, () =>
      f.run(REQUEST, restored(session, call("6505715862"))),
    );
    await refused(f, result);
    const modelText = (result as { text: string }).text;
    expect(modelText).toContain(reference);
    expect(modelText).toContain("verbatim");
    // The owner sees an honest reply, never a reference.
    expect((result as { userFacingText: string }).userFacingText).not.toContain(
      "__ELIZA_",
    );
  } finally {
    await f.pg.close();
  }
});

it("accepts the copied reference and reviews the owner's number", async () => {
  const f = await fixture();
  try {
    const { session, reference } = swapped(REQUEST);
    const operation = restored(session, call(reference));
    expect(operation).toEqual(call("415-555-0100"));
    expect(
      await inTurn(session, () => f.run(REQUEST, operation)),
    ).toMatchObject({ success: true });
    expect((await f.rows())[0].operation).toEqual(call("4155550100"));
  } finally {
    await f.pg.close();
  }
});

it("accepts a country code before the copied reference", async () => {
  const f = await fixture();
  try {
    const { session, reference } = swapped(REQUEST);
    expect(
      await inTurn(session, () =>
        f.run(REQUEST, restored(session, call(`+1${reference}`))),
      ),
    ).toMatchObject({ success: true });
    expect((await f.rows())[0].operation).toEqual(call("4155550100"));
  } finally {
    await f.pg.close();
  }
});

it("accepts a contact target the owner named beside a swapped number", async () => {
  const f = await fixture();
  try {
    const request = "can you call Maya, she was asking about 415-555-0100";
    const { session } = swapped(request);
    const contact = {
      type: "phone_call",
      target: { kind: "contact", query: "Maya" },
    };
    expect(
      await inTurn(session, () => f.run(request, restored(session, contact))),
    ).toMatchObject({ success: true });
    expect((await f.rows())[0].operation).toEqual(contact);
  } finally {
    await f.pg.close();
  }
});

it("replays the v613 prompt: coordinates stay, the call is the owner's number", async () => {
  // History as the phone's planner saw it: an earlier Maps card, then the call.
  const history = [
    "user: where is the ferry building",
    "assistant: Here it is.",
    "[MAPSCARD]",
    JSON.stringify({
      kind: "place",
      name: "Ferry Building",
      latitude: 37.7955287,
      longitude: -122.3934801,
    }),
    "[/MAPSCARD]",
    "user: call 415-555-0100",
  ].join("\n");
  for (const proposed of ["6505715862", "__REFERENCE__"]) {
    const f = await fixture();
    try {
      const { session, prompt, reference } = swapped("", history);
      expect(prompt).toContain('"longitude":-122.3934801');
      expect(prompt).toContain('"latitude":37.7955287');
      expect(prompt).toContain(`user: call ${reference}`);
      expect(session.entries.map((entry) => entry.value)).toEqual([
        "415-555-0100",
      ]);
      const operation = restored(
        session,
        call(proposed === "__REFERENCE__" ? reference : proposed),
      );
      expect(
        await inTurn(session, () => f.run("call 415-555-0100", operation)),
      ).toMatchObject({ success: true });
      // Whatever the model wrote, the review is for the number the owner wrote.
      expect(await f.rows()).toEqual([
        {
          operation: call("4155550100"),
          reason: "Call the recipient the owner wrote.",
        },
      ]);
    } finally {
      await f.pg.close();
    }
  }
});

const CONTACT_CAPABILITIES = [
  ...CAPABILITIES,
  "contacts.write.v1",
  "contacts.write.v2",
];
const newContact = (number: string) => ({
  type: "contact_create",
  contact: {
    displayName: "Bob Lee",
    phoneNumbers: [number],
    emailAddresses: [],
  },
});

it("refuses an invented number in a new contact or a contact change (v612)", async () => {
  const request = "add a contact Bob Lee 415-555-0100";
  for (const operation of [
    newContact("6505715862"),
    {
      type: "contact_update",
      query: "Bob Lee",
      add: { phoneNumbers: ["6505715862"] },
    },
  ]) {
    const f = await fixture(CONTACT_CAPABILITIES);
    try {
      const { session, reference } = swapped(request);
      const result = await inTurn(session, () =>
        f.run(request, restored(session, operation)),
      );
      await refused(f, result);
      expect((result as { text: string }).text).toContain(reference);
      // The owner asked to save a contact: the reply says nothing was saved.
      expect((result as { userFacingText: string }).userFacingText).toContain(
        "Nothing was saved.",
      );
    } finally {
      await f.pg.close();
    }
  }
});

it("saves the owner's number typed with mixed separators, from its copied reference", async () => {
  for (const written of ["415-555 0100", "+1 415-555 0100"]) {
    const request = `add Bob Lee ${written} to my contacts`;
    const f = await fixture(CONTACT_CAPABILITIES);
    try {
      const { session, prompt, reference } = swapped(request);
      expect(prompt).not.toContain(written);
      expect(
        await inTurn(session, () =>
          f.run(request, restored(session, newContact(reference))),
        ),
      ).toMatchObject({ success: true });
      expect((await f.rows())[0].operation).toEqual(
        newContact(written.startsWith("+1") ? "+14155550100" : "4155550100"),
      );
    } finally {
      await f.pg.close();
    }
  }
});

it("leaves a contact whose message writes no number to the owner's review", async () => {
  const f = await fixture(CONTACT_CAPABILITIES);
  try {
    expect(
      await f.run(
        "save the pizza place as a contact",
        newContact("4155550100"),
      ),
    ).toMatchObject({ success: true });
    expect((await f.rows())[0].operation).toEqual(newContact("4155550100"));
  } finally {
    await f.pg.close();
  }
});
