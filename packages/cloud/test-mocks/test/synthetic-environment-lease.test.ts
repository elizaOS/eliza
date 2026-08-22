/**
 * Proves local synthetic namespace fencing through real file-backed SQLite and
 * independent Bun processes, including collision, expiry, and write rollback.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import { SqliteSyntheticEnvironmentLeaseStore } from "../src/synthetic-environment/sqlite-lease-store";

const roots: string[] = [];
const holders: Array<ReturnType<typeof Bun.spawn>> = [];
const workerPath = fileURLToPath(
  new URL("./fixtures/synthetic-lease-worker.ts", import.meta.url),
);
const rolloverWorkerPath = fileURLToPath(
  new URL("./fixtures/synthetic-rollover-worker.ts", import.meta.url),
);
const holderWorkerPath = fileURLToPath(
  new URL("./fixtures/synthetic-lease-holder.ts", import.meta.url),
);

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "eliza-lease-"),
  );
  roots.push(root);
  return root;
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = await Promise.all(
      files.map((file) => Bun.file(file).exists()),
    );
    if (found.every(Boolean)) return;
    await Bun.sleep(10);
  }
  throw new Error(`workers did not reach barrier: ${files.join(", ")}`);
}

async function workerResult(
  databasePath: string,
  namespace: string,
  ownerId: string,
  readyPath: string,
  goPath: string,
  durationMs: number,
): Promise<{
  ok: boolean;
  code?: string;
  operation?: string;
  authority?: SyntheticEnvironmentLeaseAuthority;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=eliza-source",
      workerPath,
      databasePath,
      namespace,
      ownerId,
      readyPath,
      goPath,
      String(durationMs),
    ],
    { cwd: path.dirname(workerPath), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`worker failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim()) as {
    ok: boolean;
    code?: string;
    operation?: string;
    authority?: SyntheticEnvironmentLeaseAuthority;
  };
}

async function rolloverWorkerResult(
  databasePath: string,
  authorityPath: string,
  readyPath: string,
  goPath: string,
): Promise<{
  ok: boolean;
  code?: string;
  authority?: SyntheticEnvironmentLeaseAuthority;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=eliza-source",
      rolloverWorkerPath,
      databasePath,
      authorityPath,
      readyPath,
      goPath,
    ],
    { cwd: path.dirname(rolloverWorkerPath), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`rollover worker failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim()) as {
    ok: boolean;
    code?: string;
    authority?: SyntheticEnvironmentLeaseAuthority;
  };
}

afterEach(async () => {
  await Promise.all(
    holders.splice(0).map(async (holder) => {
      if (holder.exitCode === null) holder.kill("SIGKILL");
      await holder.exited;
    }),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SqliteSyntheticEnvironmentLeaseStore", () => {
  it("shares the control protocol namespace contract and rejects malformed runtime input", async () => {
    const root = await tempRoot();
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "leases.sqlite"),
    );
    await expect(store.acquire(null as never)).rejects.toMatchObject({
      code: "SYNTHETIC_LEASE_INVALID_INPUT",
    });
    await expect(
      store.acquire({
        namespace: undefined as never,
        owner: { ownerId: "owner", processId: process.pid, host: hostname() },
        leaseDurationMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_INVALID_INPUT" });
    await expect(
      store.acquire({
        namespace: " namespace-with-outer-space ",
        owner: { ownerId: "owner", processId: process.pid, host: hostname() },
        leaseDurationMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_INVALID_INPUT" });
    const compatibleNamespace = `scenario/${"x".repeat(503)}`;
    const acquired = await store.acquire({
      namespace: compatibleNamespace,
      owner: { ownerId: "owner", processId: process.pid, host: hostname() },
      leaseDurationMs: 5_000,
    });
    expect(acquired.authority.namespace).toBe(compatibleNamespace);
    store.close();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symbolic-link database target",
    async () => {
      const root = await tempRoot();
      const target = path.join(root, "target.sqlite");
      await writeFile(target, "not a database", { mode: 0o600 });
      const linked = path.join(root, "linked.sqlite");
      await symlink(target, linked);
      expect(() => new SqliteSyntheticEnvironmentLeaseStore(linked)).toThrow(
        expect.objectContaining({ code: "SYNTHETIC_LEASE_INVALID_INPUT" }),
      );
    },
  );

  it("admits exactly one of two independent OS processes", async () => {
    const root = await tempRoot();
    const databasePath = path.join(root, "leases.sqlite");
    const initialized = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    initialized.close();
    const goPath = path.join(root, "go");
    const readyPaths = [path.join(root, "ready-a"), path.join(root, "ready-b")];
    const attempts = ["owner-a", "owner-b"].map((owner, index) =>
      workerResult(
        databasePath,
        "race:one",
        owner,
        readyPaths[index],
        goPath,
        5_000,
      ),
    );

    await waitForFiles(readyPaths);
    await writeFile(goPath, "go\n", { mode: 0o600 });
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "SYNTHETIC_LEASE_COLLISION" }),
    ]);
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    expect(await store.read("race:one")).toEqual(
      expect.objectContaining({ generation: 1, revision: 1, status: "active" }),
    );
    store.close();
  });

  it("recovers an expired crashed owner with a higher generation", async () => {
    const root = await tempRoot();
    const databasePath = path.join(root, "leases.sqlite");
    const firstReady = path.join(root, "first-ready");
    const firstGo = path.join(root, "first-go");
    const first = workerResult(
      databasePath,
      "recovery:one",
      "crashed-owner",
      firstReady,
      firstGo,
      80,
    );
    await waitForFiles([firstReady]);
    await writeFile(firstGo, "go\n", { mode: 0o600 });
    expect(await first).toEqual(
      expect.objectContaining({ ok: true, operation: "acquire" }),
    );
    await Bun.sleep(160);

    const secondReady = path.join(root, "second-ready");
    const secondGo = path.join(root, "second-go");
    const second = workerResult(
      databasePath,
      "recovery:one",
      "recovery-owner",
      secondReady,
      secondGo,
      5_000,
    );
    await waitForFiles([secondReady]);
    await writeFile(secondGo, "go\n", { mode: 0o600 });

    expect(await second).toEqual(
      expect.objectContaining({
        ok: true,
        operation: "recover",
        authority: expect.objectContaining({ generation: 2 }),
      }),
    );
  });

  it.skipIf(process.platform === "win32")(
    "recovers only after a SIGKILL holder's lease expires",
    async () => {
      const root = await tempRoot();
      const databasePath = path.join(root, "leases.sqlite");
      const acquiredPath = path.join(root, "killed-authority.json");
      const holder = Bun.spawn(
        [
          process.execPath,
          "--conditions=eliza-source",
          holderWorkerPath,
          databasePath,
          "recovery:killed",
          acquiredPath,
          "120",
        ],
        { cwd: path.dirname(holderWorkerPath), stdout: "pipe", stderr: "pipe" },
      );
      holders.push(holder);
      await waitForFiles([acquiredPath]);
      holder.kill("SIGKILL");
      await holder.exited;

      const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
      await expect(
        store.acquire({
          namespace: "recovery:killed",
          owner: {
            ownerId: "too-early",
            processId: process.pid,
            host: hostname(),
          },
          leaseDurationMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_COLLISION" });
      await Bun.sleep(160);
      const recovered = await store.acquire({
        namespace: "recovery:killed",
        owner: {
          ownerId: "recovery-owner",
          processId: process.pid,
          host: hostname(),
        },
        leaseDurationMs: 5_000,
      });
      expect(recovered).toEqual(
        expect.objectContaining({
          operation: "recover",
          authority: expect.objectContaining({ generation: 2 }),
        }),
      );
      store.close();
    },
  );

  it("sequences readback and refuses close during a guarded transaction", async () => {
    const root = await tempRoot();
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "leases.sqlite"),
    );
    const acquired = await store.acquire({
      namespace: "sequence:one",
      owner: { ownerId: "owner", processId: process.pid, host: hostname() },
      leaseDurationMs: 5_000,
    });
    let unblock: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const guarded = store.withActiveGeneration(acquired.authority, async () => {
      entered();
      await barrier;
    });
    await started;
    expect(() => store.close()).toThrow(
      expect.objectContaining({ code: "SYNTHETIC_LEASE_STORAGE_FAILURE" }),
    );
    let readResolved = false;
    const read = store.read("sequence:one").then((snapshot) => {
      readResolved = true;
      return snapshot;
    });
    await Bun.sleep(20);
    expect(readResolved).toBe(false);
    unblock();
    await guarded;
    expect(await read).toEqual(expect.objectContaining({ generation: 1 }));
    store.close();
    store.close();
  });

  it("admits exactly one reset generation across independent OS processes", async () => {
    const root = await tempRoot();
    const databasePath = path.join(root, "leases.sqlite");
    const authorityPath = path.join(root, "authority.json");
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const acquired = await store.acquire({
      namespace: "reset:race",
      owner: {
        ownerId: "reset-controller",
        processId: process.pid,
        host: hostname(),
      },
      leaseDurationMs: 5_000,
    });
    await writeFile(authorityPath, JSON.stringify(acquired.authority), {
      mode: 0o600,
    });
    store.close();

    const goPath = path.join(root, "reset-go");
    const readyPaths = [
      path.join(root, "reset-ready-a"),
      path.join(root, "reset-ready-b"),
    ];
    const attempts = readyPaths.map((readyPath) =>
      rolloverWorkerResult(databasePath, authorityPath, readyPath, goPath),
    );
    await waitForFiles(readyPaths);
    await writeFile(goPath, "go\n", { mode: 0o600 });
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result.ok)).toEqual([
      expect.objectContaining({
        authority: expect.objectContaining({ generation: 2 }),
      }),
    ]);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "SYNTHETIC_LEASE_LOST" }),
    ]);
    const readback = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    expect(await readback.read("reset:race")).toEqual(
      expect.objectContaining({ generation: 2, revision: 2, status: "active" }),
    );
    readback.close();
  });

  it("rejects wrong-owner release and stale writes after rollover", async () => {
    const root = await tempRoot();
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "leases.sqlite"),
    );
    store.database.run("CREATE TABLE domain_writes (value TEXT NOT NULL)");
    const acquired = await store.acquire({
      namespace: "guarded:one",
      owner: { ownerId: "owner-a", processId: process.pid, host: hostname() },
      leaseDurationMs: 5_000,
    });
    const wrongOwner = {
      ...acquired.authority,
      owner: { ...acquired.authority.owner, ownerId: "owner-b" },
    };
    await expect(store.release(wrongOwner)).rejects.toMatchObject({
      code: "SYNTHETIC_LEASE_LOST",
    });
    const heartbeat = await store.heartbeat({
      authority: acquired.authority,
      leaseDurationMs: 5_000,
    });
    expect(heartbeat).toEqual(
      expect.objectContaining({
        operation: "heartbeat",
        snapshot: expect.objectContaining({ revision: 2, status: "active" }),
      }),
    );

    const firstWrite = await store.withActiveGeneration(
      acquired.authority,
      (database) => {
        database.run(
          "INSERT INTO domain_writes (value) VALUES ('generation-1')",
        );
        return "committed";
      },
    );
    expect(firstWrite).toEqual(
      expect.objectContaining({
        value: "committed",
        receipt: expect.objectContaining({ operation: "guarded-write" }),
      }),
    );
    const rolled = await store.rollover({
      authority: acquired.authority,
      leaseDurationMs: 5_000,
    });
    expect(rolled.authority.generation).toBe(2);
    await expect(
      store.withActiveGeneration(acquired.authority, (database) => {
        database.run("INSERT INTO domain_writes (value) VALUES ('stale')");
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });
    expect(
      store.database
        .query("SELECT value FROM domain_writes ORDER BY value")
        .all(),
    ).toEqual([{ value: "generation-1" }]);

    const released = await store.release(rolled.authority);
    expect(released.snapshot).toEqual(
      expect.objectContaining({
        generation: 2,
        revision: 4,
        status: "released",
      }),
    );
    store.close();
  });

  it("rolls a write back when the lease expires before commit", async () => {
    const root = await tempRoot();
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "leases.sqlite"),
    );
    store.database.run("CREATE TABLE domain_writes (value TEXT NOT NULL)");
    const acquired = await store.acquire({
      namespace: "expiry:write",
      owner: { ownerId: "owner-a", processId: process.pid, host: hostname() },
      leaseDurationMs: 40,
    });
    await expect(
      store.withActiveGeneration(acquired.authority, async (database) => {
        database.run(
          "INSERT INTO domain_writes (value) VALUES ('must-rollback')",
        );
        await Bun.sleep(80);
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });
    expect(
      store.database.query("SELECT value FROM domain_writes").all(),
    ).toEqual([]);
    store.close();
  });
});
