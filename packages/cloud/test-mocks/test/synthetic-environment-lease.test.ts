/**
 * Proves local synthetic namespace fencing through real file-backed SQLite and
 * independent Bun processes, including collision, expiry, and write rollback.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import { SqliteSyntheticEnvironmentLeaseStore } from "../src/synthetic-environment/sqlite-lease-store";

const roots: string[] = [];
const workerPath = fileURLToPath(
  new URL("./fixtures/synthetic-lease-worker.ts", import.meta.url),
);
const rolloverWorkerPath = fileURLToPath(
  new URL("./fixtures/synthetic-rollover-worker.ts", import.meta.url),
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
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SqliteSyntheticEnvironmentLeaseStore", () => {
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
