/** Independent PostgreSQL sessions observe the real document transaction boundaries. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";

const database = process.env.DOCUMENT_PUBLICATION_TEST_POSTGRES_URL;
if (!database) {
  test.skip("PostgreSQL document interleavings require the isolated conformance database", () => {});
} else {
  const parsed = new URL(database);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !parsed.username.startsWith("qa_") ||
    !/^\/quint_document_[a-f0-9]+$/.test(parsed.pathname)
  )
    throw new Error("Document PostgreSQL tests refuse a non-isolated database");

  const {
    app,
    createDocumentRecord,
    dbWrite,
    graph,
    input,
    memoriesRepository,
    scope,
    user,
  } = await import("./documents-publication-atomicity.pglite.test");

  const lockClass = 739211;
  let nextLock = 1;
  async function sessions() {
    const locker = new Client({ connectionString: database });
    const observer = new Client({ connectionString: database });
    await Promise.all([locker.connect(), observer.connect()]);
    const left = (
      await locker.query(
        "SELECT pg_backend_pid() AS pid, current_database() AS name, current_setting('transaction_isolation') AS isolation",
      )
    ).rows[0];
    const right = (
      await observer.query(
        "SELECT pg_backend_pid() AS pid, current_database() AS name, current_setting('transaction_isolation') AS isolation",
      )
    ).rows[0];
    expect(left.pid).not.toBe(right.pid);
    expect(left.name).toBe(parsed.pathname.slice(1));
    expect(right.name).toBe(left.name);
    expect(left.isolation).toBe("read committed");
    expect(right.isolation).toBe("read committed");
    const application = await dbWrite.execute(
      sql`SELECT current_setting('transaction_isolation') AS isolation`,
    );
    expect(application.rows[0]?.isolation).toBe("read committed");
    const key = nextLock++;
    await locker.query("SELECT pg_advisory_lock($1,$2)", [lockClass, key]);
    return {
      locker,
      observer,
      key,
      async release() {
        await locker.query("SELECT pg_advisory_unlock($1,$2)", [
          lockClass,
          key,
        ]);
      },
      async close() {
        await Promise.all([locker.end(), observer.end()]);
      },
    };
  }

  async function waitFor<T>(
    read: () => Promise<T | undefined>,
    description: string,
  ): Promise<T> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== undefined) return value;
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async function heldWriter(observer: Client, key: number): Promise<number> {
    return waitFor(async () => {
      const rows = (
        await observer.query(
          "SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objid=$2::oid AND NOT granted",
          [lockClass, key],
        )
      ).rows;
      return rows[0]?.pid;
    }, "the writer's actual PostgreSQL advisory wait");
  }

  async function competingDelete(
    observer: Client,
    blockedBy: number,
  ): Promise<number> {
    return waitFor(async () => {
      const rows = (
        await observer.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%memories%'",
          [blockedBy],
        )
      ).rows;
      return rows[0]?.pid;
    }, "a second delete waiting on the first connection's parent lock");
  }

  async function installBarrier(key: number, body: string) {
    await dbWrite.execute(
      sql.raw(
        `CREATE FUNCTION document_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body.replaceAll("LOCK_KEY", `pg_advisory_xact_lock(${lockClass},${key})`)} END $$`,
      ),
    );
    await dbWrite.execute(
      sql`CREATE TRIGGER document_test_barrier BEFORE INSERT OR DELETE ON memories FOR EACH ROW EXECUTE FUNCTION document_test_barrier()`,
    );
  }
  async function removeBarrier() {
    await dbWrite.execute(
      sql`DROP TRIGGER IF EXISTS document_test_barrier ON memories`,
    );
    await dbWrite.execute(sql`DROP FUNCTION IF EXISTS document_test_barrier()`);
    await dbWrite.execute(
      sql`DROP SEQUENCE IF EXISTS document_test_delete_attempt`,
    );
  }

  async function preparedScope() {
    const seed = await createDocumentRecord(user as never, scope, input);
    expect(
      (await app.request(`/documents/${seed.id}`, { method: "DELETE" })).status,
    ).toBe(200);
  }
  function original(id: string, text: string) {
    return {
      id,
      ...scope,
      entityId: user.id,
      unique: false,
      content: { text },
      metadata: { type: "document", timestamp: Date.now() },
    };
  }

  test("PostgreSQL publication stays invisible and a concurrent delete linearizes before commit", async () => {
    await preparedScope();
    const peers = await sessions();
    const id = randomUUID();
    let publication:
      | ReturnType<typeof memoriesRepository.createDocumentWithFragments>
      | undefined;
    try {
      await installBarrier(
        peers.key,
        "IF TG_OP='INSERT' AND NEW.type='document_fragments' AND NEW.metadata->>'position'='256' THEN PERFORM LOCK_KEY; END IF; RETURN NEW;",
      );
      const fragments = Array.from({ length: 257 }, (_, i) => `part-${i}`);
      publication = memoriesRepository.createDocumentWithFragments(
        original(id, fragments.join("")),
        fragments,
      );
      // Keep setup failures attached while the independent observer waits.
      void publication.catch(() => undefined);
      const writer = await heldWriter(peers.observer, peers.key);
      const reader = (
        await peers.observer.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      expect(writer).not.toBe(reader);
      expect(
        (await peers.observer.query("SELECT id FROM memories")).rowCount,
      ).toBe(0);
      expect(await memoriesRepository.deleteDocument(id, scope)).toBe(false);
      await peers.release();
      expect((await publication).id).toBe(id);
      const rows = (
        await peers.observer.query(
          "SELECT type,metadata,content FROM memories ORDER BY (metadata->>'position')::integer NULLS FIRST",
        )
      ).rows;
      expect(rows).toHaveLength(258);
      expect(rows.filter((row) => row.type === "documents")).toHaveLength(1);
      expect(
        rows
          .filter((row) => row.type === "document_fragments")
          .map((row) => row.content.text),
      ).toEqual(Array.from({ length: 257 }, (_, i) => `part-${i}`));
    } finally {
      await peers.release();
      await publication?.catch(() => undefined);
      await removeBarrier();
      await peers.close();
    }
  }, 30_000);

  test("PostgreSQL failed publication exposes no partial graph and permits a complete retry", async () => {
    await preparedScope();
    const peers = await sessions();
    const id = randomUUID();
    let publication:
      | ReturnType<typeof memoriesRepository.createDocumentWithFragments>
      | undefined;
    try {
      await installBarrier(
        peers.key,
        "IF TG_OP='INSERT' AND NEW.type='document_fragments' AND NEW.metadata->>'position'='256' THEN PERFORM LOCK_KEY; RAISE EXCEPTION 'controlled concurrent publication failure'; END IF; RETURN NEW;",
      );
      const fragments = Array.from({ length: 257 }, () => "part");
      publication = memoriesRepository.createDocumentWithFragments(
        original(id, fragments.join("")),
        fragments,
      );
      // Attach a rejection observer before releasing the failing transaction.
      const outcome = publication.then(
        () => null,
        (error: unknown) => error,
      );
      await heldWriter(peers.observer, peers.key);
      expect(
        (await peers.observer.query("SELECT id FROM memories")).rowCount,
      ).toBe(0);
      expect(await memoriesRepository.deleteDocument(id, scope)).toBe(false);
      await peers.release();
      expect(await outcome).toMatchObject({
        cause: {
          code: "P0001",
          message: "controlled concurrent publication failure",
        },
      });
      expect(
        (await peers.observer.query("SELECT id FROM memories")).rowCount,
      ).toBe(0);
      await removeBarrier();
      expect(
        (
          await memoriesRepository.createDocumentWithFragments(
            original(id, "completeretry"),
            ["complete", "retry"],
          )
        ).id,
      ).toBe(id);
      expect(await graph()).toHaveLength(3);
    } finally {
      await peers.release();
      await publication?.catch(() => undefined);
      await removeBarrier();
      await peers.close();
    }
  }, 30_000);

  test("PostgreSQL concurrent HTTP deletes serialize on the parent and commit one complete removal", async () => {
    const document = await createDocumentRecord(user as never, scope, input);
    const before = await graph();
    const peers = await sessions();
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    try {
      await installBarrier(
        peers.key,
        "IF TG_OP='DELETE' AND OLD.type='document_fragments' THEN PERFORM LOCK_KEY; END IF; RETURN OLD;",
      );
      first = Promise.resolve(
        app.request(`/documents/${document.id}`, { method: "DELETE" }),
      );
      const writer = await heldWriter(peers.observer, peers.key);
      second = Promise.resolve(
        app.request(`/documents/${document.id}`, { method: "DELETE" }),
      );
      expect(await competingDelete(peers.observer, writer)).not.toBe(writer);
      expect(
        (await peers.observer.query("SELECT id FROM memories")).rowCount,
      ).toBe(before.length);
      await peers.release();
      expect(
        (await Promise.all([first, second]))
          .map((response) => response.status)
          .sort(),
      ).toEqual([200, 404]);
      expect(
        (await peers.observer.query("SELECT id FROM memories")).rowCount,
      ).toBe(0);
    } finally {
      await peers.release();
      await Promise.all([
        first?.catch(() => undefined),
        second?.catch(() => undefined),
      ]);
      await removeBarrier();
      await peers.close();
    }
  }, 30_000);

  test("PostgreSQL a waiting delete recovers the whole graph after the first transaction rolls back", async () => {
    const document = await createDocumentRecord(user as never, scope, input);
    const before = await graph();
    const peers = await sessions();
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    try {
      await dbWrite.execute(sql`CREATE SEQUENCE document_test_delete_attempt`);
      await installBarrier(
        peers.key,
        "IF TG_OP='DELETE' AND OLD.type='document_fragments' THEN PERFORM LOCK_KEY; END IF; IF TG_OP='DELETE' AND OLD.type='documents' AND nextval('document_test_delete_attempt')=1 THEN RAISE EXCEPTION 'controlled first delete failure'; END IF; RETURN OLD;",
      );
      first = Promise.resolve(
        app.request(`/documents/${document.id}`, { method: "DELETE" }),
      );
      const writer = await heldWriter(peers.observer, peers.key);
      second = Promise.resolve(
        app.request(`/documents/${document.id}`, { method: "DELETE" }),
      );
      expect(await competingDelete(peers.observer, writer)).not.toBe(writer);
      expect(
        (await peers.observer.query("SELECT id FROM memories")).rowCount,
      ).toBe(before.length);
      await peers.release();
      expect((await first).status).toBe(500);
      expect((await second).status).toBe(200);
      expect(
        (await peers.observer.query("SELECT id FROM memories")).rowCount,
      ).toBe(0);
    } finally {
      await peers.release();
      await Promise.all([
        first?.catch(() => undefined),
        second?.catch(() => undefined),
      ]);
      await removeBarrier();
      await peers.close();
    }
  }, 30_000);
}
