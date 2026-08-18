/**
 * Deterministic filesystem coverage for the Telegram Desktop collector using
 * only a committed synthetic `result.json`. The harness exercises real shard,
 * manifest, allowlist, boundary-validation, and rerun behavior without network
 * access, Telegram credentials, sessions, or private owner data.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCorpusTarget } from "../validator.ts";
import { collectTelegramDesktopExport } from "./telegram-desktop.ts";
import { writeTelegramShards } from "./telegram-desktop-io.ts";

const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "../../fixtures/telegram-desktop/result.json",
);
const OWNER = "100";
const tempDirs: string[] = [];

async function makeTempDir(prefix = "telegram-desktop-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function copyFixture(): Promise<string> {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "result.json");
  await fs.copyFile(FIXTURE_PATH, filePath);
  return filePath;
}

async function mutateFixture(
  mutate: (input: Record<string, unknown>) => void,
): Promise<string> {
  const filePath = await copyFixture();
  const input = JSON.parse(await fs.readFile(filePath, "utf8"));
  mutate(input);
  await fs.writeFile(filePath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return filePath;
}

async function collectFixture(exportPath: string, outDir: string) {
  return collectTelegramDesktopExport({
    exportPath,
    ownerAccountId: OWNER,
    outDir,
    allowedGroupPeerIds: ["300"],
    allowedChannelPeerIds: ["400"],
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("collectTelegramDesktopExport", () => {
  it("maps DMs and allowlisted peers with compound identities and frozen bounds", async () => {
    const outDir = await makeTempDir();
    const result = await collectFixture(FIXTURE_PATH, outDir);

    expect(result.issues).toEqual([]);
    expect(result.manifest.totals.messages).toBe(6);
    expect(result.summary.peerCounts).toEqual({ dm: 1, group: 1, channel: 1 });
    expect(result.summary.messageCounts).toEqual({
      dm: 3,
      group: 2,
      channel: 1,
    });
    expect(result.summary.deniedGroupChats).toBe(1);
    expect(result.summary.deniedGroupMessages).toBe(1);
    expect(result.summary.deniedChannelChats).toBe(1);
    expect(result.summary.deniedChannelMessages).toBe(1);
    expect(result.summary.unsupportedSecretChats).toBe(1);
    expect(result.summary.unsupportedSecretMessages).toBe(2);
    expect(result.summary.unsupportedMessages).toBe(0);
    expect(result.summary.unsupportedDeletedMessages).toBe(1);
    expect(result.summary.unsupportedServiceMessages).toBe(1);
    expect(result.summary.unsupportedMediaOnlyMessages).toBe(1);
    expect(result.summary.skippedBeforeCutoff).toBe(1);
    expect(result.summary.skippedAfterAnchor).toBe(1);

    const august = (
      await fs.readFile(
        path.join(outDir, "telegram", OWNER, "2024-08.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(august.map((message) => message.id)).toEqual([
      "telegram:100:dm:200:1",
      "telegram:100:dm:200:2",
      "telegram:100:dm:200:8",
    ]);
    expect(august[0]).toMatchObject({
      text: "hello owner",
      direction: "in",
      threadId: "telegram:100:dm:200",
    });
    expect(august[1]).toMatchObject({
      direction: "out",
      replyToId: "telegram:100:dm:200:1",
    });
    expect(august[2].attachments).toEqual([]);
    expect(JSON.stringify(august[2])).not.toContain("sha256");

    const september = (
      await fs.readFile(
        path.join(outDir, "telegram", OWNER, "2024-09.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(september[0].id).toBe("telegram:100:group:300:1");
    expect(september[1].replyToId).toBe("telegram:100:group:300:1");

    const october = JSON.parse(
      (
        await fs.readFile(
          path.join(outDir, "telegram", OWNER, "2024-10.jsonl"),
          "utf8",
        )
      ).trim(),
    );
    expect(october).toMatchObject({
      id: "telegram:100:channel:400:1",
      direction: "in",
      senderId: "channel400",
      senderDisplay: "Synthetic Channel Author",
    });

    const validation = await validateCorpusTarget(outDir);
    expect(validation.ok).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it("denies every group and channel unless its peer id is explicitly allowed", async () => {
    const outDir = await makeTempDir();
    const result = await collectTelegramDesktopExport({
      exportPath: FIXTURE_PATH,
      ownerAccountId: OWNER,
      outDir,
    });

    expect(result.summary.peerCounts).toEqual({ dm: 1, group: 0, channel: 0 });
    expect(result.summary.deniedGroupChats).toBe(2);
    expect(result.summary.deniedGroupMessages).toBe(3);
    expect(result.summary.deniedChannelChats).toBe(2);
    expect(result.summary.deniedChannelMessages).toBe(2);
    expect(result.manifest.totals.messages).toBe(3);
    expect(await fs.readdir(path.join(outDir, "telegram", OWNER))).toEqual([
      "2024-08.jsonl",
    ]);
  });

  it("keeps equal numeric peer and message ids distinct across peer kinds", async () => {
    const exportPath = await mutateFixture((input) => {
      const chats = input.chats as {
        list: Array<{ id: number; messages: Array<Record<string, unknown>> }>;
      };
      const group = chats.list.find((chat) => chat.id === 300);
      const channel = chats.list.find((chat) => chat.id === 400);
      if (group) group.id = 200;
      if (channel) channel.id = 200;
    });
    const outDir = await makeTempDir();
    const result = await collectTelegramDesktopExport({
      exportPath,
      ownerAccountId: OWNER,
      outDir,
      allowedGroupPeerIds: ["200"],
      allowedChannelPeerIds: ["200"],
    });

    expect(result.manifest.totals.messages).toBe(6);
    const rows = await Promise.all(
      result.shardPaths.map(async (shardPath) =>
        (await fs.readFile(shardPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { id: string }),
      ),
    );
    expect(new Set(rows.flat().map((row) => row.id)).size).toBe(6);
    expect(rows.flat().map((row) => row.id)).toEqual(
      expect.arrayContaining([
        "telegram:100:dm:200:1",
        "telegram:100:group:200:1",
        "telegram:100:channel:200:1",
      ]),
    );
  });

  it("includes messages exactly on both frozen time boundaries", async () => {
    const exportPath = await mutateFixture((input) => {
      const chats = input.chats as {
        list: Array<{ id: number; messages: Array<Record<string, unknown>> }>;
      };
      const dm = chats.list.find((chat) => chat.id === 200);
      if (!dm) return;
      dm.messages = [
        {
          ...dm.messages[0],
          id: 20,
          date_unixtime: String(Date.parse("2024-07-05T00:00:00.000Z") / 1000),
        },
        {
          ...dm.messages[0],
          id: 21,
          date_unixtime: String(Date.parse("2026-07-05T00:00:00.000Z") / 1000),
        },
      ];
    });
    const outDir = await makeTempDir();

    const result = await collectFixture(exportPath, outDir);

    expect(result.summary.messageCounts.dm).toBe(2);
    expect(result.summary.skippedBeforeCutoff).toBe(0);
    expect(result.summary.skippedAfterAnchor).toBe(0);
  });

  it("is byte-idempotent and repairs a missing shard on rerun", async () => {
    const outDir = await makeTempDir();
    const first = await collectFixture(FIXTURE_PATH, outDir);
    expect(first.writeStats).toEqual({ written: 3, reused: 0, removed: 0 });
    const artifactPaths = [
      path.join(outDir, "manifest.json"),
      path.join(outDir, "telegram-desktop-summary.json"),
      ...first.shardPaths,
    ];
    const firstBytes = await Promise.all(
      artifactPaths.map((filePath) => fs.readFile(filePath, "utf8")),
    );

    const rerun = await collectFixture(FIXTURE_PATH, outDir);
    expect(rerun.writeStats).toEqual({ written: 0, reused: 3, removed: 0 });
    await expect(
      Promise.all(
        artifactPaths.map((filePath) => fs.readFile(filePath, "utf8")),
      ),
    ).resolves.toEqual(firstBytes);

    await fs.unlink(path.join(outDir, "telegram", OWNER, "2024-09.jsonl"));
    const repaired = await collectFixture(FIXTURE_PATH, outDir);
    expect(repaired.writeStats).toEqual({ written: 1, reused: 2, removed: 0 });
    await expect(
      Promise.all(
        artifactPaths.map((filePath) => fs.readFile(filePath, "utf8")),
      ),
    ).resolves.toEqual(firstBytes);
  });

  it("removes stale owned shards when the input no longer contains that month", async () => {
    const exportPath = await mutateFixture((input) => {
      const chats = input.chats as {
        list: Array<{ id: number; messages: unknown[] }>;
      };
      const channel = chats.list.find((chat) => chat.id === 400);
      if (channel) channel.messages = [];
    });
    const outDir = await makeTempDir();
    await collectFixture(FIXTURE_PATH, outDir);
    const result = await collectFixture(exportPath, outDir);

    expect(result.writeStats.removed).toBe(1);
    await expect(
      fs.access(path.join(outDir, "telegram", OWNER, "2024-10.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
  });

  it("does not delete non-shard JSONL files from the account directory", async () => {
    const outDir = await makeTempDir();
    const shardDir = path.join(outDir, "telegram", OWNER);
    await fs.mkdir(shardDir, { recursive: true });
    const foreignPath = path.join(shardDir, "owner-notes.jsonl");
    await fs.writeFile(foreignPath, '{"not":"collector-owned"}\n', "utf8");

    const result = await writeTelegramShards([], outDir, OWNER);

    expect(result.stats.removed).toBe(0);
    await expect(fs.readFile(foreignPath, "utf8")).resolves.toBe(
      '{"not":"collector-owned"}\n',
    );
  });

  it("writes owner corpus artifacts with private file permissions", async () => {
    if (process.platform === "win32") return;
    const outDir = await makeTempDir();
    const result = await collectFixture(FIXTURE_PATH, outDir);
    const artifactPaths = [
      ...result.shardPaths,
      path.join(outDir, "manifest.json"),
      path.join(outDir, "telegram-desktop-summary.json"),
    ];

    for (const artifactPath of artifactPaths) {
      expect((await fs.stat(artifactPath)).mode & 0o777).toBe(0o600);
    }
    expect(
      (await fs.stat(path.join(outDir, "telegram", OWNER))).mode & 0o777,
    ).toBe(0o700);

    await fs.chmod(result.shardPaths[0], 0o644);
    await fs.chmod(path.join(outDir, "telegram", OWNER), 0o755);
    const rerun = await collectFixture(FIXTURE_PATH, outDir);
    expect(rerun.writeStats.reused).toBe(3);
    expect((await fs.stat(result.shardPaths[0])).mode & 0o777).toBe(0o600);
    expect(
      (await fs.stat(path.join(outDir, "telegram", OWNER))).mode & 0o777,
    ).toBe(0o700);
  });

  it("fails closed on malformed JSON, wrong files, symlinks, and size limits", async () => {
    const outDir = await makeTempDir();
    const malformedDir = await makeTempDir();
    const malformed = path.join(malformedDir, "result.json");
    await fs.writeFile(malformed, "{ nope", "utf8");
    await expect(collectFixture(malformed, outDir)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_JSON",
    });

    const wrongNameDir = await makeTempDir();
    const wrongName = path.join(wrongNameDir, "telegram.json");
    await fs.copyFile(FIXTURE_PATH, wrongName);
    await expect(collectFixture(wrongName, outDir)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_PATH",
    });

    await expect(
      collectTelegramDesktopExport({
        exportPath: FIXTURE_PATH,
        ownerAccountId: OWNER,
        outDir,
        maxInputBytes: 16,
      }),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_INPUT_TOO_LARGE" });

    if (process.platform !== "win32") {
      const linkDir = await makeTempDir();
      const link = path.join(linkDir, "result.json");
      await fs.symlink(FIXTURE_PATH, link);
      await expect(collectFixture(link, outDir)).rejects.toMatchObject({
        code: "TELEGRAM_EXPORT_BAD_PATH",
      });
    }
  });

  it("enforces owner, count, identity, and allowlist boundaries", async () => {
    const outDir = await makeTempDir();
    await expect(
      collectTelegramDesktopExport({
        exportPath: FIXTURE_PATH,
        ownerAccountId: "101",
        outDir,
      }),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_OWNER_MISMATCH" });
    await expect(
      collectTelegramDesktopExport({
        exportPath: FIXTURE_PATH,
        ownerAccountId: OWNER,
        outDir,
        maxChats: 1,
      }),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_COUNT_LIMIT" });
    await expect(
      collectTelegramDesktopExport({
        exportPath: FIXTURE_PATH,
        ownerAccountId: OWNER,
        outDir,
        maxMessages: 1,
      }),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_COUNT_LIMIT" });
    await expect(
      collectTelegramDesktopExport({
        exportPath: FIXTURE_PATH,
        ownerAccountId: OWNER,
        outDir,
        allowedGroupPeerIds: ["300", "300"],
      }),
    ).rejects.toMatchObject({ code: "TELEGRAM_EXPORT_BAD_ALLOWLIST" });
  });

  it("rejects duplicate ids, unknown record types, and malformed rich text", async () => {
    const outDir = await makeTempDir();
    const duplicate = await mutateFixture((input) => {
      const chats = input.chats as { list: Array<{ messages: unknown[] }> };
      chats.list[0].messages.push(chats.list[0].messages[0]);
    });
    await expect(collectFixture(duplicate, outDir)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_DUPLICATE_MESSAGE",
    });

    const unknownType = await mutateFixture((input) => {
      const chats = input.chats as {
        list: Array<{ messages: Array<Record<string, unknown>> }>;
      };
      chats.list[0].messages[0].type = "mystery";
    });
    await expect(collectFixture(unknownType, outDir)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_UNSUPPORTED_MESSAGE_TYPE",
    });

    const badText = await mutateFixture((input) => {
      const chats = input.chats as {
        list: Array<{ messages: Array<Record<string, unknown>> }>;
      };
      chats.list[0].messages[0].text = [{ type: "bold", text: 42 }];
    });
    await expect(collectFixture(badText, outDir)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_SHAPE",
    });
  });

  it("counts explicitly unsupported rows separately from media-only rows", async () => {
    const exportPath = await mutateFixture((input) => {
      const chats = input.chats as {
        list: Array<{ id: number; messages: Array<Record<string, unknown>> }>;
      };
      const channel = chats.list.find((chat) => chat.id === 400);
      if (channel) channel.messages[0].type = "unsupported";
    });
    const outDir = await makeTempDir();

    const result = await collectFixture(exportPath, outDir);

    expect(result.summary.unsupportedMessages).toBe(1);
    expect(result.summary.unsupportedMediaOnlyMessages).toBe(1);
  });

  it("rejects symlinked collector-owned output directories", async () => {
    if (process.platform === "win32") return;
    const exportPath = await copyFixture();
    const outDir = await makeTempDir();
    const outside = await makeTempDir();
    await fs.mkdir(path.join(outDir, "telegram"));
    await fs.symlink(outside, path.join(outDir, "telegram", OWNER));

    await expect(collectFixture(exportPath, outDir)).rejects.toMatchObject({
      code: "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
