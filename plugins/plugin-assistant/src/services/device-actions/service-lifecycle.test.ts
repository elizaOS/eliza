/** Every device proposal reaches a closing state through the real SQL queue. */
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  AgentRuntime,
  conversationClientUserMemoryId,
  type IDatabaseAdapter,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, expect, it, vi } from "vitest";
import { approvalDispatchControlTable } from "../../../../plugin-sql/src/schema/approvalDispatchControl.ts";
import { approvalRequestTable } from "../../../../plugin-sql/src/schema/approvalRequests.ts";
import { proposeDeviceAction } from "./action.ts";
import {
  DeviceActionService,
  deviceProposalDigest,
  setDeviceReadReplyContext,
  setDeviceReadReplyConversation,
  withDeviceActionTurn,
} from "./service.ts";

afterEach(() => vi.restoreAllMocks());

async function createTable(
  pg: PGlite,
  table: Parameters<typeof getTableConfig>[0],
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
      .map(
        (c) =>
          `${c.name} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${literal(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`,
      )
      .join(
        ",",
      )}${config.primaryKeys.length ? `, ${config.primaryKeys.map((k) => `PRIMARY KEY(${k.columns.map((c) => c.name).join(",")})`).join(",")}` : ""})`,
  );
}

const SMS = {
  type: "sms_send",
  recipients: ["+15555550123"],
  body: "Hi",
  subscriptionId: 3,
};

async function fixture(capabilities?: string[]) {
  const pg = new PGlite();
  await createTable(pg, approvalRequestTable);
  await createTable(pg, approvalDispatchControlTable);
  await pg.exec(
    "CREATE UNIQUE INDEX approval_unique ON approval_requests(agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL;CREATE TABLE original_memories(id uuid PRIMARY KEY,data jsonb NOT NULL);CREATE TABLE client_devices(agent_id uuid,subject_user_id text,installation_id text,enrollment_id uuid,key_hash text,label text,workflow_protocol integer NOT NULL DEFAULT 0,view_profile text,workflow_owner_id text,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(agent_id,subject_user_id,installation_id));",
  );
  const runtime = new AgentRuntime({
    character: { name: "Device lifecycle fixture", bio: [] },
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
  const owner = randomUUID();
  const credential = {
    subjectUserId: owner,
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    ...(capabilities ? { capabilities } : {}),
  };
  const service = new DeviceActionService(runtime);
  const { enrollmentId } = await service.register(
    credential,
    "Synthetic lifecycle phone",
  );
  runtime.registerAction(proposeDeviceAction);
  const state = async (id: string) =>
    (
      await pg.query<{ state: string }>(
        "SELECT state FROM approval_requests WHERE id=$1",
        [id],
      )
    ).rows[0]?.state;
  // The expiry is part of the reviewed digest, so time moves instead of the row.
  const lapse = () => {
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
  };
  /** propose -> approve -> claim, returning what a receipt needs. */
  const claimed = async (operation: unknown) => {
    const proposal = await service.propose(
      credential,
      operation,
      randomUUID(),
      "Lifecycle fixture",
    );
    const digest = deviceProposalDigest(proposal);
    await service.decide(credential, proposal.id, digest, true);
    const claim = await service.claim(credential, proposal.id, digest);
    const attemptId = claim.execution?.attemptId;
    if (!attemptId) throw Error("Expected an execution claim");
    return { id: proposal.id, digest, attemptId };
  };
  /** A direct-request turn invoking the registered action with this key. */
  const request = async (
    operationKey: string,
    times = 1,
    between?: () => Promise<void>,
  ) => {
    const room = randomUUID() as UUID;
    return withDeviceActionTurn(
      runtime,
      credential,
      async () => {
        const nonce = randomUUID(),
          scope = JSON.stringify([runtime.agentId, room, owner]);
        const id = conversationClientUserMemoryId(scope, nonce);
        const original: Memory = {
          id,
          agentId: runtime.agentId,
          entityId: owner as UUID,
          roomId: room,
          createdAt: Date.now(),
          content: {
            text: "open example.com/dashboard",
            source: "client_chat",
            role: "user",
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
        vi.spyOn(runtime, "getMemoryById").mockImplementation(
          async (id) =>
            (
              await pg.query<{ data: Memory }>(
                "SELECT data FROM original_memories WHERE id=$1",
                [id],
              )
            ).rows[0]?.data ?? null,
        );
        setDeviceReadReplyConversation(runtime, randomUUID(), room);
        setDeviceReadReplyContext(runtime, original, {
          id,
          events: [],
        });
        const results = [];
        for (let i = 0; i < times; i++) {
          if (i > 0) await between?.();
          results.push(
            await proposeDeviceAction.handler?.(runtime, original, undefined, {
              parameters: {
                operation: {
                  type: "browser_navigate",
                  url: "https://example.com/dashboard",
                },
                operationKey,
                reason: "Owner asked to open it",
              },
            }),
          );
        }
        return results;
      },
      {
        requestCaller: {
          subjectUserId: owner,
          entityId: owner as UUID,
          role: "OWNER",
        },
      },
    );
  };
  return {
    pg,
    runtime,
    service,
    credential,
    enrollmentId,
    state,
    lapse,
    claimed,
    request,
  };
}

it("rejects an approval whose claim never arrived, even after it lapses", async () => {
  const f = await fixture();
  try {
    for (const lapsed of [false, true]) {
      const proposal = await f.service.propose(
        f.credential,
        { type: "open_view", view: "home" },
        randomUUID(),
        "Lifecycle fixture",
      );
      const digest = deviceProposalDigest(proposal);
      await f.service.decide(f.credential, proposal.id, digest, true);
      if (lapsed) f.lapse();
      const rejected = await f.service.decide(
        f.credential,
        proposal.id,
        digest,
        false,
      );
      expect(rejected.state).toBe("rejected");
    }
  } finally {
    await f.pg.close();
  }
});

it("expires a lapsed approval on its late claim instead of leaving it approved", async () => {
  const f = await fixture();
  try {
    const proposal = await f.service.propose(
      f.credential,
      { type: "open_view", view: "home" },
      randomUUID(),
      "Lifecycle fixture",
    );
    const digest = deviceProposalDigest(proposal);
    await f.service.decide(f.credential, proposal.id, digest, true);
    f.lapse();
    await expect(
      f.service.claim(f.credential, proposal.id, digest),
    ).rejects.toThrow("Proposal cannot be claimed");
    expect(await f.state(proposal.id)).toBe("expired");
  } finally {
    await f.pg.close();
  }
});

it("answers an exact retry of a lapsed review that it expired, without a new row", async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const [first, retry] = await f.request(key, 2, async () => {
      await f.pg.query(
        "UPDATE approval_requests SET expires_at = now() - interval '1 minute'",
      );
    });
    expect(first).toMatchObject({ success: true });
    expect(retry).toMatchObject({
      success: false,
      userFacingText: "That request expired; ask again.",
      data: { code: "DEVICE_PROPOSAL_EXPIRED", state: "expired" },
    });
    expect(
      (
        await f.pg.query<{ state: string }>(
          "SELECT state FROM approval_requests",
        )
      ).rows,
    ).toEqual([{ state: "expired" }]);
  } finally {
    await f.pg.close();
  }
});

it("binds a direct request's operation key to that request", async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const [again, retried] = await f.request(key, 2);
    expect(retried.data?.proposalId).toBe(again.data?.proposalId);
    const [later] = await f.request(key);
    expect(later).toMatchObject({ success: true });
    expect(later.data?.proposalId).not.toBe(again.data?.proposalId);
    expect(
      (
        await f.pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM approval_requests",
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  } finally {
    await f.pg.close();
  }
});

it("settles a cancelled or denied SMS as not sent, with no review", async () => {
  const f = await fixture(["sms.send.v1"]);
  try {
    for (const status of ["cancelled", "denied"]) {
      const { id, digest, attemptId } = await f.claimed(SMS);
      const done = await f.service.receipt(
        f.credential,
        id,
        digest,
        attemptId,
        {
          outcome: "failed",
          operationId: id,
          result: {
            kind: "sms-send",
            operationId: id,
            subscriptionId: 3,
            bindingHash: createHash("sha256")
              .update(
                JSON.stringify({
                  body: SMS.body,
                  recipients: SMS.recipients,
                  subscriptionId: 3,
                  type: "sms_send",
                }),
              )
              .digest("hex"),
            status,
            parts: [],
            createdAt: Date.now(),
          },
        },
      );
      expect(done.state).toBe("done");
      expect(done.execution?.providerReceipt?.outcome).toBe("failed");
    }
  } finally {
    await f.pg.close();
  }
});

it.each([
  ["sms", ["sms.send.v1"], SMS],
  [
    "dial",
    ["phone.dial.v1"],
    { type: "phone_dial", target: { kind: "number", number: "+15555550123" } },
  ],
  ["clock", ["clock.handoff.v1"], { type: "clock_handoff", action: "show" }],
  [
    "notes",
    ["notes.local-record.v1"],
    { type: "create_note", title: "Trip", body: "Passport" },
  ],
])(
  "settles a %s operation the phone never dispatched",
  async (_label, capabilities, operation) => {
    const f = await fixture(capabilities as string[]);
    try {
      const { id, digest, attemptId } = await f.claimed(operation);
      const receipt = { outcome: "failed", code: "DEVICE_NOT_DISPATCHED" };
      const done = await f.service.receipt(
        f.credential,
        id,
        digest,
        attemptId,
        receipt,
      );
      expect(done.state).toBe("done");
      expect(done.execution?.providerReceipt).toEqual(receipt);
      // An exact repeat is idempotent.
      expect(
        (await f.service.receipt(f.credential, id, digest, attemptId, receipt))
          .state,
      ).toBe("done");
    } finally {
      await f.pg.close();
    }
  },
);

it("lets the owner close an SMS whose outcome nobody can prove", async () => {
  const f = await fixture(["sms.send.v1"]);
  try {
    const { id, digest, attemptId } = await f.claimed(SMS);
    const uncertain = await f.service.receipt(
      f.credential,
      id,
      digest,
      attemptId,
      { outcome: "unknown", operationId: id },
    );
    expect(uncertain.state).toBe("reconciliation_required");
    const resolution = { confirmed: true, outcome: "unresolved" };
    const closed = await f.service.reconcile(
      f.credential,
      id,
      digest,
      attemptId,
      resolution,
    );
    expect(closed.state).toBe("done");
    expect(closed.execution?.providerReceipt?.outcome).toBe("unknown");
    expect(closed.execution?.reconciliationReason).toBe(
      "owner-acknowledged-unresolved",
    );
    expect(
      (
        await f.service.reconcile(
          f.credential,
          id,
          digest,
          attemptId,
          resolution,
        )
      ).state,
    ).toBe("done");
  } finally {
    await f.pg.close();
  }
});

/** Insert a stored proposal row directly, as an older build or a later state would leave it. */
async function insertRow(
  f: Awaited<ReturnType<typeof fixture>>,
  state: string,
  operation: unknown,
  createdAt: Date,
  requestMessageId?: string,
) {
  const id = randomUUID();
  const done = state === "done";
  await f.pg.query(
    `INSERT INTO approval_requests (id,state,requested_by,subject_user_id,action,payload,channel,reason,idempotency_key,expires_at,
      execution_attempt_id,execution_provider,provider_idempotency_key,execution_claimed_at,dispatch_started_at,provider_receipt,
      agent_id,created_at,updated_at)
     VALUES ($1::uuid,$2,$3::text,$4,'device_action',$5::jsonb,'phone','fixture',$1::text,$6::timestamptz,$7::uuid,$8,$1::text,$9::timestamptz,$9::timestamptz,$10::jsonb,$3::uuid,$9,$9)`,
    [
      id,
      state,
      f.runtime.agentId,
      f.credential.subjectUserId,
      JSON.stringify({
        action: "device_action",
        version: 1,
        installationId: f.credential.installationId,
        enrollmentId: f.enrollmentId,
        ...(requestMessageId ? { requestMessageId } : {}),
        operation,
      }),
      new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
      done ? randomUUID() : null,
      done ? `device:${f.enrollmentId}` : null,
      createdAt.toISOString(),
      done
        ? JSON.stringify({ outcome: "applied", operationId: randomUUID() })
        : null,
    ],
  );
  return id;
}

it("lists siblings when one stored proposal no longer parses", async () => {
  const f = await fixture();
  try {
    const report = vi.spyOn(f.runtime, "reportError");
    const now = Date.now();
    const valid = await insertRow(
      f,
      "pending",
      { type: "open_view", view: "home" },
      new Date(now),
    );
    const corrupt = await insertRow(
      f,
      "pending",
      { type: "open_view", view: 7 },
      new Date(now - 1000),
    );
    const listed = await f.service.list(f.credential);
    expect(listed.map((row) => row.id)).toEqual([valid]);
    expect(report).toHaveBeenCalledWith(
      "device-actions:list",
      expect.anything(),
      { proposalId: corrupt },
    );
  } finally {
    await f.pg.close();
  }
});

it("lists all open work but only the newest fifty settled proposals", async () => {
  const f = await fixture();
  try {
    const start = Date.now() - 3_600_000;
    const open = await insertRow(
      f,
      "pending",
      { type: "open_view", view: "home" },
      new Date(start),
    );
    for (let i = 1; i <= 60; i++)
      await insertRow(
        f,
        "rejected",
        { type: "open_view", view: "home" },
        new Date(start + i * 1000),
      );
    const listed = await f.service.list(f.credential);
    expect(listed).toHaveLength(51);
    expect(listed.at(-1)?.id).toBe(open);
  } finally {
    await f.pg.close();
  }
});

it("finds recent note receipts behind many newer non-note completions", async () => {
  const f = await fixture(["notes.local-record.v1"]);
  try {
    const start = Date.now() - 3_600_000;
    const notes = [];
    for (let i = 0; i < 6; i++)
      notes.push(
        await insertRow(
          f,
          "done",
          { type: "create_note", title: `Note ${i}`, body: "Body" },
          new Date(start + i * 1000),
          randomUUID(),
        ),
      );
    for (let i = 0; i < 40; i++)
      await insertRow(
        f,
        "done",
        { type: "open_view", view: "home" },
        new Date(start + 10_000 + i * 1000),
        randomUUID(),
      );
    const found = await f.service.recentCompletedNotes(f.credential);
    expect(found.map((row) => row.id).sort()).toEqual([...notes].sort());
  } finally {
    await f.pg.close();
  }
});
