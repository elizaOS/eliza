import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  browserDestinationMatches,
  groundBrowserDestination,
} from "@elizaos/contracts/browser-request-grounding";
import {
  AgentRuntime,
  bindIncomingMessagePersistence,
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
    character: { name: "Eliza", bio: [] },
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
    operation: unknown = { type: "browser_navigate", url: destination },
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
        if (custody.startsWith("augmented")) {
          // The chat host's prompt-only document envelope, bound to the
          // persisted message as generateChatResponse binds it.
          bindIncomingMessagePersistence(original, structuredClone(original));
          original.content.text = [
            "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
            "",
            "<contextual_documents>",
            '<source title="Getting started" similarity="1.000">',
            "Q: I just opened Eliza — what do I do first?",
            "A: Take the interactive tutorial.",
            "</source>",
            "</contextual_documents>",
            "",
            "<user_request>",
            custody === "augmented" ? request : "open example.com/changed",
            "</user_request>",
          ].join("\n");
        }
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
            operation,
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
        // The planner also calls the routed open for the same address in the
        // same turn, with its own operation key.
        if (custody === "double") {
          const first = await invoke();
          const open = runtime.actions.find(
            (a) => a.name === "DEVICE_BROWSER_OPEN",
          )!;
          const second = await open.handler!(runtime, original, undefined, {
            parameters: {
              operation: {
                type: "browser_navigate",
                url: "wikipedia.org",
                newTab: true,
              },
              operationKey: randomUUID(),
              reason: "Open the address the owner typed",
            },
          });
          return { first, second };
        }
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
it.each([false, true])(
  "answers a requested photo without review text only in direct request mode=%s",
  async (direct) => {
    const f = await fixture();
    try {
      Object.assign(f.credential, {
        capabilities: ["camera.capture-photo.v1"],
      });
      const result = await f.run(
        "take a photo",
        false,
        direct,
        undefined,
        "current",
        { type: "camera_capture_photo" },
      );
      expect(result).toMatchObject(
        direct
          ? {
              success: true,
              userFacingText: "Opening Camera to take the photo.",
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
      expect(isRequestedDeviceHandoff(result as PlannerToolResult)).toBe(
        direct,
      );
      expect(isPersistedDeviceApprovalPause(result as PlannerToolResult)).toBe(
        !direct,
      );
    } finally {
      await f.pg.close();
    }
  },
);
// v610: "take a photo" matched a bundled FAQ line, so the planner's copy of
// the message was the document envelope. The owner's words still bind it.
it.each(["augmented", "augmented-other"] as const)(
  "binds a requested photo through a host-bound document envelope only to the owner's words (%s)",
  async (custody) => {
    const f = await fixture();
    try {
      Object.assign(f.credential, {
        capabilities: ["camera.capture-photo.v1", "camera.capture-lens.v1"],
      });
      const result = await f.run(
        "take a photo",
        false,
        true,
        undefined,
        custody,
        { type: "camera_capture_photo" },
      );
      const rows = (
        await f.pg.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM approval_requests",
        )
      ).rows;
      expect(rows).toHaveLength(1);
      if (custody === "augmented") {
        expect(result).toMatchObject({
          userFacingText: "Opening Camera to take the photo.",
          data: { directRequest: true, approvalRequired: false },
        });
        expect(rows[0].payload.requestMessageId).toEqual(expect.any(String));
      } else {
        // An envelope around other words is not the owner's message.
        expect(result).toMatchObject({
          userFacingText: DEVICE_APPROVAL_REVIEW_TEXT,
          data: { approvalRequired: true },
        });
        expect(rows[0].payload).not.toHaveProperty("requestMessageId");
      }
    } finally {
      await f.pg.close();
    }
  },
);
// v610: a Files review that lapsed at 04:21 was still pending in the phone's
// list and in approval_requests hours later.
it("lists a lapsed device review as expired, never as pending", async () => {
  const f = await fixture();
  try {
    Object.assign(f.credential, { capabilities: ["camera.capture-photo.v1"] });
    await f.run("take a photo", false, false, undefined, "current", {
      type: "camera_capture_photo",
    });
    const [proposal] = await f.service.list(f.credential);
    expect(proposal).toMatchObject({ state: "pending" });
    await f.pg.query(
      "UPDATE approval_requests SET expires_at = now() - interval '1 minute'",
    );
    const listed = await f.service.list(f.credential);
    expect(listed.map((request) => [request.id, request.state])).toEqual([
      [proposal.id, "expired"],
    ]);
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
it.each([false, true])(
  "opens a model proposal grounded in the typed address directly, in the user's spelling, for specialized=%s",
  async (specialized) => {
    const f = await fixture();
    try {
      const request = "Hey Eliza, can you open youtube.com for me?";
      // The model rewrote the address; the user's typed spelling opens.
      const result = await f.run(
        request,
        specialized,
        true,
        "https://www.youtube.com/",
      );
      expect(result).toMatchObject({
        success: true,
        userFacingText: "Opening youtube.com.",
        data: {
          state: "pending",
          directRequest: true,
          approvalRequired: false,
          awaitingDeviceExecution: true,
        },
      });
      expect(result.data).not.toHaveProperty("awaitingUserInput");
      expect(f.decide).not.toHaveBeenCalled();
      const rows = (
        await f.pg.query<{
          payload: { operation: { type: string; url: string } };
        }>("SELECT payload FROM approval_requests")
      ).rows;
      expect(rows.map((row) => row.payload.operation)).toEqual([
        { type: "browser_navigate", url: "https://youtube.com/" },
      ]);
      // The phone's recheck (client-coordinator) accepts exactly this stored
      // destination, and would refuse the model's spelling.
      const phoneAllows = (url: string) =>
        browserDestinationMatches(
          { type: "browser_navigate", url },
          groundBrowserDestination(request, url),
        );
      expect(phoneAllows(rows[0].payload.operation.url)).toBe(true);
      expect(phoneAllows("https://www.youtube.com/")).toBe(false);
    } finally {
      await f.pg.close();
    }
  },
);
it.each([
  ["can you open youtube.com for me?", "https://evil.com/", true],
  ["can you open youtube.com for me?", "https://youtube.com.evil.com/", true],
  ["open YouTube", "https://youtube.com/", false],
  ["can you open main.py", "https://main.py/", true],
  ["don't open youtube.com", "https://youtube.com/", true],
  ["Don't open or visit youtube.com", "https://youtube.com/", true],
  [
    "do not under any circumstances open youtube.com",
    "https://youtube.com/",
    true,
  ],
  ["open nytimes.com, not youtube.com", "https://youtube.com/", true],
  // A later correction of the same address is never outvoted.
  [
    "Open youtube.com. Actually, don't open youtube.com.",
    "https://youtube.com/",
    true,
  ],
  // Also when it is written in a form no address is read from.
  [
    "Open youtube.com. Actually, don't open **youtube.com**.",
    "https://youtube.com/",
    true,
  ],
  // A multiline message is never grounded, but its address was typed.
  ["Hey Eliza\nopen youtube.com", "https://youtube.com/", true],
  ["take me to L.A.", "https://l.a/", false],
  ["make another one for breakfast at 11 am", "https://example.com/", false],
] as const)(
  "refuses %s with model URL %s before persistence, with plain copy",
  async (request, destination, typed) => {
    for (const specialized of [false, true]) {
      const f = await fixture();
      try {
        const result = await f.run(request, specialized, true, destination);
        expect(result).toMatchObject({
          success: false,
          verifiedUserFacing: true,
          userFacingText: typed
            ? "I didn't open that address."
            : 'Tell me the address, like "open nytimes.com".',
          data: {
            code: "DEVICE_BROWSER_NOT_REQUESTED",
            proposalCreated: false,
            executed: false,
          },
        });
        expect(f.enqueue).not.toHaveBeenCalled();
        expect(f.decide).not.toHaveBeenCalled();
        expect(
          (
            await f.pg.query(
              "SELECT count(*)::int AS count FROM approval_requests",
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await f.pg.close();
      }
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
it.each([
  // "in the browser" and "in a new tab" are now part of the strict command
  // (the opens test above); a private tab is still the model's call.
  "Open example.com/dashboard in a private tab",
  "please open example.com/dashboard now",
  "I want to see example.com/dashboard",
  "Alpha, open example.com/dashboard",
])(
  "reviews a typed address that is not a direct request, and never says Opening: %s",
  async (request) => {
    const f = await fixture();
    try {
      const result = await f.run(request, false, true);
      expect(result).toMatchObject({
        success: true,
        userFacingText: DEVICE_APPROVAL_REVIEW_TEXT,
        data: { awaitingUserInput: true, approvalRequired: true },
      });
      expect(result.data).not.toHaveProperty("directRequest");
      const rows = (
        await f.pg.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM approval_requests",
        )
      ).rows;
      expect(rows).toHaveLength(1);
      // No bound request message: the phone shows an ordinary review card.
      expect(rows[0].payload).not.toHaveProperty("requestMessageId");
    } finally {
      await f.pg.close();
    }
  },
);
it("opens a request that names the host's assistant directly", async () => {
  const f = await fixture();
  try {
    f.runtime.character.name = "Alpha";
    expect(
      await f.run("Hey Alpha, open example.com/dashboard", false, true),
    ).toMatchObject({
      userFacingText: "Opening example.com.",
      data: { directRequest: true, approvalRequired: false },
    });
  } finally {
    await f.pg.close();
  }
});
it("opens a typed http:// address over HTTPS", async () => {
  const f = await fixture();
  try {
    expect(
      await f.run("open http://example.com", false, true, "http://example.com"),
    ).toMatchObject({
      userFacingText: "Opening example.com.",
      data: { directRequest: true },
    });
    const rows = (
      await f.pg.query<{ payload: { operation: unknown } }>(
        "SELECT payload FROM approval_requests",
      )
    ).rows;
    expect(rows.map((row) => row.payload.operation)).toEqual([
      { type: "browser_navigate", url: "https://example.com/" },
    ]);
  } finally {
    await f.pg.close();
  }
});
it.each([
  // [request, model operation, negotiated, stored operation]
  // The owner's v609 turn: "open wikipedia.org in a new tab" became an empty
  // browser_tab_new. The owner's own words now place the address in a new tab
  // even when the model leaves newTab out.
  [
    "open wikipedia.org in a new tab",
    { type: "browser_navigate", url: "wikipedia.org" },
    true,
    { type: "browser_navigate", url: "https://wikipedia.org/", newTab: true },
  ],
  [
    "open wikipedia.org in a new tab",
    { type: "browser_navigate", url: "wikipedia.org", newTab: true },
    true,
    { type: "browser_navigate", url: "https://wikipedia.org/", newTab: true },
  ],
  // "In the browser" is the strict open itself, in whatever tab the phone picks.
  [
    "open example.com in the browser",
    { type: "browser_navigate", url: "example.com" },
    true,
    { type: "browser_navigate", url: "https://example.com/" },
  ],
  // The polite question keeps the owner's placement too.
  [
    "can you open wikipedia.org in a new tab?",
    { type: "browser_navigate", url: "wikipedia.org" },
    true,
    { type: "browser_navigate", url: "https://wikipedia.org/", newTab: true },
  ],
  // A phone that did not negotiate a new tab opens the address as before.
  [
    "open wikipedia.org in a new tab",
    { type: "browser_navigate", url: "wikipedia.org", newTab: true },
    false,
    { type: "browser_navigate", url: "https://wikipedia.org/" },
  ],
] as const)(
  "opens %s directly with the owner's placement (%o, negotiated=%s)",
  async (request, operation, negotiated, stored) => {
    const f = await fixture();
    try {
      if (negotiated)
        Object.assign(f.credential, {
          capabilities: ["browser.open-new-tab.v1"],
        });
      expect(
        await f.run(request, true, true, undefined, "current", operation),
      ).toMatchObject({
        userFacingText: `Opening ${new URL(stored.url).host}.`,
        data: { directRequest: true, approvalRequired: false },
      });
      const rows = (
        await f.pg.query<{ payload: { operation: unknown } }>(
          "SELECT payload FROM approval_requests",
        )
      ).rows;
      expect(rows.map((row) => row.payload.operation)).toEqual([stored]);
    } finally {
      await f.pg.close();
    }
  },
);
it.each([
  // [request, model query, direct mode, runs without a review]
  ["search for best pizza near me", "Best pizza near me", true, true],
  ["search for best pizza near me", "best pizza near me", false, false],
  ["what is the weather in Paris? search it", "weather in Paris", true, false],
] as const)(
  "searches the web only for words the user typed: %s",
  async (request, query, direct, handoff) => {
    const f = await fixture();
    try {
      Object.assign(f.credential, { capabilities: ["browser.search.v1"] });
      const result = await f.run(request, false, direct, undefined, "current", {
        type: "browser_search",
        query,
      });
      const typed = request.includes("pizza")
        ? "best pizza near me"
        : "weather in Paris";
      expect(result).toMatchObject(
        handoff
          ? {
              success: true,
              userFacingText: `Searching the web for “${typed}”.`,
              data: { directRequest: true, approvalRequired: false },
            }
          : {
              success: true,
              userFacingText: DEVICE_APPROVAL_REVIEW_TEXT,
              data: { awaitingUserInput: true, approvalRequired: true },
            },
      );
      const rows = (
        await f.pg.query<{ payload: { operation: unknown } }>(
          "SELECT payload FROM approval_requests",
        )
      ).rows;
      expect(rows.map((row) => row.payload.operation)).toEqual([
        { type: "browser_search", query: typed },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);
it("refuses a search for words the user did not type, and an unnegotiated Browser control", async () => {
  const f = await fixture();
  try {
    Object.assign(f.credential, { capabilities: ["browser.search.v1"] });
    expect(
      await f.run("search for cats", false, true, undefined, "current", {
        type: "browser_search",
        query: "cats and the owner's home address",
      }),
    ).toMatchObject({
      success: false,
      userFacingText:
        'Tell me the words to search for, like "search for weather in Paris".',
      data: { code: "DEVICE_BROWSER_NOT_REQUESTED", proposalCreated: false },
    });
    await expect(
      f.run("close this tab", false, true, undefined, "current", {
        type: "browser_tab_close",
      }),
    ).rejects.toThrow("Device operation capability unavailable");
    expect(f.enqueue).not.toHaveBeenCalled();
  } finally {
    await f.pg.close();
  }
});
const generic = "do that in the browser";
it.each([
  [
    { type: "browser_tab_new", private: true },
    "browser.tabs.v1",
    true,
    generic,
  ],
  [
    { type: "browser_tab_switch", target: "bbc" },
    "browser.tabs.v1",
    true,
    "switch to the BBC tab",
  ],
  [
    { type: "browser_find", text: "refund" },
    "browser.find.v1",
    true,
    "find refund on this page",
  ],
  // A tab word or find text the owner did not type is reviewed, so the
  // model cannot probe the owner's tabs or page without a card.
  [
    { type: "browser_tab_switch", target: "chase" },
    "browser.tabs.v1",
    false,
    "summarize what I was reading",
  ],
  [{ type: "browser_find", text: "refund" }, "browser.find.v1", false, generic],
  [
    { type: "browser_history", action: "stop" },
    "browser.history.v1",
    true,
    generic,
  ],
  // Closing a tab is reviewed even when the owner asked for it directly.
  [
    { type: "browser_tab_close", target: "bbc" },
    "browser.tabs.v1",
    false,
    "close the bbc tab",
  ],
] as const)(
  "queues the negotiated Browser control %o",
  async (operation, capability, handoff, request) => {
    const f = await fixture();
    try {
      Object.assign(f.credential, { capabilities: [capability] });
      for (const direct of [true, false]) {
        const result = await f.run(
          request,
          false,
          direct,
          undefined,
          "current",
          operation,
        );
        expect(result).toMatchObject(
          direct && handoff
            ? {
                success: true,
                userFacingText: "Doing that in Browser.",
                data: { directRequest: true, approvalRequired: false },
              }
            : {
                success: true,
                userFacingText: DEVICE_APPROVAL_REVIEW_TEXT,
                data: { awaitingUserInput: true, approvalRequired: true },
              },
        );
      }
    } finally {
      await f.pg.close();
    }
  },
);
it.each([
  // [request, model operation, capabilities, stored operation, reply]
  // The owner's v610 turn (Pixel): the model still proposed an empty
  // browser_tab_new for "open wikipedia.org in a new tab", and the phone showed
  // a blank New tab with "Opened a new tab.". The owner's words open the address.
  [
    "open wikipedia.org in a new tab",
    { type: "browser_tab_new" },
    ["browser.tabs.v1", "browser.open-new-tab.v1"],
    { type: "browser_navigate", url: "https://wikipedia.org/", newTab: true },
    "Opening wikipedia.org.",
  ],
  [
    "open wikipedia.org in a new tab",
    { type: "browser_tab_new", private: false },
    ["browser.tabs.v1", "browser.open-new-tab.v1"],
    { type: "browser_navigate", url: "https://wikipedia.org/", newTab: true },
    "Opening wikipedia.org.",
  ],
  [
    "can you open wikipedia.org in a new tab?",
    { type: "browser_tab_new" },
    ["browser.tabs.v1", "browser.open-new-tab.v1"],
    { type: "browser_navigate", url: "https://wikipedia.org/", newTab: true },
    "Opening wikipedia.org.",
  ],
  // A phone that did not negotiate a new tab still opens the address.
  [
    "open wikipedia.org in a new tab",
    { type: "browser_tab_new" },
    ["browser.tabs.v1"],
    { type: "browser_navigate", url: "https://wikipedia.org/" },
    "Opening wikipedia.org.",
  ],
  // No address, or a private tab, is still the empty tab the model proposed.
  [
    "open a new tab",
    { type: "browser_tab_new" },
    ["browser.tabs.v1", "browser.open-new-tab.v1"],
    { type: "browser_tab_new" },
    "Doing that in Browser.",
  ],
  [
    "open wikipedia.org in a new tab",
    { type: "browser_tab_new", private: true },
    ["browser.tabs.v1", "browser.open-new-tab.v1"],
    { type: "browser_tab_new", private: true },
    "Doing that in Browser.",
  ],
] as const)(
  "opens the typed address for an empty tab proposed for %s (%o)",
  async (request, operation, capabilities, stored, reply) => {
    const f = await fixture();
    try {
      Object.assign(f.credential, { capabilities: [...capabilities] });
      expect(
        await f.run(request, false, true, undefined, "current", operation),
      ).toMatchObject({
        success: true,
        userFacingText: reply,
        data: { directRequest: true, approvalRequired: false },
      });
      const rows = (
        await f.pg.query<{ payload: { operation: unknown } }>(
          "SELECT payload FROM approval_requests",
        )
      ).rows;
      expect(rows.map((row) => row.payload.operation)).toEqual([stored]);
    } finally {
      await f.pg.close();
    }
  },
);

it.each([
  // [request, custody, direct, stored operations]
  // Not a direct turn: the address still opens, after the owner's review,
  // never as an empty tab.
  [
    "open wikipedia.org in a new tab",
    "current",
    false,
    [{ type: "browser_navigate", url: "https://wikipedia.org/", newTab: true }],
  ],
  // Spoken, the same words open the same address.
  [
    "open wikipedia.org in a new tab",
    "voice",
    true,
    [{ type: "browser_navigate", url: "https://wikipedia.org/", newTab: true }],
  ],
  // A private tab and a negated or prose request keep the model's empty tab:
  // only the owner's whole-message open of an address becomes that open.
  [
    "open wikipedia.org in a new private tab",
    "current",
    true,
    [{ type: "browser_tab_new" }],
  ],
  [
    "don't open wikipedia.org in a new tab",
    "current",
    true,
    [{ type: "browser_tab_new" }],
  ],
  [
    "open a new tab, I'll go to wikipedia.org later",
    "current",
    true,
    [{ type: "browser_tab_new" }],
  ],
] as const)(
  "turns an empty tab for %s (%s, direct=%s) into an open only for the owner's own address",
  async (request, custody, direct, stored) => {
    const f = await fixture();
    try {
      Object.assign(f.credential, {
        capabilities: ["browser.tabs.v1", "browser.open-new-tab.v1"],
      });
      const result = await f.run(request, false, direct, undefined, custody, {
        type: "browser_tab_new",
      });
      expect(result).toMatchObject({ success: true });
      const rows = (
        await f.pg.query<{ payload: { operation: unknown } }>(
          "SELECT payload FROM approval_requests",
        )
      ).rows;
      expect(rows.map((row) => row.payload.operation)).toEqual(stored);
    } finally {
      await f.pg.close();
    }
  },
);
it("a stale turn never turns an empty tab into an open", async () => {
  const f = await fixture();
  try {
    Object.assign(f.credential, {
      capabilities: ["browser.tabs.v1", "browser.open-new-tab.v1"],
    });
    await f
      .run("open wikipedia.org in a new tab", false, true, undefined, "stale", {
        type: "browser_tab_new",
      })
      .catch(() => undefined);
    const rows = (
      await f.pg.query<{ payload: { operation: { type: string } } }>(
        "SELECT payload FROM approval_requests",
      )
    ).rows;
    expect(
      rows.filter((row) => row.payload.operation.type === "browser_navigate"),
    ).toEqual([]);
  } finally {
    await f.pg.close();
  }
});
it("opens the address once when the model proposes an empty tab and the routed open in one turn", async () => {
  const f = await fixture();
  try {
    Object.assign(f.credential, {
      capabilities: ["browser.tabs.v1", "browser.open-new-tab.v1"],
    });
    const { first, second } = (await f.run(
      "open wikipedia.org in a new tab",
      false,
      true,
      undefined,
      "double",
      { type: "browser_tab_new" },
    )) as unknown as {
      first: { userFacingText?: string; data?: { proposalId?: string } };
      second: { userFacingText?: string; data?: { proposalId?: string } };
    };
    expect(first.userFacingText).toBe("Opening wikipedia.org.");
    expect(second.userFacingText).toBe("Opening wikipedia.org.");
    expect(second.data?.proposalId).toBe(first.data?.proposalId);
    const rows = (
      await f.pg.query<{ payload: { operation: unknown } }>(
        "SELECT payload FROM approval_requests",
      )
    ).rows;
    // One owner request, one new tab with that address.
    expect(rows.map((r) => r.payload.operation)).toEqual([
      { type: "browser_navigate", url: "https://wikipedia.org/", newTab: true },
    ]);
  } finally {
    await f.pg.close();
  }
});
