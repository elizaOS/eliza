/**
 * Files API client methods (PR5, attachments v1) — list / delete over
 * `/api/files`. Declaration-merged onto `ElizaClient` (the side-effect import
 * in `client.ts` installs the prototype methods), matching the other
 * `client-*` domain modules.
 *
 * Backend contract (already implemented on the agent server):
 *  - `GET /api/files` → `{ files: StoredFile[], restricted: boolean }`
 *    (newest first; authenticated; `restricted: true` means the viewer's role
 *    cannot see the store listing — a designed state, not an empty store,
 *    #14781. Optional in the client type for older backends that predate it.)
 *  - `DELETE /api/files/:filename` → `{ deleted: boolean }` (authenticated).
 */

import { ElizaClient } from "./client-base";

/** One stored file as returned by `GET /api/files`. */
export interface StoredFile {
  /** Resolvable URL for the file's bytes. */
  url: string;
  /** Content hash (stable identity for the bytes). */
  hash: string;
  /** Stored filename — also the `:filename` path segment for delete. */
  fileName: string;
  /** MIME type, e.g. `image/png`, `application/pdf`. */
  mimeType: string;
  /** Size in bytes. */
  size: number;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/** List GET — existing 10s REST budget, independent hop. */
export const FILES_LIST_FETCH_TIMEOUT_MS = 10_000;
/** Delete DELETE — existing 10s REST budget, independent hop. */
export const FILES_DELETE_FETCH_TIMEOUT_MS = 10_000;

declare module "./client-base" {
  interface ElizaClient {
    listFiles(
      timeoutMs?: number,
    ): Promise<{ files: StoredFile[]; restricted?: boolean }>;
    deleteFile(
      fileName: string,
      timeoutMs?: number,
    ): Promise<{ deleted: boolean }>;
  }
}

ElizaClient.prototype.listFiles = async function (
  this: ElizaClient,
  timeoutMs: number = FILES_LIST_FETCH_TIMEOUT_MS,
) {
  return this.fetch("/api/files", undefined, { timeoutMs });
};

ElizaClient.prototype.deleteFile = async function (
  this: ElizaClient,
  fileName: string,
  timeoutMs: number = FILES_DELETE_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/files/${encodeURIComponent(fileName)}`,
    {
      method: "DELETE",
    },
    { timeoutMs },
  );
};
