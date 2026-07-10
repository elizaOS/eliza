/**
 * End-to-end proof for the iMessage collector using a real SQLite database,
 * real attachment bytes, the production Bun CLI, and deterministic reruns.
 * The fixture contains no owner data and exercises cutoff, join fanout,
 * exclusions, attachment hashing, manifests, and fail-fast missing bytes.
 */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CORPUS_CUTOFF_MS } from "../schema.ts";
import { buildCorpusManifest, validateCorpusTarget } from "../validator.ts";
import { collectIMessageCorpus } from "./imessage.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const appleEpochMs = Date.UTC(2001, 0, 1);

function appleNs(timestamp: number): bigint {
  return BigInt(timestamp - appleEpochMs) * 1_000_000n;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createChatDb(
  dbPath: string,
  attachmentPath: string,
): Promise<void> {
  await execFileAsync("/usr/bin/sqlite3", [
    dbPath,
    `
    PRAGMA journal_mode=WAL;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      chat_identifier TEXT,
      display_name TEXT,
      service_name TEXT,
      style INTEGER,
      last_read_message_timestamp INTEGER
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      date INTEGER,
      date_read INTEGER,
      date_edited INTEGER,
      date_retracted INTEGER,
      is_from_me INTEGER,
      is_read INTEGER,
      is_sent INTEGER,
      is_delivered INTEGER,
      item_type INTEGER,
      reply_to_guid TEXT,
      associated_message_guid TEXT,
      associated_message_type INTEGER,
      associated_message_emoji TEXT,
      cache_has_attachments INTEGER,
      service TEXT,
      handle_id INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      transfer_name TEXT,
      filename TEXT,
      mime_type TEXT,
      uti TEXT,
      total_bytes INTEGER,
      is_sticker INTEGER
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550000001', 'iMessage');
    INSERT INTO handle VALUES (2, '+15550000002', 'iMessage');
    INSERT INTO chat VALUES (1, 'fixture-direct', NULL, 'iMessage', 45, 0);
    INSERT INTO chat VALUES (2, 'fixture-group', 'Fixture Group', 'iMessage', 43, 0);
    INSERT INTO chat_handle_join VALUES (1, 1);
    INSERT INTO chat_handle_join VALUES (2, 1);
    INSERT INTO chat_handle_join VALUES (2, 2);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (1, 'before-cutoff', 'old', ${appleNs(CORPUS_CUTOFF_MS - 1)}, 0, 0, 0, 'iMessage', 1);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (2, 'incoming-1', 'hello', ${appleNs(Date.UTC(2024, 6, 5))}, 0, 0, 0, 'iMessage', 1);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, reply_to_guid, cache_has_attachments, service, handle_id)
      VALUES (3, 'outgoing-1', 'reply', ${appleNs(Date.UTC(2024, 7, 1))}, 1, 0, 'incoming-1', 0, 'iMessage', 1);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, associated_message_guid, associated_message_type, cache_has_attachments, service, handle_id)
      VALUES (4, 'reaction-1', NULL, ${appleNs(Date.UTC(2024, 7, 2))}, 0, 0, 'incoming-1', 2001, 0, 'iMessage', 2);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (5, 'system-1', NULL, ${appleNs(Date.UTC(2024, 7, 3))}, 0, 1, 0, 'iMessage', 2);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (6, 'attachment-only', '', ${appleNs(Date.UTC(2024, 8, 1))}, 0, 0, 1, 'iMessage', 2);
    INSERT INTO chat_message_join VALUES (1, 1);
    INSERT INTO chat_message_join VALUES (1, 2);
    INSERT INTO chat_message_join VALUES (2, 2);
    INSERT INTO chat_message_join VALUES (1, 3);
    INSERT INTO chat_message_join VALUES (2, 4);
    INSERT INTO chat_message_join VALUES (2, 5);
    INSERT INTO chat_message_join VALUES (2, 6);
    INSERT INTO attachment VALUES (1, 'attachment-1', 'fixture.bin', ${sqlString(attachmentPath)}, 'application/octet-stream', 'public.data', 5, 0);
    INSERT INTO message_attachment_join VALUES (6, 1);
  `,
  ]);
}

async function runCollector(
  root: string,
  outputName: string,
): Promise<{
  stdout: string;
  output: string;
  state: string;
}> {
  const output = path.join(root, outputName);
  const state = path.join(root, `${outputName}-state`);
  const result = await execFileAsync(
    "bun",
    collectorArgs(root, output, state),
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return { stdout: result.stdout, output, state };
}

function collectorArgs(root: string, output: string, state: string): string[] {
  return [
    "--conditions=eliza-source",
    path.resolve(import.meta.dirname, "../cli.ts"),
    "collect",
    "imessage",
    "--output",
    output,
    "--state-dir",
    state,
    "--account-id",
    "local",
    "--owner-id",
    "owner",
    "--owner-display",
    "Owner",
    "--db",
    path.join(root, "chat.db"),
    "--attachment-root",
    path.join(root, "Attachments"),
    "--page-size",
    "1",
  ];
}

async function crashCollectorAtPhase(
  root: string,
  output: string,
  state: string,
  targetPhase: string,
): Promise<void> {
  const preloadPath = path.join(root, `stop-after-${targetPhase}.mjs`);
  await fs.writeFile(
    preloadPath,
    `
      import { promises as fs } from "node:fs";
      const rename = fs.rename.bind(fs);
      fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (String(destination).endsWith("/.corpus-transaction.json")) {
          const journal = JSON.parse(await fs.readFile(destination, "utf8"));
          if (journal.phase === ${JSON.stringify(targetPhase)}) {
            process.stderr.write("crash-phase:${targetPhase}\\n");
            process.kill(process.pid, "SIGSTOP");
          }
        }
      };
    `,
    { mode: 0o600 },
  );
  const child = spawn(
    "bun",
    ["--preload", preloadPath, ...collectorArgs(root, output, state)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes(`crash-phase:${targetPhase}\n`)) resolve();
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Collector exited before ${targetPhase}: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    });
  });
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function leaveLockBySigkill(lockPath: string): Promise<void> {
  const script = `
    import { open } from "node:fs/promises";
    import { dlopen, FFIType } from "bun:ffi";
    const handle = await open(${JSON.stringify(lockPath)}, "a+", 0o600);
    const library = dlopen(
      process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
    );
    if (library.symbols.flock(handle.fd, 2 | 4) !== 0) process.exit(2);
    await handle.truncate(0);
    await handle.writeFile(String(process.pid) + "\\n");
    await handle.sync();
    process.stdout.write("locked\\n");
    await new Promise(() => {});
  `;
  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("iMessage corpus collector CLI", () => {
  it("collects, validates, hashes attachments, and reruns byte-idempotently", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "corpus-imessage-"));
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);

    const first = await runCollector(root, "output");
    const parsed = JSON.parse(first.stdout) as {
      report: { totals: Record<string, number> };
    };
    expect(parsed.report.totals).toMatchObject({
      sourceRows: 5,
      includedMessages: 3,
      excludedReactions: 1,
      excludedSystem: 1,
      attachments: 1,
      attachmentBytes: 5,
    });
    const validation = await validateCorpusTarget(first.output);
    expect(validation.ok).toBe(true);
    expect(validation.manifest.totals.messages).toBe(3);
    const before = await Promise.all(
      validation.manifest.shards.map(
        async (entry) =>
          [
            entry.path,
            await fs.readFile(path.join(first.output, entry.path), "utf8"),
          ] as const,
      ),
    );

    await runCollector(root, "output");
    const after = await Promise.all(
      validation.manifest.shards.map(
        async (entry) =>
          [
            entry.path,
            await fs.readFile(path.join(first.output, entry.path), "utf8"),
          ] as const,
      ),
    );
    expect(after).toEqual(before);
    expect(
      (await fs.stat(path.join(first.output, "manifest.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (
        await fs.stat(
          path.join(first.output, ".reports", "imessage-local.json"),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await fs.readdir(first.state)).some((name) =>
        name.startsWith("imessage-snapshot-"),
      ),
    ).toBe(false);
  }, 60_000);

  it("fails without publishing shards when attachment bytes are unavailable", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-missing-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    await createChatDb(
      path.join(root, "chat.db"),
      path.join(attachmentRoot, "missing.bin"),
    );

    await expect(runCollector(root, "failed-output")).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      fs.stat(path.join(root, "failed-output", "imessage", "local")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("rejects attachment paths outside the configured Messages attachment root", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-escape-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const outside = path.join(root, "outside.bin");
    await fs.writeFile(outside, "bytes");
    await createChatDb(path.join(root, "chat.db"), outside);

    await expect(runCollector(root, "escaped-output")).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      fs.stat(path.join(root, "escaped-output", "imessage", "local")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("rejects an intermediate attachment-directory symlink with descriptor-relative traversal", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-attachment-link-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    const outside = path.join(root, "outside-attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "fixture.bin"), "bytes");
    await fs.symlink(outside, path.join(attachmentRoot, "nested"));
    await createChatDb(
      path.join(root, "chat.db"),
      path.join(attachmentRoot, "nested", "fixture.bin"),
    );

    await expect(
      runCollector(root, "attachment-link-output"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      fs.stat(path.join(root, "attachment-link-output", "imessage", "local")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects duplicate message GUIDs before publishing", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-duplicate-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    const dbPath = path.join(root, "chat.db");
    await createChatDb(dbPath, attachmentPath);
    await execFileAsync("/usr/bin/sqlite3", [
      dbPath,
      "UPDATE message SET guid='incoming-1' WHERE ROWID=3;",
    ]);

    await expect(runCollector(root, "duplicate-output")).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      fs.stat(path.join(root, "duplicate-output", "imessage", "local")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("reclaims an unlocked lock file left by a terminated collector", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "corpus-imessage-lock-"));
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const outputDir = path.join(root, "locked-output");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, ".corpus-collection.lock"),
      "2147483647\n",
    );

    await expect(runCollector(root, "locked-output")).resolves.toMatchObject({
      output: outputDir,
    });
    const ownerPid = await fs.readFile(
      path.join(outputDir, ".corpus-collection.lock"),
      "utf8",
    );
    expect(ownerPid).toMatch(/^\d+\n$/);
    expect(ownerPid).not.toBe("2147483647\n");
  }, 60_000);

  it("serializes the whole corpus across collectors with different state directories", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-concurrent-"),
    );
    roots.push(root);
    const source = path.join(root, "source.db");
    await fs.writeFile(source, "fixture");
    let enterSnapshot: (() => void) | undefined;
    const enteredSnapshot = new Promise<void>((resolve) => {
      enterSnapshot = resolve;
    });
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const runtime = {
      defaultDbPath: source,
      async openReader() {
        return null;
      },
      async snapshot() {
        enterSnapshot?.();
        await snapshotGate;
        throw new Error("intentional snapshot stop");
      },
    };
    const base = {
      outputRoot: path.join(root, "shared-output"),
      accountId: "local",
      ownerId: "owner",
      ownerDisplay: "Owner",
      dbPath: source,
      runtime,
    };
    const first = collectIMessageCorpus({
      ...base,
      stateDir: path.join(root, "state-a"),
    });
    await enteredSnapshot;
    await expect(
      collectIMessageCorpus({
        ...base,
        accountId: "other",
        stateDir: path.join(root, "state-b"),
      }),
    ).rejects.toMatchObject({ code: "CORPUS_IMESSAGE_COLLECTION_LOCKED" });
    releaseSnapshot?.();
    await expect(first).rejects.toThrow(/intentional snapshot stop/);
    expect(await fs.readdir(path.join(root, "shared-output"))).toContain(
      ".corpus-collection.lock",
    );
    expect(
      (await fs.readdir(path.join(root, "state-a"))).some((name) =>
        name.startsWith("imessage-snapshot-"),
      ),
    ).toBe(false);
  });

  it("protects live snapshots across different outputs sharing one state directory", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-shared-state-"),
    );
    roots.push(root);
    const source = path.join(root, "source.db");
    const stateDir = path.join(root, "shared-state");
    await fs.writeFile(source, "fixture");
    let enterSnapshot: (() => void) | undefined;
    const enteredSnapshot = new Promise<void>((resolve) => {
      enterSnapshot = resolve;
    });
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const runtime = {
      defaultDbPath: source,
      async openReader() {
        return null;
      },
      async snapshot() {
        enterSnapshot?.();
        await snapshotGate;
        throw new Error("intentional shared-state stop");
      },
    };
    const first = collectIMessageCorpus({
      outputRoot: path.join(root, "output-a"),
      stateDir,
      accountId: "local",
      ownerId: "owner",
      ownerDisplay: "Owner",
      dbPath: source,
      runtime,
    });
    await enteredSnapshot;
    const liveSnapshots = (await fs.readdir(stateDir)).filter((entry) =>
      entry.startsWith("imessage-snapshot-"),
    );
    expect(liveSnapshots).toHaveLength(1);
    await expect(
      collectIMessageCorpus({
        outputRoot: path.join(root, "output-b"),
        stateDir,
        accountId: "other",
        ownerId: "owner",
        ownerDisplay: "Owner",
        dbPath: source,
        runtime,
      }),
    ).rejects.toMatchObject({ code: "CORPUS_IMESSAGE_COLLECTION_LOCKED" });
    expect(
      (await fs.readdir(stateDir)).filter((entry) =>
        entry.startsWith("imessage-snapshot-"),
      ),
    ).toEqual(liveSnapshots);
    releaseSnapshot?.();
    await expect(first).rejects.toThrow(/intentional shared-state stop/);
  });

  it("rejects nested output symlinks before writing corpus bytes through them", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-output-link-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const outside = path.join(root, "outside-output");
    const output = path.join(root, "linked-output");
    await fs.mkdir(outside);
    await fs.mkdir(output);
    await fs.symlink(outside, path.join(output, "imessage"));

    await expect(runCollector(root, "linked-output")).rejects.toMatchObject({
      code: 1,
    });
    expect(await fs.readdir(outside)).toEqual([]);
  }, 60_000);

  it("rolls back a candidate that conflicts with another corpus account", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-conflict-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const output = path.join(root, "conflict-output");
    const gmailShard = path.join(output, "gmail", "work", "2024-07.jsonl");
    await fs.mkdir(path.dirname(gmailShard), { recursive: true });
    await fs.writeFile(
      gmailShard,
      `${JSON.stringify({
        id: "incoming-1",
        platform: "gmail",
        accountId: "work",
        threadId: "gmail-thread",
        ts: Date.UTC(2024, 6, 5),
        direction: "in",
        senderId: "fixture@example.test",
        senderDisplay: "Fixture Sender",
        recipients: [{ id: "owner", display: "Owner" }],
        text: "existing corpus row",
        labels: [],
        attachments: [],
        scrubState: "raw",
      })}\n`,
    );
    const initial = await buildCorpusManifest(output);
    expect(initial.issues).toEqual([]);
    const manifestPath = path.join(output, "manifest.json");
    const manifestBytes = `${JSON.stringify(initial.manifest, null, 2)}\n`;
    await fs.writeFile(manifestPath, manifestBytes);
    const gmailBytes = await fs.readFile(gmailShard, "utf8");

    await expect(runCollector(root, "conflict-output")).rejects.toMatchObject({
      code: 1,
    });
    expect(await fs.readFile(manifestPath, "utf8")).toBe(manifestBytes);
    expect(await fs.readFile(gmailShard, "utf8")).toBe(gmailBytes);
    await expect(
      fs.stat(path.join(output, "imessage", "local")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("recovers after the real CLI is SIGKILLed at every durable transaction phase", async () => {
    for (const phase of [
      "prepared",
      "old-moved",
      "new-installed",
      "manifest-committed",
    ]) {
      const root = await fs.mkdtemp(
        path.join(tmpdir(), `corpus-imessage-kill-${phase}-`),
      );
      roots.push(root);
      const attachmentRoot = path.join(root, "Attachments");
      await fs.mkdir(attachmentRoot, { recursive: true });
      const attachmentPath = path.join(attachmentRoot, "fixture.bin");
      await fs.writeFile(attachmentPath, "bytes");
      await createChatDb(path.join(root, "chat.db"), attachmentPath);
      const initial = await runCollector(root, "kill-output");
      const lockPath = path.join(initial.output, ".corpus-collection.lock");
      const lockIdentity = await fs.stat(lockPath, { bigint: true });

      await crashCollectorAtPhase(root, initial.output, initial.state, phase);
      await expect(
        fs.stat(path.join(initial.output, ".corpus-transaction.json")),
      ).resolves.toBeDefined();
      await expect(runCollector(root, "kill-output")).resolves.toMatchObject({
        output: initial.output,
      });
      const recoveredLockIdentity = await fs.stat(lockPath, { bigint: true });
      expect(recoveredLockIdentity.dev).toBe(lockIdentity.dev);
      expect(recoveredLockIdentity.ino).toBe(lockIdentity.ino);
      await expect(
        fs.stat(path.join(initial.output, ".corpus-transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await buildCorpusManifest(initial.output)).issues).toEqual([]);
      expect(
        (await fs.readdir(initial.state)).filter((entry) =>
          entry.startsWith("imessage-snapshot-"),
        ),
      ).toEqual([]);
    }
  }, 60_000);

  it("recovers every durable publication phase before starting a new collection", async () => {
    for (const phase of [
      "prepared",
      "old-moved",
      "new-installed",
      "manifest-committed",
    ] as const) {
      const root = await fs.mkdtemp(
        path.join(tmpdir(), `corpus-imessage-recover-${phase}-`),
      );
      roots.push(root);
      const requestedOutput = path.join(root, "output");
      await fs.mkdir(requestedOutput, { recursive: true });
      const output = await fs.realpath(requestedOutput);
      const canonicalRoot = path.dirname(output);
      const destination = path.join(output, "imessage", "local");
      const stage = path.join(output, "imessage", ".local.fixture.stage");
      const backup = path.join(
        canonicalRoot,
        ".output.imessage.local.fixture.backup",
      );
      const manifestPath = path.join(output, "manifest.json");
      const reportPath = path.join(output, ".reports", "imessage-local.json");
      const oldManifest = '{"generation":"old"}\n';
      const oldReport = '{"report":"old"}\n';
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, "old.txt"), "old-generation");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(manifestPath, oldManifest);
      await fs.writeFile(reportPath, oldReport);
      await fs.mkdir(stage, { recursive: true });
      await fs.writeFile(path.join(stage, "new.txt"), "new-generation");

      if (phase !== "prepared") {
        await fs.rename(destination, backup);
      }
      if (phase === "new-installed" || phase === "manifest-committed") {
        await fs.rename(stage, destination);
        await fs.writeFile(manifestPath, '{"generation":"new"}\n');
        await fs.writeFile(reportPath, '{"report":"new"}\n');
      }
      await fs.writeFile(
        path.join(output, ".corpus-transaction.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          accountId: "local",
          phase,
          destination,
          backup,
          stage,
          manifestPath,
          reportPath,
          hadDestination: true,
          priorManifestBase64: Buffer.from(oldManifest).toString("base64"),
          priorReportBase64: Buffer.from(oldReport).toString("base64"),
        })}\n`,
      );
      if (phase === "old-moved") {
        await leaveLockBySigkill(path.join(output, ".corpus-collection.lock"));
      }
      const source = path.join(root, "source.db");
      await fs.writeFile(source, "fixture");
      const runtime = {
        defaultDbPath: source,
        async openReader() {
          return null;
        },
        async snapshot() {
          throw new Error("stop after recovery");
        },
      };

      await expect(
        collectIMessageCorpus({
          outputRoot: output,
          stateDir: path.join(root, "state"),
          accountId: "local",
          ownerId: "owner",
          ownerDisplay: "Owner",
          dbPath: source,
          runtime,
        }),
      ).rejects.toThrow(/stop after recovery/);
      await expect(
        fs.stat(path.join(output, ".corpus-transaction.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (phase === "manifest-committed") {
        expect(
          await fs.readFile(path.join(destination, "new.txt"), "utf8"),
        ).toBe("new-generation");
        expect(await fs.readFile(manifestPath, "utf8")).toContain("new");
        expect(await fs.readFile(reportPath, "utf8")).toContain("new");
      } else {
        expect(
          await fs.readFile(path.join(destination, "old.txt"), "utf8"),
        ).toBe("old-generation");
        expect(await fs.readFile(manifestPath, "utf8")).toBe(oldManifest);
        expect(await fs.readFile(reportPath, "utf8")).toBe(oldReport);
      }
      await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 60_000);
});
