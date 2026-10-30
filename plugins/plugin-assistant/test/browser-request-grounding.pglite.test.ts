import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  AgentRuntime,
  conversationClientUserMemoryId,
  type IDatabaseAdapter,
  type Memory,
  type PlannerToolResult,
  runWithStreamingContext,
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
  DEVICE_APPROVAL_REVIEW_TEXT,
  isPersistedDeviceApprovalPause,
  isRequestedDeviceHandoff,
} from "../src/services/device-actions/effect-receipts.ts";
import {
  DeviceActionService,
  setDeviceReadReplyContext,
  setDeviceReadReplyConversation,
} from "../src/services/device-actions/service.ts";
import { deviceActionTools } from "../src/services/device-actions/tools.ts";
import { withOwnerDeviceActionTurn } from "./device-owner-turn.ts";

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

async function fixture() {
  const pg = new PGlite();
  await createTable(pg, approvalRequestTable);
  await createTable(pg, approvalDispatchControlTable);
  await pg.exec(
    "CREATE UNIQUE INDEX approval_unique ON approval_requests(agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL;CREATE TABLE original_memories(id uuid PRIMARY KEY,data jsonb NOT NULL);CREATE TABLE client_devices(agent_id uuid,subject_user_id text,installation_id text,enrollment_id uuid,key_hash text,label text,workflow_protocol integer NOT NULL DEFAULT 0,view_profile text,workflow_owner_id text,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(agent_id,subject_user_id,installation_id));",
  );
  const runtime = new AgentRuntime({
    character: { name: "Browser grounding fixture", bio: [] },
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter({
    db: drizzle(pg),
  } as unknown as IDatabaseAdapter);
  const notify = vi.fn();
  Object.assign(runtime, {
    getService: (type: string) => (type === "notification" ? { notify } : null),
    redactSecrets: (v: string) => v,
    getSetting: () => null,
  });
  const owner = randomUUID(),
    room = randomUUID() as UUID;
  const credential = {
    subjectUserId: owner,
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
  };
  const service = new DeviceActionService(runtime);
  await service.register(credential, "Synthetic closed browser");
  const browser = deviceActionTools.find(
    (a) => a.name === "DEVICE_BROWSER_OPEN",
  )!;
  runtime.registerAction(proposeDeviceAction);
  runtime.registerAction(browser);
  const enqueue = vi.spyOn(PgApprovalQueue.prototype, "enqueueTransactional");
  const decide = vi.spyOn(DeviceActionService.prototype, "decide");
  async function run(
    request: string,
    specialized = false,
    direct = false,
    destination = "https://example.com/dashboard",
    custody = "current",
  ) {
    let current = true;
    return withOwnerDeviceActionTurn(
      runtime,
      credential,
      async () => {
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
            source:
              custody === "voice"
                ? "voice"
                : custody === "lifecycle"
                  ? "voice_lifecycle"
                  : "client_chat",
            role: custody === "system" ? "system" : "user",
            chatIdempotency: {
              version: 1,
              scope,
              clientMessageId: nonce,
              fingerprint: "e".repeat(64),
            },
            metadata: direct ? { agentActionMode: "direct-request-v1" } : {},
          },
        };
        await pg.query("INSERT INTO original_memories VALUES($1,$2)", [
          original.id,
          JSON.stringify(original),
        ]);
        vi.spyOn(runtime, "getMemoryById").mockImplementation(async (id) => {
          if (custody === "stale") current = false;
          if (custody === "rebound") credential.deviceKey = "b".repeat(64);
          if (custody === "missing") return null;
          const stored = (
            await pg.query<{ data: Memory }>(
              "SELECT data FROM original_memories WHERE id=$1",
              [id],
            )
          ).rows[0]?.data;
          if (!stored) return null;
          if (custody === "changed")
            stored.content.text = "open example.com/changed";
          return id === original.id ? stored : null;
        });
        setDeviceReadReplyConversation(runtime, randomUUID(), room);
        setDeviceReadReplyContext(runtime, original, {
          id: original.id!,
          events: [],
        });
        if (custody === "old") original.createdAt! -= 1000;
        const action = runtime.actions.find(
          (a) =>
            a.name ===
            (specialized ? "DEVICE_BROWSER_OPEN" : "PROPOSE_DEVICE_ACTION"),
        )!;
        const options = {
          parameters: {
            operation: { type: "browser_navigate", url: destination },
            operationKey: randomUUID(),
            reason: "Planner claims browser needed for Calendar",
          },
        };
        const invoke = () =>
          runWithStreamingContext(
            custody === "aborted"
              ? { abortSignal: AbortSignal.abort() }
              : undefined,
            () => action.handler!(runtime, original, undefined, options),
          );
        if (custody === "replay") await invoke();
        return invoke();
      },
      { isCurrent: () => current },
    );
  }
  return { pg, runtime, service, credential, notify, enqueue, decide, run };
}

it.each([false, true])(
  "refuses invented Calendar navigation before queue for specialized=%s",
  async (specialized) => {
    const f = await fixture();
    try {
      const result = await f.run(
        "make another one for breakfast at 11 am",
        specialized,
      );
      expect(result).toMatchObject({
        success: false,
        data: {
          code: "DEVICE_BROWSER_NOT_REQUESTED",
          proposalCreated: false,
          executed: false,
          retryable: false,
        },
      });
      expect(f.enqueue).not.toHaveBeenCalled();
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(
        (
          await f.pg.query(
            "SELECT count(*)::int AS count FROM approval_requests",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(result).not.toHaveProperty("effectReceipts");
    } finally {
      await f.pg.close();
    }
  },
);

it.each([false, true])(
  "keeps exact explicit navigation working for specialized=%s",
  async (specialized) => {
    const f = await fixture();
    try {
      const result = await f.run(
        'open "https://example.com/a?q=1#one"',
        specialized,
        false,
        "https://example.com/a?q=1#one",
      );
      expect(result).toMatchObject({ success: true });
      expect(f.enqueue).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.pg.query(
            "SELECT count(*)::int AS count FROM approval_requests",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(f.decide).not.toHaveBeenCalled();
    } finally {
      await f.pg.close();
    }
  },
);
it.each([
  "stale",
  "rebound",
  "missing",
  "changed",
  "old",
  "system",
  "lifecycle",
  "aborted",
])("refuses invalid durable origin %s before persistence", async (custody) => {
  const f = await fixture();
  try {
    if (["missing", "changed", "old"].includes(custody)) {
      expect(
        await f.run(
          "open example.com/dashboard",
          false,
          false,
          undefined,
          custody,
        ),
      ).toMatchObject({
        success: false,
        data: { code: "DEVICE_BROWSER_NOT_REQUESTED" },
      });
    } else
      await expect(
        f.run("open example.com/dashboard", false, false, undefined, custody),
      ).rejects.toThrow();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
    expect(
      (await f.pg.query("SELECT count(*)::int AS count FROM approval_requests"))
        .rows,
    ).toEqual([{ count: 0 }]);
  } finally {
    await f.pg.close();
  }
});

it.each([false, true])(
  "preserves exact direct request mode=%s without fabricated decisions",
  async (direct) => {
    const f = await fixture();
    try {
      const result = await f.run("example.com/dashboard", false, direct);
      // Direct mode: the requesting phone opens it after the reply, with no
      // review card or review text. Review mode keeps the owner approval pause.
      expect(result).toMatchObject(
        direct
          ? {
              success: true,
              userFacingText: "Opening example.com.",
              data: {
                state: "pending",
                executed: false,
                awaitingDeviceExecution: true,
                directRequest: true,
                approvalRequired: false,
              },
            }
          : {
              success: true,
              userFacingText: DEVICE_APPROVAL_REVIEW_TEXT,
              data: { awaitingUserInput: true, approvalRequired: true },
            },
      );
      expect(result.data).not.toHaveProperty(
        direct ? "awaitingUserInput" : "directRequest",
      );
      expect(isRequestedDeviceHandoff(result as PlannerToolResult)).toBe(
        direct,
      );
      expect(isPersistedDeviceApprovalPause(result as PlannerToolResult)).toBe(
        !direct,
      );
      expect(
        (
          await f.pg.query(
            "SELECT count(*)::int AS count FROM approval_requests",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(f.decide).not.toHaveBeenCalled();
    } finally {
      await f.pg.close();
    }
  },
);
it("accepts a fresh durably bound voice user message, never a lifecycle message", async () => {
  const f = await fixture();
  try {
    const result = await f.run(
      "open example.com/dashboard",
      true,
      false,
      undefined,
      "voice",
    );
    expect(result).toMatchObject({ success: true });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  } finally {
    await f.pg.close();
  }
});
it("does not treat a matching hostname as authority for a different path", async () => {
  const f = await fixture();
  try {
    const result = await f.run("open example.com/different", true);
    expect(result).toMatchObject({
      success: false,
      data: { code: "DEVICE_BROWSER_NOT_REQUESTED" },
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  } finally {
    await f.pg.close();
  }
});

it("replays the same operation key without a second durable proposal", async () => {
  const f = await fixture();
  try {
    const result = await f.run(
      "open example.com/dashboard",
      false,
      false,
      undefined,
      "replay",
    );
    expect(result).toMatchObject({ success: true });
    expect(
      (await f.pg.query("SELECT count(*)::int AS count FROM approval_requests"))
        .rows,
    ).toEqual([{ count: 1 }]);
    expect(f.decide).not.toHaveBeenCalled();
  } finally {
    await f.pg.close();
  }
});

it("refuses an unbound service caller without creating a review", async () => {
  const f = await fixture();
  try {
    await expect(
      f.service.proposeWithOutcome(
        f.credential,
        { type: "browser_navigate", url: "https://example.com/" },
        "unbound-browser",
        "Planner-provided justification is not authority",
      ),
    ).rejects.toMatchObject({ code: "DEVICE_BROWSER_NOT_REQUESTED" });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
    expect(
      (await f.pg.query("SELECT count(*)::int AS count FROM approval_requests"))
        .rows,
    ).toEqual([{ count: 0 }]);
  } finally {
    await f.pg.close();
  }
});
