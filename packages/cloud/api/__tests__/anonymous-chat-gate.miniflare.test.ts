/** Exercises the production Durable Object and its actual SQL mirror. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } =
  await import("@elizaos/cloud-shared/db/client");
const { anonymousSessionsRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/anonymous-sessions"
);
type Snapshot = Parameters<
  typeof anonymousSessionsRepository.persistGateCounterSnapshot
>[0];
type LeaseReply = {
  duplicate: boolean;
  snapshot: {
    revision: number;
    hourlyResetAtMs: number;
    lastMessageAtMs: number;
  };
};
type LedgerProbe = {
  activeLeases: Record<string, { expiresAtMs: number }>;
  pendingSnapshot: unknown;
};

let worker: Miniflare;
const mirrorFailures = new Set<string>();

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  await getPgliteClientForTests().exec(`
    CREATE TABLE anonymous_sessions (
      id uuid PRIMARY KEY,
      message_count integer NOT NULL DEFAULT 0,
      hourly_message_count integer NOT NULL DEFAULT 0,
      hourly_reset_at timestamp,
      last_message_at timestamp,
      gate_revision bigint NOT NULL DEFAULT 0
    );
  `);
  const build = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL(
          "../test/fixtures/anonymous-chat-gate-worker.ts",
          import.meta.url,
        ),
      ),
    ],
    target: "browser",
    external: ["node:*"],
    conditions: ["node", "import"],
    plugins: [
      {
        name: "anonymous-chat-qa-mirror",
        setup(build) {
          build.onLoad({ filter: /[\\/]db[\\/]client\.ts$/ }, () => ({
            loader: "js",
            contents: "export const runWithDbCacheAsync = (run) => run();",
          }));
          build.onLoad(
            { filter: /[\\/]repositories[\\/]anonymous-sessions\.ts$/ },
            () => ({
              loader: "js",
              contents: `
                import { getCloudBinding } from "../../lib/runtime/cloud-bindings";
                export const anonymousSessionsRepository = {
                  async persistGateCounterSnapshot(snapshot) {
                    const response = await getCloudBinding("MIRROR").fetch("https://mirror.test", {
                      method: "POST", body: JSON.stringify(snapshot),
                    });
                    if (!response.ok) throw new Error("Anonymous mirror unavailable");
                    return response.json();
                  },
                };
              `,
            }),
          );
        },
      },
    ],
  });
  if (!build.success || !build.outputs[0]) {
    throw new AggregateError(
      build.logs,
      "Anonymous chat test Worker did not bundle",
    );
  }
  worker = new Miniflare({
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    script: await build.outputs[0].text(),
    durableObjects: {
      GATES: { className: "AnonymousChatGateFixture", useSQLite: true },
    },
    serviceBindings: {
      MIRROR: async (request: Request) => {
        const snapshot = (await request.json()) as Omit<
          Snapshot,
          "lastMessageAt" | "hourlyResetAt"
        > & { lastMessageAt: string; hourlyResetAt: string | null };
        if (mirrorFailures.delete(snapshot.sessionId))
          return new Response(null, { status: 503 });
        return Response.json(
          await anonymousSessionsRepository.persistGateCounterSnapshot({
            ...snapshot,
            lastMessageAt: new Date(snapshot.lastMessageAt),
            hourlyResetAt: snapshot.hourlyResetAt
              ? new Date(snapshot.hourlyResetAt)
              : null,
          }),
        );
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
  await closeDatabaseConnectionsForTests();
});

async function post<T>(name: string, path: string, body: unknown = {}) {
  const response = await fetch(
    new URL(`/${name}/${path}`, await worker.ready),
    {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: (await response.json()) as T };
}

async function createGate(overrides: Record<string, unknown> = {}) {
  const name = crypto.randomUUID();
  const now = Date.now();
  await getPgliteClientForTests().query(
    "INSERT INTO anonymous_sessions(id) VALUES ($1)",
    [name],
  );
  const hydrate = {
    sessionId: name,
    userId: crypto.randomUUID(),
    messageCount: 0,
    messagesLimit: 2,
    hourlyMessageCount: 0,
    hourlyResetAtMs: now,
    hourlyLimit: 1,
    expiresAtMs: now + 24 * 60 * 60 * 1_000,
    revision: 0,
    blocked: false,
    ...overrides,
  };
  const send = <T = unknown>(path: string, body?: unknown) =>
    post<T>(name, path, body);
  expect(await send("hydrate", hydrate)).toEqual({
    status: 200,
    body: { hydrated: true, initialized: true },
  });
  return { name, hydrate, send };
}

async function mirror(name: string) {
  const result = await getPgliteClientForTests().query<{
    gate_revision: number;
    message_count: number;
  }>(
    "SELECT gate_revision, message_count FROM anonymous_sessions WHERE id=$1",
    [name],
  );
  return result.rows[0];
}

test("a replayed lease retains its exact quota and original hydrated owner", async () => {
  const { hydrate, send } = await createGate();
  const request = { requestId: crypto.randomUUID() };
  const replies = await Promise.all([
    send<LeaseReply>("lease", request),
    send<LeaseReply>("lease", request),
  ]);
  expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
  expect(replies.map((reply) => reply.body.duplicate).sort()).toEqual([
    false,
    true,
  ]);
  expect(replies.map((reply) => reply.body.snapshot.revision)).toEqual([1, 1]);
  expect(
    await send("hydrate", { ...hydrate, userId: "different", messageCount: 0 }),
  ).toMatchObject({ body: { initialized: false } });
  expect(await send("context")).toMatchObject({
    body: { context: { userId: hydrate.userId, messageCount: 1 } },
  });
  expect(await send("lease", { requestId: crypto.randomUUID() })).toMatchObject(
    {
      status: 429,
      body: { reason: "hourly_limit" },
    },
  );
});

test("lifetime quota remains capped while the hourly window has room", async () => {
  const { send } = await createGate({ messagesLimit: 1, hourlyLimit: 2 });
  expect((await send("lease", { requestId: crypto.randomUUID() })).status).toBe(
    200,
  );
  expect(await send("lease", { requestId: crypto.randomUUID() })).toMatchObject(
    {
      status: 429,
      body: { reason: "message_limit", remaining: 0, limit: 1 },
    },
  );
});

test("an expired undispatched lease cannot start before its alarm refunds it", async () => {
  const { name, send } = await createGate();
  const request = { requestId: crypto.randomUUID() };
  const admitted = await send<LeaseReply>("lease", request);
  expect(admitted.status).toBe(200);
  expect(
    await send("fixture/advance", { ...request, remainingMs: 0 }),
  ).toMatchObject({ status: 200 });
  expect((await send("dispatch", request)).status).toBe(409);
  expect((await send("lease", request)).status).toBe(409);

  expect(await send("fixture/alarm")).toMatchObject({ status: 200 });
  expect(await send("context")).toMatchObject({
    body: { context: { messageCount: 0 } },
  });
  expect(await send("refund", request)).toMatchObject({
    status: 200,
    body: { duplicate: true, snapshot: { revision: 2, messageCount: 0 } },
  });
  expect(
    await anonymousSessionsRepository.persistGateCounterSnapshot({
      sessionId: name,
      revision: 1,
      messageCount: 1,
      hourlyMessageCount: 1,
      hourlyResetAt: new Date(admitted.body.snapshot.hourlyResetAtMs),
      lastMessageAt: new Date(admitted.body.snapshot.lastMessageAtMs),
    }),
  ).toBe(false);
  expect(await mirror(name)).toEqual({ gate_revision: 2, message_count: 0 });
});

test("dispatch replay keeps the original settlement deadline and expiry commits it", async () => {
  const { send } = await createGate();
  const request = { requestId: crypto.randomUUID() };
  expect((await send("lease", request)).status).toBe(200);
  expect(await send("dispatch", request)).toMatchObject({
    status: 200,
    body: { duplicate: false },
  });
  await send("fixture/advance", { ...request, remainingMs: 0 });
  const before = (await send<LedgerProbe>("fixture/inspect")).body.activeLeases[
    request.requestId
  ].expiresAtMs;
  expect(await send("dispatch", request)).toMatchObject({
    status: 200,
    body: { duplicate: true },
  });
  expect(
    (await send<LedgerProbe>("fixture/inspect")).body.activeLeases[
      request.requestId
    ].expiresAtMs,
  ).toBe(before);
  expect((await send("fixture/alarm")).status).toBe(200);
  expect((await send("refund", request)).status).toBe(409);
  expect(await send("commit", request)).toMatchObject({
    status: 200,
    body: { duplicate: true },
  });
  expect(await send("context")).toMatchObject({
    body: { context: { messageCount: 1 } },
  });
});

test("a delayed old-window refund does not restore the current hourly allowance", async () => {
  const { send } = await createGate();
  const old = { requestId: crypto.randomUUID() };
  const current = { requestId: crypto.randomUUID() };
  expect((await send("lease", old)).status).toBe(200);
  expect((await send("fixture/advance", { rotateWindow: true })).status).toBe(
    200,
  );
  expect((await send("lease", current)).status).toBe(200);
  expect(await send("refund", old)).toMatchObject({
    status: 200,
    body: { snapshot: { messageCount: 1, hourlyMessageCount: 1 } },
  });
  expect(await send("lease", { requestId: crypto.randomUUID() })).toMatchObject(
    {
      status: 429,
      body: { reason: "hourly_limit" },
    },
  );
});

test("a failed alarm mirror retries its durable latest snapshot after reload", async () => {
  const { name, send } = await createGate();
  const request = { requestId: crypto.randomUUID() };
  expect((await send("lease", request)).status).toBe(200);
  expect(
    (await send("fixture/advance", { ...request, remainingMs: 0 })).status,
  ).toBe(200);
  mirrorFailures.add(name);
  expect((await send("fixture/alarm")).status).toBe(503);
  expect(await mirror(name)).toEqual({ gate_revision: 0, message_count: 0 });

  const newer = { requestId: crypto.randomUUID() };
  expect((await send("lease", newer)).status).toBe(200);
  expect((await send("fixture/advance", { retryMirror: true })).status).toBe(
    200,
  );
  expect((await send("fixture/alarm")).status).toBe(200);
  expect(await mirror(name)).toEqual({ gate_revision: 3, message_count: 1 });
  expect(
    (await send<LedgerProbe>("fixture/inspect")).body.pendingSnapshot,
  ).toBeNull();
});

test("session expiry and invalidation remain terminal after rehydration", async () => {
  const expired = await createGate({ expiresAtMs: Date.now() - 1 });
  expect((await expired.send("context")).status).toBe(410);
  const live = await createGate();
  expect((await live.send("invalidate")).status).toBe(200);
  for (const { hydrate, send } of [expired, live]) {
    expect(
      await send("hydrate", { ...hydrate, expiresAtMs: Date.now() + 10_000 }),
    ).toMatchObject({ body: { initialized: false } });
    expect((await send("context")).status).toBe(410);
    expect(
      (await send("lease", { requestId: crypto.randomUUID() })).status,
    ).toBe(410);
  }
});
