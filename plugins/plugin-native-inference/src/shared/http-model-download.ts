/**
 * Streams recommended model artifacts into an atomic staging file while
 * bounding both inactivity and pathological total transfer duration.
 */

import { createHash } from "node:crypto";
import { createWriteStream, renameSync, rmSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createModelDownloadDeadline,
  MODEL_DOWNLOAD_IDLE_TIMEOUT_MS,
  MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS,
} from "./model-download-deadline.ts";

interface HttpModelDownloadOptions {
  url: string;
  stagingPath: string;
  finalPath: string;
  label: string;
  expectedSizeBytes?: number;
  expectedSha256?: string;
  /** Fresh admission before fetch/publication; progress calls may be throttled by the owner. */
  checkAdmission?: (force?: boolean) => Promise<void>;
  fetchImpl?: typeof fetch;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/** Download one model through the same fetch-to-file path used in production. */
export async function downloadHttpModel({
  url,
  stagingPath,
  finalPath,
  label,
  expectedSizeBytes,
  expectedSha256,
  checkAdmission,
  fetchImpl = fetch,
  idleTimeoutMs = MODEL_DOWNLOAD_IDLE_TIMEOUT_MS,
  totalTimeoutMs = MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS,
}: HttpModelDownloadOptions): Promise<number> {
  rmSync(stagingPath, { force: true });
  const deadline = createModelDownloadDeadline({
    label,
    idleTimeoutMs,
    totalTimeoutMs,
  });

  try {
    await checkAdmission?.(true);
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: deadline.signal,
    });
    deadline.noteProgress();
    if (!response.ok || !response.body) {
      try {
        await response.body?.cancel();
      } catch {
        // error-policy:J6 best-effort teardown of a rejected response body.
      }
      throw new Error(
        `${label} failed: HTTP ${response.status} ${response.statusText} from ${url}`,
      );
    }

    const hash = expectedSha256 ? createHash("sha256") : null;
    let receivedSize = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const consume = async () => {
          await checkAdmission?.();
          receivedSize += chunk.length;
          if (
            expectedSizeBytes !== undefined &&
            receivedSize > expectedSizeBytes
          ) {
            throw new Error(
              `${label} exceeds expected size ${expectedSizeBytes}`,
            );
          }
          hash?.update(chunk);
          deadline.noteProgress();
          callback(null, chunk);
        };
        void consume().catch((error: Error) => callback(error));
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      progress,
      createWriteStream(stagingPath),
      { signal: deadline.signal },
    );

    const stagedSize = statSync(stagingPath).size;
    await checkAdmission?.(true);
    if (expectedSizeBytes !== undefined && stagedSize !== expectedSizeBytes) {
      throw new Error(
        `${label} size ${stagedSize} != expected ${expectedSizeBytes}`,
      );
    }
    if (hash && hash.digest("hex") !== expectedSha256) {
      throw new Error(`${label} SHA256 does not match its pinned release`);
    }
    renameSync(stagingPath, finalPath);
    return stagedSize;
  } catch (error) {
    const failure = deadline.failure(error);
    try {
      rmSync(stagingPath, { force: true });
    } catch {
      // error-policy:J6 best-effort teardown of a failed staged download.
    }
    throw failure;
  } finally {
    deadline.dispose();
  }
}
