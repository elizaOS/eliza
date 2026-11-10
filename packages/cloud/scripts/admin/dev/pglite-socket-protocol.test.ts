import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type PGLiteSocketHandler,
  PGLiteSocketServer,
} from "@electric-sql/pglite-socket";
import { Client } from "pg";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";

const require = createRequire(import.meta.url);
// Use the protocol implementation owned by the installed pg driver.
const requirePg = createRequire(require.resolve("pg/package.json"));
const { parse, serialize } = requirePg("pg-protocol");
const variants = [
  { name: "esm", Server: PGLiteSocketServer },
  {
    name: "cjs",
    Server: require("@electric-sql/pglite-socket")
      .PGLiteSocketServer as typeof PGLiteSocketServer,
  },
];
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Message = {
  name: string;
  code?: string;
  message?: string;
  fields?: (string | null)[];
  status?: string;
};
type Waiter = {
  predicate: (message: Message) => boolean;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function wireClient(port: number) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const messages: Message[] = [];
  const waiters = new Set<Waiter>();
  const rejectPending = (error: Error) => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };
  parse(socket, (message: Message) => {
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const wait = (predicate: Waiter["predicate"], timeout = 5000) => {
    const promise = new Promise<Message>((resolve, reject) => {
      const waiter = { predicate, resolve, reject } as Waiter;
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new Error(
            `Protocol wait timed out: ${messages
              .slice(-6)
              .map((m) => m.name)
              .join(",")}`,
          ),
        );
      }, timeout);
      waiters.add(waiter);
    });
    // Teardown can close a pending peer after an earlier assertion has failed.
    // Keep its rejection observed; callers still await the original promise.
    void promise.catch(() => undefined);
    return promise;
  };
  socket.on("error", rejectPending);
  socket.on("close", () => rejectPending(new Error("Connection closed")));
  const ready = wait((message) => message.name === "readyForQuery");
  socket.once("connect", () =>
    socket.write(serialize.startup({ user: "postgres", database: "postgres" })),
  );
  return { socket, messages, wait, ready };
}
type WireClient = ReturnType<typeof wireClient>;

async function simple(client: WireClient, text: string) {
  const start = client.messages.length;
  const ready = client.wait((message) => message.name === "readyForQuery");
  client.socket.write(serialize.query(text));
  await ready;
  const messages = client.messages.slice(start);
  const error = messages.find((message) => message.name === "error");
  assert.equal(
    error,
    undefined,
    `Simple query failed: ${error?.code} ${error?.message}`,
  );
  return messages;
}
function extended(
  name: string,
  text = "SELECT $1::int AS n",
  values: string[] = ["7"],
) {
  return [
    serialize.parse({ name, text, types: [] }),
    serialize.bind({ statement: name, portal: name, values }),
  ];
}
async function bind(client: WireClient, name: string) {
  const bound = client.wait((message) => message.name === "bindComplete");
  client.socket.write(Buffer.concat([...extended(name), serialize.flush()]));
  await bound;
}
async function finish(client: WireClient, name: string) {
  const start = client.messages.length;
  const ready = client.wait((message) => message.name === "readyForQuery");
  client.socket.write(
    Buffer.concat([
      serialize.describe({ type: "P", name }),
      serialize.execute({ portal: name, rows: 0 }),
      serialize.sync(),
    ]),
  );
  await ready;
  const messages = client.messages.slice(start);
  assert.equal(
    messages.find((message) => message.name === "error"),
    undefined,
  );
  assert.equal(
    messages.find((message) => message.name === "dataRow")?.fields?.[0],
    "7",
  );
  return messages;
}
async function waitingPeer(client: WireClient) {
  let complete = false;
  const start = client.messages.length;
  const ready = client
    .wait((message) => message.name === "readyForQuery")
    .then((message) => {
      const replies = client.messages.slice(start);
      assert.equal(
        replies.find((reply) => reply.name === "error"),
        undefined,
      );
      assert.equal(
        replies.find((reply) => reply.name === "dataRow")?.fields?.[0],
        "99",
      );
      return message;
    });
  void ready.then(
    () => {
      complete = true;
    },
    () => undefined,
  );
  client.socket.write(serialize.query("SELECT 99 AS other"));
  await delay(20);
  return { ready, blocked: !complete, isComplete: () => complete };
}

async function holdBackend(database: PGlite) {
  let release = () => {};
  let entered = () => {};
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = database.runExclusive(async () => {
    entered();
    await gate;
  });
  await acquired;
  return { release, held };
}

async function withFixture(
  Server: typeof PGLiteSocketServer,
  body: (fixture: {
    database: PGlite;
    server: PGLiteSocketServer;
    make: () => Promise<WireClient>;
    driver: () => Client;
    closeBackend: () => Promise<void>;
  }) => Promise<void>,
) {
  const producer = testOutputPath("pglite-socket-protocol");
  await mkdir(producer, { recursive: true });
  const directory = await mkdtemp(path.join(producer, "run-"));
  const wires: WireClient[] = [];
  const drivers: Client[] = [];
  let database: PGlite | undefined;
  let server: PGLiteSocketServer | undefined;
  let databaseClosed = false;
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    database = await PGlite.create({ dataDir: path.join(directory, "db") });
    server = new Server({
      db: database,
      port: 0,
      host: "127.0.0.1",
      maxConnections: 8,
    });
    await server.start();
    const port = Number(server.getServerConn().split(":").at(-1));
    const make = async () => {
      const client = wireClient(port);
      wires.push(client);
      await client.ready;
      return client;
    };
    const driver = () => {
      const client = new Client({
        host: "127.0.0.1",
        port,
        user: "postgres",
        database: "postgres",
        connectionTimeoutMillis: 1000,
      });
      drivers.push(client);
      return client;
    };
    const liveDatabase = database;
    await body({
      database,
      server,
      make,
      driver,
      closeBackend: async () => {
        await liveDatabase.close();
        databaseClosed = true;
      },
    });
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }
  const cleanupErrors: unknown[] = [];
  for (const client of wires) client.socket.destroy();
  const ended = await Promise.allSettled(drivers.map((client) => client.end()));
  for (const result of ended) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  if (server) {
    try {
      await server.stop();
    } catch (error) {
      // The negative case deliberately closes the real backend first.
      // It still closes the listener, but its reset can report that failure.
      if (!databaseClosed) cleanupErrors.push(error);
    }
  }
  if (database && !databaseClosed) {
    try {
      await database.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors,
      "PGlite protocol fixture failed or did not clean up",
    );
  }
  if (bodyFailed) throw bodyError;
}

for (const { name, Server } of variants) {
  const check = (scenario: string, body: Parameters<typeof withFixture>[1]) =>
    test(`${name}: ${scenario}`, { timeout: 20000 }, () =>
      withFixture(Server, body),
    );

  check(
    "retired handler rejects reattachment and fresh handler serves client",
    async ({ make, server }) => {
      await make();
      const handlers = (
        server as unknown as { handlers: Set<PGLiteSocketHandler> }
      ).handlers;
      const retired = [...handlers][0];
      assert.ok(retired);
      const originalSocket = (retired as unknown as { socket: net.Socket })
        .socket;
      const detaching = retired.detach(true);
      await assert.rejects(retired.attach(originalSocket), /has been detached/);
      await detaching;
      assert.equal(retired.isAttached, false);
      assert.equal(originalSocket.destroyed, true);

      const replacement = await make();
      const fresh = [...handlers][0];
      assert.ok(fresh && fresh !== retired);
      const replacementSocket = (fresh as unknown as { socket: net.Socket })
        .socket;
      await assert.rejects(
        retired.attach(replacementSocket),
        /has been detached/,
      );
      await retired.detach(true);
      assert.equal(retired.isAttached, false);
      assert.equal(fresh.isAttached, true);
      assert.equal(replacementSocket.destroyed, false);
      await simple(replacement, "SELECT 99 AS other");
    },
  );

  check(
    "extended cycle retains its portal until own Sync",
    async ({ make }) => {
      const a = await make(),
        b = await make();
      await bind(a, "lpg_cycle");
      const peer = await waitingPeer(b);
      assert.equal(peer.blocked, true);
      await finish(a, "lpg_cycle");
      await peer.ready;
    },
  );

  check(
    "SQL error and ignored owner Query retain cycle until Sync",
    async ({ make }) => {
      const a = await make(),
        b = await make();
      const failed = a.wait((message) => message.name === "error");
      a.socket.write(
        Buffer.concat([
          ...extended("lpg_error", "SELECT 1/0 AS n", []),
          serialize.execute({ portal: "lpg_error", rows: 0 }),
          serialize.flush(),
        ]),
      );
      assert.equal((await failed).code, "22012");
      a.socket.write(serialize.query("SELECT 88 AS ignored_until_sync"));
      await delay(5);
      const peer = await waitingPeer(b);
      assert.equal(peer.blocked, true);
      const ready = a.wait((message) => message.name === "readyForQuery");
      a.socket.write(serialize.sync());
      await ready;
      await peer.ready;
      assert.equal(peer.isComplete(), true);
    },
  );

  check(
    "Sync retains explicit transaction until COMMIT",
    async ({ make, database }) => {
      const a = await make(),
        b = await make();
      await simple(a, "BEGIN");
      await bind(a, "lpg_tx");
      await finish(a, "lpg_tx");
      assert.equal(database.isInTransaction(), true);
      const peer = await waitingPeer(b);
      assert.equal(peer.blocked, true);
      await simple(a, "COMMIT");
      await peer.ready;
      assert.equal(database.isInTransaction(), false);
    },
  );

  check(
    "failed explicit transaction retains owner until ROLLBACK",
    async ({ make, database }) => {
      const a = await make(),
        b = await make();
      await simple(a, "BEGIN");
      const failed = a.wait((message) => message.name === "error");
      const synced = a.wait((message) => message.name === "readyForQuery");
      a.socket.write(
        Buffer.concat([
          ...extended("lpg_failed_tx", "SELECT 1/0 AS n", []),
          serialize.execute({ portal: "lpg_failed_tx", rows: 0 }),
          serialize.sync(),
        ]),
      );
      assert.equal((await failed).code, "22012");
      assert.equal((await synced).status, "E");
      assert.equal(database.isInTransaction(), true);
      const peer = await waitingPeer(b);
      assert.equal(peer.blocked, true);
      await simple(a, "ROLLBACK");
      await peer.ready;
      assert.equal(database.isInTransaction(), false);
    },
  );

  check(
    "disconnect before Sync resets backend before peer",
    async ({ make, database }) => {
      const a = await make(),
        b = await make();
      await bind(a, "lpg_disconnect");
      const peer = await waitingPeer(b);
      assert.equal(peer.blocked, true);
      a.socket.destroy();
      await peer.ready;
      assert.equal(database.isInTransaction(), false);
      const replies = await simple(b, "SELECT 12");
      assert.equal(
        replies.find((reply) => reply.name === "dataRow")?.fields?.[0],
        "12",
      );
    },
  );

  check(
    "disconnect after Execute rolls back orphan write",
    async ({ make, database }) => {
      const a = await make(),
        b = await make();
      await simple(a, "CREATE TABLE wire_effects (id text PRIMARY KEY)");
      const executed = a.wait((message) => message.name === "commandComplete");
      a.socket.write(
        Buffer.concat([
          ...extended(
            "lpg_write",
            "INSERT INTO wire_effects VALUES ('orphan')",
            [],
          ),
          serialize.execute({ portal: "lpg_write", rows: 0 }),
          serialize.flush(),
        ]),
      );
      await executed;
      const peer = await waitingPeer(b);
      assert.equal(peer.blocked, true);
      a.socket.destroy();
      await peer.ready;
      const messages = await simple(
        b,
        "SELECT count(*)::text FROM wire_effects",
      );
      assert.equal(
        messages.find((message) => message.name === "dataRow")?.fields?.[0],
        "0",
      );
      assert.equal(database.isInTransaction(), false);
    },
  );

  check(
    "disconnect during first in-flight BEGIN recovers ownership",
    async ({ make, database }) => {
      const a = await make(),
        b = await make();
      const lock = await holdBackend(database);
      try {
        a.socket.write(serialize.query("BEGIN"));
        await delay(20);
        a.socket.destroy();
        const peer = await waitingPeer(b);
        assert.equal(peer.blocked, true);
        lock.release();
        await lock.held;
        await peer.ready;
        assert.equal(database.isInTransaction(), false);
      } finally {
        lock.release();
        await lock.held;
      }
    },
  );

  check(
    "shutdown waits for disconnected handler recovery",
    async ({ make, database, server }) => {
      const a = await make();
      const lock = await holdBackend(database);
      let stopped = false;
      let closing: Promise<void> | undefined;
      try {
        a.socket.write(serialize.query("BEGIN"));
        await delay(20);
        a.socket.destroy();
        await delay(20);
        closing = server.stop().then(() => {
          stopped = true;
        });
        await delay(20);
        assert.equal(stopped, false, "Shutdown returned before owned recovery");
        lock.release();
        await lock.held;
        await closing;
        assert.equal(database.isInTransaction(), false);
      } finally {
        lock.release();
        await lock.held;
        await closing;
      }
    },
  );

  check("fragmented same-handler frames preserve order", async ({ make }) => {
    const a = await make();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const portal = `lpg_fragment_${iteration}`;
      const start = a.messages.length;
      const ready = a.wait((message) => message.name === "readyForQuery");
      for (const frame of [
        ...extended(portal, "SELECT $1::int AS n", [String(iteration)]),
        serialize.describe({ type: "P", name: portal }),
        serialize.execute({ portal, rows: 0 }),
        serialize.sync(),
      ]) {
        const split = Math.max(1, Math.floor(frame.length / 2));
        a.socket.write(frame.subarray(0, split));
        await delay(0);
        a.socket.write(frame.subarray(split));
        await delay(0);
      }
      await ready;
      const messages = a.messages.slice(start);
      assert.equal(
        messages.find((message) => message.name === "error"),
        undefined,
      );
      assert.equal(
        messages.find((message) => message.name === "dataRow")?.fields?.[0],
        String(iteration),
      );
    }
  });

  check(
    "pg driver runs 100 named and 100 simple queries",
    async ({ driver }) => {
      const a = driver(),
        b = driver();
      await a.connect();
      await b.connect();
      await Promise.all([
        (async () => {
          for (let iteration = 0; iteration < 100; iteration += 1) {
            const portal = `lpg_driver_${iteration}`;
            const query = {
              text: "SELECT $1::int AS n",
              values: [iteration],
              name: portal,
              portal,
            };
            const result = await a.query(query);
            assert.equal(result.rows[0]?.n, iteration);
          }
        })(),
        (async () => {
          for (let iteration = 0; iteration < 100; iteration += 1) {
            const result = await b.query("SELECT 99 AS other");
            assert.equal(result.rows[0]?.other, 99);
          }
        })(),
      ]);
    },
  );

  check(
    "closed backend rejects queued and future clients",
    async ({ make, driver, closeBackend }) => {
      const a = await make(),
        b = await make();
      await bind(a, "lpg_failed_reset");
      const peer = await waitingPeer(b);
      assert.equal(peer.blocked, true);
      await closeBackend();
      a.socket.destroy();
      await assert.rejects(peer.ready, /closed|terminated|reset|backend/i);
      const future = driver();
      await assert.rejects(future.connect());
    },
  );
}
