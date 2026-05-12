/**
 * Probe macOS Full Disk Access (FDA) availability by attempting to open the
 * user's `chat.db`. Used by the permissions panel to show whether the
 * iMessage outbound probe is actually running or silently disabled.
 *
 * Status semantics:
 *   - "granted": the chat.db file opened successfully.
 *   - "revoked": file exists but OS denied read (EPERM / EACCES).
 *   - "not_applicable": not darwin, or chat.db is missing (user never used
 *     iMessage on this mac).
 *   - "unknown": probe threw an unclassified error.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FullDiskAccessStatus =
  | "granted"
  | "revoked"
  | "not_applicable"
  | "unknown";

export interface FullDiskAccessProbeResult {
  status: FullDiskAccessStatus;
  checkedAt: string;
  chatDbPath: string;
  reason: string | null;
}

const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

interface NodeErrno extends Error {
  code?: string;
}

function isNodeErrno(value: unknown): value is NodeErrno {
  return (
    value instanceof Error && typeof (value as NodeErrno).code === "string"
  );
}

export async function probeFullDiskAccess(overrides?: {
  chatDbPath?: string | null;
}): Promise<FullDiskAccessProbeResult> {
  const checkedAt = new Date().toISOString();
  if (process.platform !== "darwin") {
    return {
      status: "not_applicable",
      checkedAt,
      chatDbPath: "",
      reason: "FDA is only meaningful on macOS",
    };
  }
  const chatDbPath =
    (overrides?.chatDbPath?.trim() || null) ??
    process.env.IMESSAGE_DB_PATH?.trim() ??
    DEFAULT_CHAT_DB_PATH;
  try {
    const handle = await fs.open(chatDbPath, "r");
    await handle.close();
    return { status: "granted", checkedAt, chatDbPath, reason: null };
  } catch (error) {
    if (isNodeErrno(error)) {
      if (error.code === "ENOENT") {
        return {
          status: "not_applicable",
          checkedAt,
          chatDbPath,
          reason: "chat.db not present (user may never have used iMessage)",
        };
      }
      if (error.code === "EPERM" || error.code === "EACCES") {
        return {
          status: "revoked",
          checkedAt,
          chatDbPath,
          reason:
            "Full Disk Access is required to read chat.db. Grant it to the app running Eliza, such as Eliza.app, Terminal, iTerm, or Cursor, then relaunch.",
        };
      }
      return {
        status: "unknown",
        checkedAt,
        chatDbPath,
        reason: `${error.code}: ${error.message}`,
      };
    }
    return {
      status: "unknown",
      checkedAt,
      chatDbPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
