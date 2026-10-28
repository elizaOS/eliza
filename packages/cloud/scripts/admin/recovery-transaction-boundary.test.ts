import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runRecoveryTransaction } from "./recovery-transaction-boundary";

function adapter(db: PGlite) {
  async function send(sql: string) {
    await db.waitReady;
    const body = Buffer.from(`${sql}\0`);
    const wire = Buffer.alloc(body.length + 5);
    wire[0] = 81;
    wire.writeInt32BE(body.length + 4, 1);
    body.copy(wire, 5);
    const result = await db.execProtocol(wire, { throwOnError: true });
    const command = result.messages.find((m) => m.name === "commandComplete");
    const ready = result.messages.find((m) => m.name === "readyForQuery");
    return {
      command: command && "text" in command ? String(command.text) : undefined,
      status:
        ready && "status" in ready ? (ready.status as "I" | "T" | "E") : null,
    };
  }
  return {
    query: async (sql: string) => send(sql),
    getTransactionStatus: async () => (await send("")).status,
  };
}

test("DDL, ledger replacement and private archive all roll back together on failure", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec(
      "CREATE TABLE ledger(id serial PRIMARY KEY,tag text); INSERT INTO ledger(tag) VALUES('existing-gmail'); CREATE TABLE receipt(value text); INSERT INTO receipt VALUES('preserve-effect');",
    );
    const result = await runRecoveryTransaction(adapter(db), async () => {
      await db.exec(
        "CREATE TABLE private_recovery_archive AS SELECT * FROM ledger; DELETE FROM ledger; INSERT INTO ledger(tag) VALUES('new-canonical'); CREATE TABLE new_funding(id integer);",
      );
      throw new Error("PRIVATE_FAIL_SQL_AND_VALUES");
    });
    expect(result).toEqual({ status: "aborted" });
    expect((await db.query("SELECT tag FROM ledger")).rows).toEqual([
      { tag: "existing-gmail" },
    ]);
    expect((await db.query("SELECT value FROM receipt")).rows).toEqual([
      { value: "preserve-effect" },
    ]);
    expect(
      (
        await db.query(
          "SELECT to_regclass('private_recovery_archive') AS archive,to_regclass('new_funding') AS funding",
        )
      ).rows,
    ).toEqual([{ archive: null, funding: null }]);
  } finally {
    await db.close();
  }
});
test("lost commit reply remains uncertain even when real database committed; never retry or issue rollback", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec("CREATE TABLE effects(id integer)");
    let commits = 0;
    let rollbacks = 0;
    let work = 0;
    const result = await runRecoveryTransaction(
      {
        ...adapter(db),
        query: async (sql) => {
          if (sql === "ROLLBACK") rollbacks++;
          const result = await adapter(db).query(sql);
          if (sql === "COMMIT") {
            commits++;
            throw new Error("PRIVATE_CONNECTION_DATA");
          }
          return result;
        },
      },
      async () => {
        work++;
        await db.exec("INSERT INTO effects VALUES(1)");
      },
    );
    expect(result).toEqual({ status: "commit_unconfirmed" });
    expect(work).toBe(1);
    expect(commits).toBe(1);
    expect(rollbacks).toBe(0);
    expect((await db.query("SELECT * FROM effects")).rows).toEqual([{ id: 1 }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  } finally {
    await db.close();
  }
});
test("failed rollback is never reported as a confirmed abort", async () => {
  const db = new PGlite("memory://");
  try {
    const result = await runRecoveryTransaction(
      {
        ...adapter(db),
        query: async (sql) => {
          if (sql === "ROLLBACK") throw Error("PRIVATE_CONNECTION");
          return adapter(db).query(sql);
        },
      },
      async () => {
        await db.exec("CREATE TABLE uncommitted(id integer)");
        throw Error("PRIVATE_FAILURE");
      },
    );
    expect(result).toEqual({ status: "rollback_unconfirmed" });
    await db.exec("ROLLBACK");
  } finally {
    await db.close();
  }
});

test("caught SQL failure cannot produce false commit success", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec("CREATE TABLE effects(id integer)");
    const result = await runRecoveryTransaction(adapter(db), async () => {
      await db.exec("INSERT INTO effects VALUES(1)");
      try {
        await db.exec("SELECT 1/0");
      } catch {
        /* Deliberately simulate swallowed work error. */
      }
    });
    expect(result).toEqual({ status: "aborted" });
    expect((await db.query("SELECT * FROM effects")).rows).toEqual([]);
  } finally {
    await db.close();
  }
});
test("an existing transaction is never adopted or rolled back", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec("BEGIN; CREATE TABLE owned_by_caller(id integer)");
    let calls = 0;
    const result = await runRecoveryTransaction(adapter(db), async () => {
      calls++;
    });
    expect(result).toEqual({ status: "not_started" });
    expect(calls).toBe(0);
    expect(await adapter(db).getTransactionStatus()).toBe("T");
    await db.exec("ROLLBACK");
  } finally {
    await db.close();
  }
});

test("missing command tag after actual commit is unconfirmed, and initial status errors are scrubbed", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec("CREATE TABLE effects(id integer)");
    const real = adapter(db);
    const result = await runRecoveryTransaction(
      {
        ...real,
        query: async (sql) => {
          const result = await real.query(sql);
          return sql === "COMMIT" ? {} : result;
        },
      },
      async () => {
        await db.exec("INSERT INTO effects VALUES(1)");
      },
    );
    expect(result).toEqual({ status: "commit_unconfirmed" });
    let submitted = false;
    const initial = await runRecoveryTransaction(
      {
        query: async () => {
          submitted = true;
          return {};
        },
        getTransactionStatus: () => {
          throw Error("PRIVATE_DRIVER_URL");
        },
      },
      async () => {},
    );
    expect(initial).toEqual({ status: "not_started" });
    expect(submitted).toBe(false);
  } finally {
    await db.close();
  }
});
