/**
 * Live-account data export (`POST /api/v1/me/data-export`). The server builds
 * the same portable, digest-stamped archive as the recovery-window export, so
 * the bytes are verified with the shared deletion-export reader before any
 * download is offered. An archive over the server's size limit is a distinct,
 * user-visible failure — never a silently partial file.
 */

import { ElizaError } from "@elizaos/core/protocol";
import { downloadAttachment } from "../../../utils/download-share";
import { ApiError, apiFetch } from "../../lib/api-client";
import {
  type AccountDeletionExportDownload,
  readVerifiedExportDownload,
} from "./account-deletion-client";

export class DataExportTooLargeError extends ElizaError {
  override readonly name = "DataExportTooLargeError";

  constructor(cause: unknown) {
    super("Your data is larger than the export size limit.", {
      code: "EXPORT_TOO_LARGE",
      cause,
      severity: "fatal",
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function downloadAccountDataExport(): Promise<AccountDeletionExportDownload> {
  let response: Response;
  try {
    response = await apiFetch("/api/v1/me/data-export", {
      method: "POST",
      json: {},
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 413 || error.code === "EXPORT_TOO_LARGE")
    ) {
      throw new DataExportTooLargeError(error);
    }
    throw error;
  }
  return readVerifiedExportDownload(response, "data export");
}

/** Hands a verified export to the platform download/share path. */
export async function saveExportDownload(
  download: AccountDeletionExportDownload,
): Promise<void> {
  const url = URL.createObjectURL(download.blob);
  try {
    await downloadAttachment(url, download.filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}
