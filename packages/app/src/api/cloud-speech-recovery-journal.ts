import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CloudSpeechRecoveryJournal } from "@elizaos/host/voice/cloud-speech-relay-client";

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The filename contains only a prepared session ID. A credential or nonce is never persisted. */
export function cloudSpeechRecoveryJournal(
  stateDirectory: string,
  ownerId: string,
  origin: string,
  conversationId: string,
): CloudSpeechRecoveryJournal {
  const scope = createHash("sha256")
    .update(JSON.stringify([ownerId, origin, conversationId]))
    .digest("hex");
  const base = join(stateDirectory, "voice-retirement");
  const directory = join(base, scope);
  const privateDirectory = async (path: string) => {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw Error("Cloud speech recovery directory is not private");
  };
  const pathFor = (id: string) => {
    if (!SESSION_ID.test(id)) throw Error("Invalid Cloud speech recovery ID");
    return join(directory, id);
  };
  return {
    async pending() {
      try {
        await privateDirectory(base);
        await privateDirectory(directory);
        const entries = await readdir(directory, { withFileTypes: true });
        if (
          entries.length > 32 ||
          entries.some(
            (entry) => !entry.isFile() || !SESSION_ID.test(entry.name),
          )
        )
          throw Error("Invalid Cloud speech recovery journal");
        return entries.map((entry) => entry.name).sort();
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
    async record(id) {
      const path = pathFor(id);
      await mkdir(base, { mode: 0o700, recursive: true });
      await privateDirectory(base);
      await mkdir(directory, { mode: 0o700, recursive: true });
      await privateDirectory(directory);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(directory);
      await syncDirectory(base);
      await syncDirectory(stateDirectory);
    },
    async clear(id) {
      const path = pathFor(id);
      try {
        await privateDirectory(base);
        await privateDirectory(directory);
        await unlink(path);
        await syncDirectory(directory);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
  };
}
