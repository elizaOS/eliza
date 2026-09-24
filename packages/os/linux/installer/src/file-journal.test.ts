import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InstallRecoveryRequiredError } from "./executor";
import { DurableFileInstallJournal } from "./file-journal";
import type { InstallJournalEntry } from "./types";

const PLAN_ID = "a".repeat(64);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "elizaos-install-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

function entry(sequence: number): InstallJournalEntry {
  const body = {
    schemaVersion: 1 as const,
    planId: PLAN_ID,
    sequence,
    event:
      sequence === 0
        ? ("authorized" as const)
        : ("execution-completed" as const),
    timestamp: `2026-08-20T04:00:0${sequence}.000Z`,
    inventoryFingerprint: "b".repeat(64),
    previousDigest: sequence === 0 ? null : entry(sequence - 1).digest,
  };
  return {
    ...body,
    digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const describeLinux = describe.skipIf(process.platform !== "linux");

// Durable descriptor-relative IO relies on Linux /proc/self/fd.
describeLinux("durable file install journal", () => {
  it("rejects a FIFO without waiting for a writer or retaining the read lock", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, `${PLAN_ID}.jsonl`);
    execFileSync("mkfifo", ["--mode=600", path]);
    const modulePath = fileURLToPath(
      new URL("./file-journal.ts", import.meta.url),
    );
    // A separate process bounds the regression: a blocking FIFO open must not
    // strand the test runner's filesystem worker or prevent cleanup.
    const result = spawnSync(
      "bun",
      [
        "--eval",
        `import { DurableFileInstallJournal } from ${JSON.stringify(modulePath)};
         try {
           await new DurableFileInstallJournal(${JSON.stringify(directory)}).read(${JSON.stringify(PLAN_ID)});
           process.exitCode = 2;
         } catch (error) {
           process.stdout.write(JSON.stringify({ name: error.name, message: error.message }));
           process.exitCode = error.name === "InstallRecoveryRequiredError" ? 0 : 3;
         }`,
      ],
      { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      name: "InstallRecoveryRequiredError",
      message: expect.stringMatching(/regular file/),
    });
    expect((await lstat(path)).isFIFO()).toBe(true);
    await expect(
      lstat(join(directory, `${PLAN_ID}.lock`)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists owner-only JSONL records and releases its durable writer lock", async () => {
    const directory = await temporaryDirectory();
    const journal = new DurableFileInstallJournal(directory);
    await journal.append(entry(0));
    await journal.append(entry(1));

    expect(await journal.read(PLAN_ID)).toEqual([entry(0), entry(1)]);
    expect(
      (await lstat(join(directory, `${PLAN_ID}.jsonl`))).mode & 0o777,
    ).toBe(0o600);
    await expect(
      lstat(join(directory, `${PLAN_ID}.lock`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on an interrupted or concurrent writer lock", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, `${PLAN_ID}.lock`), "interrupted", {
      mode: 0o600,
    });

    await expect(
      new DurableFileInstallJournal(directory).read(PLAN_ID),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("rejects a stale concurrent append without damaging or locking the journal", async () => {
    const directory = await temporaryDirectory();
    const journal = new DurableFileInstallJournal(directory);
    await journal.append(entry(0));

    await expect(journal.append(entry(0))).rejects.toThrow(/stale/);
    expect(await journal.read(PLAN_ID)).toEqual([entry(0)]);
    await expect(
      lstat(join(directory, `${PLAN_ID}.lock`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a partial final record", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, `${PLAN_ID}.jsonl`),
      JSON.stringify(entry(0)),
      {
        mode: 0o600,
      },
    );

    await expect(
      new DurableFileInstallJournal(directory).read(PLAN_ID),
    ).rejects.toThrow(/partial record/);
  });

  it("refuses linked journal files", async () => {
    const directory = await temporaryDirectory();
    const outside = join(directory, "outside");
    await writeFile(outside, `${JSON.stringify(entry(0))}\n`, { mode: 0o600 });
    await symlink(outside, join(directory, `${PLAN_ID}.jsonl`));
    await expect(
      new DurableFileInstallJournal(directory).read(PLAN_ID),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);

    const secondDirectory = await temporaryDirectory();
    const original = join(secondDirectory, "original");
    await writeFile(original, `${JSON.stringify(entry(0))}\n`, { mode: 0o600 });
    await link(original, join(secondDirectory, `${PLAN_ID}.jsonl`));
    await expect(
      new DurableFileInstallJournal(secondDirectory).read(PLAN_ID),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("refuses non-private or symlinked journal directories", async () => {
    const directory = await temporaryDirectory();
    await chmod(directory, 0o755);
    await expect(
      new DurableFileInstallJournal(directory).read(PLAN_ID),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);

    const parent = await temporaryDirectory();
    const privateDirectory = join(parent, "private");
    await mkdir(privateDirectory, { mode: 0o700 });
    const linkedDirectory = join(parent, "linked");
    await symlink(privateDirectory, linkedDirectory);
    await expect(
      new DurableFileInstallJournal(linkedDirectory).read(PLAN_ID),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("refuses a journal reached through an untrusted writable ancestor", async () => {
    const parent = await temporaryDirectory();
    const unsafeAncestor = join(parent, "unsafe");
    const directory = join(unsafeAncestor, "journal");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(unsafeAncestor, 0o777);

    await expect(
      new DurableFileInstallJournal(directory).read(PLAN_ID),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("rejects path-like plan identifiers before filesystem access", async () => {
    expect(() => new DurableFileInstallJournal("relative/journal")).toThrow(
      /absolute path/,
    );
    const directory = await temporaryDirectory();
    await expect(
      new DurableFileInstallJournal(directory).read("../target"),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });
});
