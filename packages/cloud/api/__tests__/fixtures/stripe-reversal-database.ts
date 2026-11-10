/** Optional authenticated local PostgreSQL backend for the maintained reversal fixtures. */
import { spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import {
  type SqlExecutor,
  sqlRows,
} from "@elizaos/cloud-shared/db/execute-helpers";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";
import {
  type CommitFault,
  postgresCommitAckRelay,
} from "./postgres-commit-ack-relay";

const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Refuse provider HTTP and non-loopback sockets; database and local cache TCP remain real. */
function denyProviderCalls() {
  const attempts: string[] = [];
  const deny = (transport: string): never => {
    attempts.push(transport);
    throw new Error(
      `Provider egress is forbidden in reversal conformance (${transport})`,
    );
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => Promise.reject(deny("fetch")), fetch);
  const spies = [
    spyOn(http, "request").mockImplementation(() => deny("http.request")),
    spyOn(http, "get").mockImplementation(() => deny("http.get")),
    spyOn(https, "request").mockImplementation(() => deny("https.request")),
    spyOn(https, "get").mockImplementation(() => deny("https.get")),
  ];
  const connect = net.Socket.prototype.connect;
  const socket = spyOn(net.Socket.prototype, "connect").mockImplementation(
    function (...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const host =
        typeof first === "object" && first !== null && "host" in first
          ? String(first.host)
          : typeof args[1] === "string"
            ? args[1]
            : "localhost";
      if (!loopback.has(host)) deny("non-loopback TCP");
      return Reflect.apply(connect, this, args);
    },
  );
  return {
    attempts,
    restore() {
      globalThis.fetch = fetch;
      for (const spy of spies) spy.mockRestore();
      socket.mockRestore();
    },
  };
}

export async function stripeReversalTestDatabase(name: string) {
  process.env.NODE_ENV = "test";
  const supplied = process.env.STRIPE_REVERSAL_TEST_POSTGRES_URL;
  if (!supplied) {
    process.env.DATABASE_URL = "pglite://memory";
    process.env.TEST_DATABASE_URL = "pglite://memory";
    const { getPgliteClientForTests } = await import(
      "@elizaos/cloud-shared/db/client"
    );
    return {
      native: false,
      query: <T>(text: string, parameters?: unknown[]) =>
        getPgliteClientForTests().query<T>(text, parameters),
      exec: async (text: string) => {
        await getPgliteClientForTests().exec(text);
      },
      waitForBlockedMutation: async (_ownerPid: number) => {},
      verifyProductionConnection: async (_executor: SqlExecutor) => {},
      loseCommitAck: (_pid: number, _fault: CommitFault) => {},
      didLoseCommitAck: (_pid: number, _fault: CommitFault) => false,
      didLoseReceiptObservation: (_pid: number) => false,
      record: (_event: Record<string, unknown>) => {},
      close: async () => {},
    };
  }
  const parsed = new URL(supplied);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !loopback.has(parsed.hostname) ||
    !/^qa_[a-z0-9_]+$/.test(parsed.username) ||
    !parsed.password ||
    !/^\/quint_reversal_[a-f0-9]+$/.test(parsed.pathname) ||
    [...parsed.searchParams.keys()].some((key) => key !== "sslmode")
  )
    throw new Error(
      "Reversal PostgreSQL tests require an authenticated loopback qa_* quint_reversal_* database",
    );
  const guard = denyProviderCalls();
  const wrongPassword = new URL(parsed);
  wrongPassword.password = randomUUID();
  const denied = new Client({
    connectionString: wrongPassword.toString(),
    connectionTimeoutMillis: 5000,
  });
  try {
    await denied.connect();
    throw new Error("Reversal PostgreSQL tests refuse trust authentication");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "28P01"
    ) {
      guard.restore();
      throw error;
    }
  } finally {
    await denied.end();
  }
  const client = new Client({
    connectionString: parsed.toString(),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const {
    rows: [identity],
  } = await client.query<{
    role: string;
    database: string;
    pid: number;
    version: string;
    superuser: boolean;
    address: string;
  }>(`SELECT current_user AS role,current_database() AS database,pg_backend_pid() AS pid,
    current_setting('server_version_num') AS version,rolsuper AS superuser,host(inet_server_addr()) AS address
    FROM pg_roles WHERE rolname=current_user`);
  if (
    !identity ||
    identity.role !== parsed.username ||
    identity.database !== parsed.pathname.slice(1) ||
    identity.superuser ||
    !loopback.has(identity.address) ||
    Number(identity.version) < 160000 ||
    Number(identity.version) >= 170000
  ) {
    await client.end();
    guard.restore();
    throw new Error(
      "Reversal native fixture requires its isolated non-superuser PostgreSQL16 identity",
    );
  }
  const schema = `reversal_${randomUUID().replaceAll("-", "")}`;
  await client.query(
    `CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog`,
  );
  const relay =
    name === "reinstatement"
      ? await postgresCommitAckRelay({
          host: parsed.hostname.replace(/^\[|\]$/g, ""),
          port: Number(parsed.port || "5432"),
        })
      : undefined;
  if (relay) {
    parsed.hostname = "127.0.0.1";
    parsed.port = String(relay.port);
    parsed.searchParams.set("sslmode", "disable");
  }
  parsed.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
  process.env.DATABASE_URL = parsed.toString();
  process.env.TEST_DATABASE_URL = parsed.toString();
  process.env.LOCAL_PG_POOL_MAX = "8";
  const events: Record<string, unknown>[] = [];
  const output = testOutputPath(
    "private-credit-reversal-native",
    `${name}.json`,
  );
  mkdirSync(path.dirname(output), { recursive: true });
  const record = (event: Record<string, unknown>) => {
    if (
      "ownerPid" in event &&
      (!Number.isSafeInteger(event.ownerPid) ||
        Number(event.ownerPid) <= 0 ||
        event.ownerPid === identity.pid)
    )
      throw new Error(
        "Native receipt owner must use a real independent transaction connection",
      );
    events.push(event);
    writeFileSync(
      output,
      `${JSON.stringify(
        { identity, schema, events, providerAttempts: guard.attempts },
        null,
        2,
      )}\n`,
    );
  };
  record({
    event: "authenticated-isolated-backend",
    wrongPasswordRejected: true,
  });
  return {
    native: true,
    query: <T>(text: string, parameters?: unknown[]) =>
      client
        .query(text, parameters)
        .then((result) => ({ rows: result.rows as T[] })),
    exec: async (text: string) => {
      await client.query(text);
    },
    loseCommitAck(pid: number, fault: CommitFault) {
      if (!relay)
        throw new Error("No COMMIT acknowledgement relay in this fixture");
      relay.arm(pid, fault);
    },
    didLoseCommitAck: (pid: number, fault: CommitFault) =>
      relay?.didDrop(pid, fault) ?? false,
    didLoseReceiptObservation: (pid: number) =>
      relay?.didDropObservation(pid) ?? false,
    async verifyProductionConnection(executor: SqlExecutor) {
      const [owner] = await sqlRows<{
        pid: number;
        schema: string;
        database: string;
        role: string;
      }>(
        executor,
        sql`SELECT pg_backend_pid() AS pid,current_schema() AS schema,current_database() AS database,current_user AS role`,
      );
      if (
        !owner ||
        owner.pid === identity.pid ||
        owner.schema !== schema ||
        owner.database !== identity.database ||
        owner.role !== identity.role
      )
        throw new Error(
          "Production database connection escaped the isolated reversal schema",
        );
      record({
        event: "production-pool-isolated",
        ownerPid: owner.pid,
        observerPid: identity.pid,
      });
    },
    async waitForBlockedMutation(ownerPid: number) {
      if (ownerPid === identity.pid)
        throw new Error("Native observer must use an independent connection");
      const until = performance.now() + 10_000;
      while (performance.now() < until) {
        const { rows } = await client.query<{
          pid: number;
          blockers: number[];
          wait_event_type: string;
        }>(
          `SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type FROM pg_stat_activity
          WHERE datname=current_database() AND usename=current_user AND $1=ANY(pg_blocking_pids(pid))`,
          [ownerPid],
        );
        const waiter = rows.find(
          (row) =>
            row.pid !== ownerPid &&
            row.pid !== identity.pid &&
            row.wait_event_type === "Lock",
        );
        if (waiter) {
          record({
            event: "paid-mutation-blocked-on-recovery",
            observerPid: identity.pid,
            ownerPid,
            waiterPid: waiter.pid,
            blockers: waiter.blockers,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        "Native paid mutation did not acquire an independent connection and block on recovery",
      );
    },
    record,
    async close() {
      try {
        record({
          event: "fixture-complete",
          providerCalls: guard.attempts.length,
        });
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await relay?.close();
        await client.end();
        guard.restore();
      }
      if (guard.attempts.length)
        throw new Error("Reversal proof attempted a forbidden provider call");
    },
  };
}
