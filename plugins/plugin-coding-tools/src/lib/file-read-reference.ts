/**
 * Persists private, conversation-scoped file locators for restart-safe reads.
 * Tokens authenticate the immutable record bytes, not filesystem authority;
 * callers must recheck sandbox access and the current file revision on every read.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ElizaError, logger, resolveStateDir } from "@elizaos/core";

interface FileReadLocator {
  version: 1;
  agentId: string;
  conversationId: string;
  path: string;
  revision: string;
  nonce: string;
}

const TOKEN = /^file:([a-f0-9]{64})$/;

function unavailable(): ElizaError {
  return new ElizaError("File reference is unavailable for this conversation", {
    code: "FILE_REFERENCE_UNAVAILABLE",
  });
}

async function root(): Promise<string> {
  const directory = path.join(resolveStateDir(), "coding-tools", "file-reads");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw unavailable();
  return directory;
}

export async function publishFileReadReference(input: {
  agentId: string;
  conversationId: string;
  path: string;
  revision: string;
}): Promise<string> {
  if (
    !input.agentId ||
    !input.conversationId ||
    !path.isAbsolute(input.path) ||
    !/^[a-f0-9]{64}$/.test(input.revision)
  )
    throw unavailable();
  const record: FileReadLocator = {
    version: 1,
    ...input,
    nonce: randomBytes(32).toString("hex"),
  };
  const bytes = JSON.stringify(record);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = await root();
  const pending = path.join(directory, `.pending-${randomUUID()}`);
  try {
    const handle = await fs.open(pending, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(pending, path.join(directory, `${digest}.json`));
    if (process.platform !== "win32") {
      const directoryHandle = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    try {
      await fs.rm(pending, { force: true });
    } catch (error) {
      // error-policy:J6 Failed publication cleanup must not hide the original I/O failure.
      logger.warn(
        { error },
        "[FileReadReference] Failed to remove unpublished locator",
      );
    }
  }
  return `file:${digest}`;
}

export async function resolveFileReadReference(input: {
  reference: string;
  agentId: string;
  conversationId: string;
}): Promise<{ path: string; revision: string }> {
  const match = TOKEN.exec(input.reference);
  if (!match) throw unavailable();
  try {
    const filename = path.join(await root(), `${match[1]}.json`);
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink()) throw unavailable();
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let bytes: string;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        throw unavailable();
      bytes = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (createHash("sha256").update(bytes).digest("hex") !== match[1])
      throw unavailable();
    const value: unknown = JSON.parse(bytes);
    if (!value || typeof value !== "object") throw unavailable();
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.agentId !== input.agentId ||
      record.conversationId !== input.conversationId ||
      typeof record.path !== "string" ||
      !path.isAbsolute(record.path) ||
      typeof record.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.revision) ||
      typeof record.nonce !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.nonce)
    )
      throw unavailable();
    return { path: record.path, revision: record.revision };
  } catch (cause) {
    // error-policy:J1 Do not reveal whether another conversation's locator exists.
    throw new ElizaError(
      "File reference is unavailable for this conversation",
      {
        code: "FILE_REFERENCE_UNAVAILABLE",
        cause,
      },
    );
  }
}
