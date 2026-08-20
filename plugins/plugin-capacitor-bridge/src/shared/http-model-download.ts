/**
 * Streams recommended model artifacts into an atomic staging file while
 * bounding both inactivity and pathological total transfer duration.
 */

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
		const response = await fetch(url, {
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

		const progress = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				deadline.noteProgress();
				callback(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(response.body as never),
			progress,
			createWriteStream(stagingPath),
			{ signal: deadline.signal },
		);

		const stagedSize = statSync(stagingPath).size;
		if (expectedSizeBytes && stagedSize !== expectedSizeBytes) {
			throw new Error(
				`${label} size ${stagedSize} != expected ${expectedSizeBytes}`,
			);
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
