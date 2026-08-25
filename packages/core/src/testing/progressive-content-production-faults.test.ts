/**
 * Exercises all cross-boundary progressive-content fault executors against real
 * local filesystem, stream, cryptographic, transaction, and HTTP operations.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupProgressiveContentProductionFaults,
	createProgressiveContentProductionFaultExecutors,
	type ProgressiveContentProductionFaultId,
} from "./progressive-content-production-faults";

const EXPECTED = {
	"revoked-authorization": "CONTENT_ACCESS_REVOKED",
	"tampered-reference": "CONTENT_REFERENCE_INVALID",
	"resolve-timeout": "CONTENT_RESOLVE_TIMEOUT",
	"read-cancellation": "CONTENT_READ_CANCELLED",
	"short-read": "CONTENT_SHORT_READ",
	"mid-page-error": "CONTENT_READ_FAILED",
	"stat-read-toctou": "CONTENT_STALE_REVISION",
	"metadata-body-split-brain": "CONTENT_INTEGRITY_MISMATCH",
	"concurrent-replace": "CONTENT_STALE_REVISION",
	"index-lag": "CONTENT_INDEX_STALE",
	"client-backpressure": "CONTENT_READ_CANCELLED",
	"decompression-bomb": "CONTENT_EXTRACTION_LIMIT",
	"corrupted-manifest": "CONTENT_MANIFEST_CORRUPT",
	"process-death": "CONTENT_PUBLICATION_INCOMPLETE",
	"digest-mismatch": "CONTENT_INTEGRITY_MISMATCH",
	"provider-401": "CONNECTOR_UNAUTHORIZED",
	"provider-403": "CONNECTOR_FORBIDDEN",
	"provider-404": "CONNECTOR_NOT_FOUND",
	"provider-409": "CONNECTOR_CONFLICT",
	"provider-429": "CONNECTOR_RATE_LIMITED",
	"provider-5xx": "CONNECTOR_UPSTREAM_FAILED",
	"disk-full": "CONTENT_STORAGE_FULL",
	"retention-expiry": "CONTENT_EXPIRED",
	"database-commit": "CONTENT_COMMIT_FAILED",
	"connector-refresh": "CONNECTOR_REFRESH_FAILED",
	"compaction-failure": "CONTENT_MANIFEST_COMMIT_FAILED",
	"cleanup-failure": "CONTENT_CLEANUP_FAILED",
} as const satisfies Record<ProgressiveContentProductionFaultId, string>;

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await cleanupProgressiveContentProductionFaults(root);
	}
});

describe("production progressive-content fault executors", () => {
	it("observes all 27 operational failures and independently finds no forbidden effects", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "eliza-progressive-faults-"),
		);
		roots.push(root);
		const executors = await createProgressiveContentProductionFaultExecutors({
			workRoot: root,
		});
		expect(Object.keys(executors).sort()).toEqual(Object.keys(EXPECTED).sort());

		for (const [id, expectedCode] of Object.entries(EXPECTED) as [
			ProgressiveContentProductionFaultId,
			string,
		][]) {
			await expect(executors[id].execute()).rejects.toMatchObject({
				code: expectedCode,
				context: { faultId: id },
			});
			expect(await executors[id].observeEffects?.()).toEqual([]);
			const receipt = JSON.parse(
				await readFile(path.join(root, "receipts", `${id}.json`), "utf8"),
			) as { id: string; operation: string; causeCode: string };
			expect(receipt.id).toBe(id);
			expect(receipt.operation.length).toBeGreaterThan(3);
			expect(receipt.causeCode).not.toBe(expectedCode);
			if (id === "read-cancellation")
				expect(receipt.causeCode).toBe("ABORT_ERR");
		}
	}, 30_000);
});
