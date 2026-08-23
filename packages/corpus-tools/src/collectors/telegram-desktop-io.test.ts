/**
 * Deterministic filesystem coverage for the Telegram Desktop shard I/O
 * boundary using only temporary directories. The harness exercises real
 * path, size, identity, duplicate-key, lock, and idempotent-rerun behavior
 * without network access, Telegram credentials, or private owner data.
 */
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorpusMessage } from "../schema.ts";
import {
  invalidateTelegramManifest,
  readTelegramDesktopJson,
  withTelegramOutputLock,
  writeTelegramArtifact,
  writeTelegramShards,
} from "./telegram-desktop-io.ts";

const OWNER = "100";
const LOCK_NAME = ".telegram-desktop-collector.lock";
const tempDirs: string[] = [];

async function makeTempDir(
  prefix = "telegram-desktop-io-test-",
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(overrides: Partial<CorpusMessage> = {}): CorpusMessage {
  return {
    id: overrides.id ?? "telegram:100:dm:200:m1",
    platform: "telegram",
    accountId: OWNER,
    threadId: "telegram:100:dm:200",
    ts: Date.UTC(2024, 7, 1, 12, 0, 0),
    direction: "in",
    senderId: "200",
    senderDisplay: "Peer",
    recipients: [{ id: OWNER }],
    text: "hello",
    labels: [],
    attachments: [],
    scrubState: "raw",
    ...overrides,
  };
}

async function until(probe: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await probe();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("condition not reached before timeout");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("readTelegramDesktopJson", () => {
  it("rejects an input that is not named result.json", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "export.json");
    await fs.writeFile(exportPath, "{}", "utf8");

    await expect(
      readTelegramDesktopJson(exportPath, 1024),
    ).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_PATH",
    });
  });

  it("rejects a missing input file", async () => {
    const dir = await makeTempDir();

    await expect(
      readTelegramDesktopJson(path.join(dir, "result.json"), 1024),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_BAD_PATH" });
  });

  it("rejects a symlinked input instead of following it", async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, "real-result.json");
    await fs.writeFile(target, "{}", "utf8");
    const link = path.join(dir, "result.json");
    await fs.symlink(target, link);

    await expect(readTelegramDesktopJson(link, 1024)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_PATH",
    });
  });

  it("rejects an input with more than one hard link", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "result.json");
    await fs.writeFile(exportPath, "{}", "utf8");
    await fs.link(exportPath, path.join(dir, "alias-result.json"));

    await expect(
      readTelegramDesktopJson(exportPath, 1024),
    ).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_PATH",
    });
  });

  it("rejects input larger than the byte budget", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "result.json");
    await fs.writeFile(exportPath, '{"a":1,"b":2}', "utf8");

    await expect(readTelegramDesktopJson(exportPath, 8)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_INPUT_TOO_LARGE",
    });
  });

  it("accepts input of exactly the byte budget and parses the value", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "result.json");
    const body = '{"a":[1,{"b":"x"}]}';
    await fs.writeFile(exportPath, body, "utf8");

    await expect(
      readTelegramDesktopJson(exportPath, Buffer.byteLength(body)),
    ).resolves.toEqual({ a: [1, { b: "x" }] });
  });

  it("wraps malformed JSON in a typed boundary error", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "result.json");
    await fs.writeFile(exportPath, "{not json", "utf8");

    await expect(
      readTelegramDesktopJson(exportPath, 1024),
    ).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_JSON",
    });
  });

  it("rejects duplicate top-level object keys", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "result.json");
    await fs.writeFile(exportPath, '{"a":1,"a":2}', "utf8");

    await expect(
      readTelegramDesktopJson(exportPath, 1024),
    ).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_DUPLICATE_KEY",
    });
  });

  it("rejects escaped-key aliases of an already-seen key", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "result.json");
    await fs.writeFile(exportPath, '{"id":1,"\\u0069d":2}', "utf8");

    await expect(
      readTelegramDesktopJson(exportPath, 1024),
    ).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_DUPLICATE_KEY",
    });
  });

  it("allows the same key name inside sibling nested objects", async () => {
    const dir = await makeTempDir();
    const exportPath = path.join(dir, "result.json");
    await fs.writeFile(exportPath, '{"x":{"k":1},"y":{"k":2}}', "utf8");

    await expect(readTelegramDesktopJson(exportPath, 1024)).resolves.toEqual({
      x: { k: 1 },
      y: { k: 2 },
    });
  });
});

describe("invalidateTelegramManifest", () => {
  it("resolves when no prior manifest exists and revalidates ancestry twice", async () => {
    const dir = await makeTempDir();
    let ancestorChecks = 0;

    await invalidateTelegramManifest(
      path.join(dir, "manifest.json"),
      async () => {
        ancestorChecks += 1;
      },
    );

    expect(ancestorChecks).toBe(2);
  });

  it("removes an existing manifest and revalidates ancestry around the unlink", async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, "manifest.json");
    await fs.writeFile(manifestPath, "{}", "utf8");
    let ancestorChecks = 0;

    await invalidateTelegramManifest(manifestPath, async () => {
      ancestorChecks += 1;
    });

    expect(ancestorChecks).toBe(3);
    await expect(fs.access(manifestPath, constants.F_OK)).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("propagates an ancestor identity failure before touching the manifest", async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, "manifest.json");
    await fs.writeFile(manifestPath, "{}", "utf8");

    await expect(
      invalidateTelegramManifest(manifestPath, async () => {
        throw Object.assign(new Error("ancestor moved"), {
          code: "E_ANCESTOR",
        });
      }),
    ).rejects.toMatchObject({ code: "E_ANCESTOR" });
    await expect(
      fs.access(manifestPath, constants.F_OK),
    ).resolves.toBeUndefined();
  });
});

describe("writeTelegramArtifact", () => {
  it("creates parent directories and writes a fresh artifact", async () => {
    const dir = await makeTempDir();
    const artifactPath = path.join(dir, "nested", "deeper", "artifact.json");
    let ancestorChecks = 0;

    const outcome = await writeTelegramArtifact(
      artifactPath,
      '{"v":1}',
      async () => {
        ancestorChecks += 1;
      },
    );

    expect(outcome).toBe("written");
    expect(ancestorChecks).toBeGreaterThanOrEqual(2);
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe('{"v":1}');
    if (process.platform !== "win32") {
      const stat = await fs.stat(artifactPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("reuses a byte-identical rewrite and reports reused", async () => {
    const dir = await makeTempDir();
    const artifactPath = path.join(dir, "artifact.json");
    const writeFirst = await writeTelegramArtifact(
      artifactPath,
      "same-bytes",
      async () => {},
    );
    const statBefore = await fs.stat(artifactPath);

    const outcome = await writeTelegramArtifact(
      artifactPath,
      "same-bytes",
      async () => {},
    );

    expect(writeFirst).toBe("written");
    expect(outcome).toBe("reused");
    const statAfter = await fs.stat(artifactPath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("rewrites changed bytes atomically without leaving temporaries", async () => {
    const dir = await makeTempDir();
    const artifactPath = path.join(dir, "artifact.json");
    await writeTelegramArtifact(artifactPath, "old", async () => {});

    const outcome = await writeTelegramArtifact(
      artifactPath,
      "new",
      async () => {},
    );

    expect(outcome).toBe("written");
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("new");
    const entries = await fs.readdir(dir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("withTelegramOutputLock", () => {
  it("runs the operation under the lock and passes its value through", async () => {
    const outDir = await makeTempDir();
    const lockPath = path.join(outDir, LOCK_NAME);

    const result = await withTelegramOutputLock(
      outDir,
      async (assertRootIdentity) => {
        await assertRootIdentity();
        await expect(fs.stat(lockPath)).resolves.toMatchObject({});
        return 41 + 1;
      },
    );

    expect(result).toBe(42);
    await expect(fs.access(lockPath, constants.F_OK)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed against a concurrent writer that already holds the lock", async () => {
    const outDir = await makeTempDir();
    const lockPath = path.join(outDir, LOCK_NAME);
    let releaseInner!: () => void;
    const innerGate = new Promise<void>((resolve) => {
      releaseInner = resolve;
    });
    const first = withTelegramOutputLock(outDir, async () => {
      await innerGate;
    });
    await until(async () => {
      await fs.access(lockPath, constants.F_OK);
    });

    await expect(
      withTelegramOutputLock(outDir, async () => {}),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_OUTPUT_BUSY" });

    releaseInner();
    await expect(first).resolves.toBeUndefined();
    await expect(fs.access(lockPath, constants.F_OK)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("releases the lock when the operation throws so a retry succeeds", async () => {
    const outDir = await makeTempDir();
    const failure = new Error("operation exploded");

    await expect(
      withTelegramOutputLock(outDir, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(
      withTelegramOutputLock(outDir, async () => "retry-ok"),
    ).resolves.toBe("retry-ok");
  });
});

describe("writeTelegramShards", () => {
  it("buckets messages into per-month shards ordered by timestamp then id", async () => {
    const outDir = await makeTempDir();
    const messages = [
      makeMessage({ id: "m-b", ts: Date.UTC(2024, 7, 2) }),
      makeMessage({ id: "m-c", ts: Date.UTC(2024, 6, 5) }),
      makeMessage({ id: "m-a", ts: Date.UTC(2024, 7, 2), text: "tie" }),
    ];

    const { paths, stats } = await writeTelegramShards(messages, outDir, OWNER);

    expect(stats).toEqual({ written: 2, reused: 0, removed: 0 });
    expect(paths).toEqual([
      path.join(outDir, "telegram", OWNER, "2024-07.jsonl"),
      path.join(outDir, "telegram", OWNER, "2024-08.jsonl"),
    ]);
    const augustRows = (await fs.readFile(paths[1], "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CorpusMessage);
    expect(augustRows.map((row) => row.id)).toEqual(["m-a", "m-b"]);
    if (process.platform !== "win32") {
      const stat = await fs.stat(paths[0]);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("writes nothing for an empty message queue", async () => {
    const outDir = await makeTempDir();

    const { paths, stats } = await writeTelegramShards([], outDir, OWNER);

    expect(paths).toEqual([]);
    expect(stats).toEqual({ written: 0, reused: 0, removed: 0 });
    const entries = await fs.readdir(path.join(outDir, "telegram", OWNER));
    expect(entries.filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))).toEqual(
      [],
    );
  });

  it("reruns idempotently: identical input reuses every shard", async () => {
    const outDir = await makeTempDir();
    const messages = [
      makeMessage({ ts: Date.UTC(2024, 7, 1) }),
      makeMessage({ id: "m2", ts: Date.UTC(2024, 6, 1) }),
    ];
    await writeTelegramShards(messages, outDir, OWNER);

    const second = await writeTelegramShards(messages, outDir, OWNER);

    expect(second.stats).toEqual({ written: 0, reused: 2, removed: 0 });
  });

  it("rewrites only the shard whose rows changed", async () => {
    const outDir = await makeTempDir();
    const july = makeMessage({ id: "m-july", ts: Date.UTC(2024, 6, 1) });
    const august = makeMessage({ id: "m-august", ts: Date.UTC(2024, 7, 1) });
    await writeTelegramShards([july, august], outDir, OWNER);

    const changed = { ...august, text: "edited" };
    const rerun = await writeTelegramShards([july, changed], outDir, OWNER);

    expect(rerun.stats).toEqual({ written: 1, reused: 1, removed: 0 });
    const augustRows = (await fs.readFile(rerun.paths[1], "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CorpusMessage);
    expect(augustRows[0].text).toBe("edited");
  });

  it("removes stale owned months while ignoring foreign files", async () => {
    const outDir = await makeTempDir();
    await writeTelegramShards(
      [makeMessage({ ts: Date.UTC(2023, 6, 1) })],
      outDir,
      OWNER,
    );
    const strayKept = path.join(outDir, "telegram", OWNER, "notes.txt");
    const strayUnownedMonth = path.join(
      outDir,
      "telegram",
      OWNER,
      "2024-13.jsonl",
    );
    await fs.writeFile(strayKept, "keep me", "utf8");
    await fs.writeFile(strayUnownedMonth, "not a valid month", "utf8");

    const rerun = await writeTelegramShards(
      [makeMessage({ ts: Date.UTC(2024, 7, 1) })],
      outDir,
      OWNER,
    );

    expect(rerun.stats.removed).toBe(1);
    expect(rerun.paths).toEqual([
      path.join(outDir, "telegram", OWNER, "2024-08.jsonl"),
    ]);
    await expect(
      fs.access(path.join(outDir, "telegram", OWNER, "2023-07.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(strayKept, "utf8")).resolves.toBe("keep me");
    await expect(fs.readFile(strayUnownedMonth, "utf8")).resolves.toBe(
      "not a valid month",
    );
  });

  it("invokes beforeMutation exactly once across writes and removals", async () => {
    const outDir = await makeTempDir();
    await writeTelegramShards(
      [makeMessage({ ts: Date.UTC(2023, 6, 1) })],
      outDir,
      OWNER,
    );
    let mutations = 0;

    await writeTelegramShards(
      [
        makeMessage({ ts: Date.UTC(2024, 7, 1) }),
        makeMessage({ id: "m2", ts: Date.UTC(2024, 8, 1) }),
      ],
      outDir,
      OWNER,
      async () => {
        mutations += 1;
      },
    );

    expect(mutations).toBe(1);
    expect(
      (await fs.readdir(path.join(outDir, "telegram", OWNER))).sort(),
    ).toEqual(["2024-08.jsonl", "2024-09.jsonl"]);
  });

  it("refuses to unlink a stale owned name that is not a regular file", async () => {
    const outDir = await makeTempDir();
    const staleDir = path.join(outDir, "telegram", OWNER, "2024-06.jsonl");
    await fs.mkdir(staleDir, { recursive: true });

    await expect(
      writeTelegramShards(
        [makeMessage({ ts: Date.UTC(2024, 7, 1) })],
        outDir,
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_BAD_OUTPUT_PATH" });
  });
});
