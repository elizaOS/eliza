/** Runs source-neutral progressive-read correctness, isolation, cleanup, and bounded-work conformance. */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ReadView } from "../types/content";
import { validateReadView } from "../types/content";

export const PROGRESSIVE_CONTENT_CONFORMANCE_SCHEMA_VERSION =
	"elizaos.progressive-content.conformance.v2" as const;
export const PROGRESSIVE_CONTENT_DELIVERY_CONTRACT =
	"explicit-native-paging-no-automatic-prompt-omission" as const;

export interface ProgressiveConformanceObject {
	readonly id: string;
	readonly family: ReadView["reference"]["kind"];
	readonly byteLength: number;
	readonly sourceSha256: string;
	readonly revision: string;
	readonly authorizationScope: string;
	readonly canaries: readonly {
		readonly label: string;
		readonly text: string;
		readonly byteStart: number;
		readonly byteEnd: number;
	}[];
}

export interface ProgressiveConformanceSourceWork {
	readonly readCalls: number;
	readonly bytesRead: number;
	readonly rowsRead: number;
	readonly parentScans: number;
}

export interface ProgressiveConformancePage {
	readonly bytes: Uint8Array;
	readonly view: ReadView;
	readonly sourceWork: ProgressiveConformanceSourceWork;
}

export interface ProgressiveContentConformanceAdapter {
	readonly adapterId: string;
	readonly deliveryContract: typeof PROGRESSIVE_CONTENT_DELIVERY_CONTRACT;
	read(request: {
		readonly objectId: string;
		readonly authorizationScope: string;
		readonly offset: number;
		readonly limit: number;
		readonly expectedRevision?: string;
	}): Promise<ProgressiveConformancePage>;
	restart(): Promise<void>;
	cleanup(objectId: string): Promise<void>;
	measureResources?(): Promise<{ readonly databaseBytes?: number }>;
}

export interface ProgressiveContentPerformanceCeilings {
	readonly maxPageLatencyMs: number;
	readonly maxRssGrowthBytes: number;
	readonly maxReadAmplification: number;
	readonly maxReadCallsPerPage: number;
	readonly maxRowsPerPage: number;
	readonly maxDatabaseGrowthBytes?: number;
}

export interface ProgressiveContentConformanceFailure {
	readonly vector: string;
	readonly message: string;
}

export interface ProgressiveContentConformanceReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_CONFORMANCE_SCHEMA_VERSION;
	readonly adapterId: string;
	readonly objectId: string;
	readonly deliveryContract: typeof PROGRESSIVE_CONTENT_DELIVERY_CONTRACT;
	readonly status: "passed" | "failed";
	readonly pageBytes: number;
	readonly pages: number;
	readonly reassembledSha256: string;
	readonly canariesFound: readonly string[];
	readonly restartVerified: boolean;
	readonly concurrencyVerified: boolean;
	readonly repeatedPageVerified: boolean;
	readonly cleanupVerified: boolean;
	readonly postCleanupProbeVerified: boolean;
	readonly sourceWork: ProgressiveConformanceSourceWork;
	readonly performance: {
		readonly elapsedMs: number;
		readonly maxPageLatencyMs: number;
		readonly rssGrowthBytes: number;
		readonly readAmplification: number;
		readonly readCallsPerPageMax: number;
		readonly rowsPerPageMax: number;
		readonly databaseGrowthBytes?: number;
		readonly ceilings: ProgressiveContentPerformanceCeilings;
	};
	readonly failures: readonly ProgressiveContentConformanceFailure[];
}

const NOT_FOUND_CODES = new Set([
	"CONTENT_NOT_FOUND",
	"not_found",
	"FILE_NOT_FOUND",
	"ENOENT",
]);

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = (error as { code?: unknown }).code;
	return typeof value === "string" ? value : undefined;
}

function validWork(work: ProgressiveConformanceSourceWork): boolean {
	return Object.values(work).every(
		(value) => Number.isSafeInteger(value) && value >= 0,
	);
}

/** Traverse one native object and enforce paging, isolation, and resource bounds. */
export async function runProgressiveContentConformance(input: {
	readonly adapter: ProgressiveContentConformanceAdapter;
	readonly object: ProgressiveConformanceObject;
	readonly pageBytes?: number;
	readonly performanceCeilings?: Partial<ProgressiveContentPerformanceCeilings>;
}): Promise<ProgressiveContentConformanceReport> {
	const pageBytes = input.pageBytes ?? 64 * 1024;
	if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0) {
		throw new RangeError("pageBytes must be a positive safe integer");
	}
	const ceilings: ProgressiveContentPerformanceCeilings = {
		maxPageLatencyMs: input.performanceCeilings?.maxPageLatencyMs ?? 5_000,
		maxRssGrowthBytes:
			input.performanceCeilings?.maxRssGrowthBytes ?? 128 * 1024 * 1024,
		maxReadAmplification:
			input.performanceCeilings?.maxReadAmplification ?? 2,
		maxReadCallsPerPage:
			input.performanceCeilings?.maxReadCallsPerPage ?? 2,
		maxRowsPerPage: input.performanceCeilings?.maxRowsPerPage ?? 8,
		...(input.performanceCeilings?.maxDatabaseGrowthBytes === undefined
			? {}
			: {
					maxDatabaseGrowthBytes:
						input.performanceCeilings.maxDatabaseGrowthBytes,
				}),
	};
	const failures: ProgressiveContentConformanceFailure[] = [];
	const fail = (vector: string, message: string) =>
		failures.push({ vector, message });
	let readCalls = 0;
	let bytesRead = 0;
	let rowsRead = 0;
	let parentScans = 0;
	let readCallsPerPageMax = 0;
	let rowsPerPageMax = 0;
	let maxPageLatencyMs = 0;
	const observeWork = (
		page: ProgressiveConformancePage,
		label: string,
		primary: boolean,
	): void => {
		if (!validWork(page.sourceWork)) {
			fail("source-work", `${label} has invalid counters`);
			return;
		}
		readCallsPerPageMax = Math.max(readCallsPerPageMax, page.sourceWork.readCalls);
		rowsPerPageMax = Math.max(rowsPerPageMax, page.sourceWork.rowsRead);
		if (page.sourceWork.readCalls > ceilings.maxReadCallsPerPage) {
			fail("source-work", `${label} performed ${page.sourceWork.readCalls} source reads`);
		}
		if (page.sourceWork.rowsRead > ceilings.maxRowsPerPage) {
			fail("source-work", `${label} read ${page.sourceWork.rowsRead} rows`);
		}
		if (
			page.sourceWork.parentScans > 0 ||
			page.sourceWork.bytesRead >
				page.bytes.byteLength * ceilings.maxReadAmplification + pageBytes
		) {
			fail("source-work", `${label} performed unbounded work`);
		}
		if (primary) {
			readCalls += page.sourceWork.readCalls;
			bytesRead += page.sourceWork.bytesRead;
			rowsRead += page.sourceWork.rowsRead;
			parentScans += page.sourceWork.parentScans;
		}
	};
	const digest = createHash("sha256");
	const canaryState = new Map(
		input.object.canaries.map((canary) => [
			canary.label,
			{ matched: true, bytesSeen: 0 },
		]),
	);
	const startedAt = performance.now();
	const initialRss = process.memoryUsage.rss();
	const initialResources = await input.adapter.measureResources?.();
	let offset = 0;
	let pages = 0;
	let restartVerified = false;

	while (offset < input.object.byteLength) {
		const pageStartedAt = performance.now();
		let page: ProgressiveConformancePage;
		try {
			page = await input.adapter.read({
				objectId: input.object.id,
				authorizationScope: input.object.authorizationScope,
				offset,
				limit: pageBytes,
				...(offset > 0 ? { expectedRevision: input.object.revision } : {}),
			});
		} catch (error) {
			fail("read", `page at ${offset} rejected with ${errorCode(error) ?? "untyped error"}`);
			break;
		}
		maxPageLatencyMs = Math.max(
			maxPageLatencyMs,
			performance.now() - pageStartedAt,
		);
		let view: ReadView;
		try {
			view = validateReadView(page.view);
		} catch (error) {
			fail("read-view", error instanceof Error ? error.message : "invalid read view");
			break;
		}
		pages += 1;
		observeWork(page, `page ${pages}`, true);
		if (page.bytes.byteLength === 0) {
			fail("no-progress", `empty page before EOF at ${offset}`);
			break;
		}
		if (
			view.reference.kind !== input.object.family ||
			view.reference.revision !== input.object.revision ||
			view.slice.revision !== input.object.revision
		) fail("revision", `page ${pages} has wrong revision`);
		const nextOffset = offset + page.bytes.byteLength;
		if (
			view.slice.range.unit !== "byte" ||
			view.slice.range.start !== offset ||
			view.slice.range.end !== nextOffset ||
			view.slice.range.total !== input.object.byteLength
		) fail("exact-range", `page ${pages} has inexact range`);
		if (
			createHash("sha256").update(page.bytes).digest("hex") !==
			view.slice.sliceSha256
		) fail("page-hash", `page ${pages} SHA-256 differs`);
		const shouldHaveMore = nextOffset < input.object.byteLength;
		if (
			view.slice.hasMore !== shouldHaveMore ||
			(shouldHaveMore && view.slice.nextOffset !== nextOffset) ||
			view.slice.completeness !==
				(shouldHaveMore ? "partial-recoverable" : "complete")
		) fail("completeness", `page ${pages} misreports continuation`);
		for (const canary of input.object.canaries) {
			const overlapStart = Math.max(offset, canary.byteStart);
			const overlapEnd = Math.min(nextOffset, canary.byteEnd);
			if (overlapStart >= overlapEnd) continue;
			const actual = page.bytes.subarray(
				overlapStart - offset,
				overlapEnd - offset,
			);
			const expected = Buffer.from(canary.text).subarray(
				overlapStart - canary.byteStart,
				overlapEnd - canary.byteStart,
			);
			const state = canaryState.get(canary.label);
			if (state) {
				state.matched &&= Buffer.from(actual).equals(expected);
				state.bytesSeen += actual.byteLength;
			}
		}
		digest.update(page.bytes);
		offset = nextOffset;
		if (pages === 1 && offset < input.object.byteLength) {
			try {
				await input.adapter.restart();
				restartVerified = true;
			} catch (error) {
				fail("restart", error instanceof Error ? error.message : "restart failed");
				break;
			}
		}
	}

	if (!restartVerified) {
		try {
			await input.adapter.restart();
			restartVerified = true;
		} catch (error) {
			fail("restart", error instanceof Error ? error.message : "restart failed");
		}
	}
	const reassembledSha256 = digest.digest("hex");
	if (offset !== input.object.byteLength) fail("reassembly", `traversal ended at ${offset}`);
	if (reassembledSha256 !== input.object.sourceSha256) fail("reassembly", "full traversal SHA-256 differs");
	for (const canary of input.object.canaries) {
		const state = canaryState.get(canary.label);
		if (!state?.matched || state.bytesSeen !== Buffer.byteLength(canary.text)) {
			fail("canary", `missing ${canary.label} canary`);
		}
	}
	if (parentScans > 0) fail("source-work", `performed ${parentScans} parent scans`);
	if (bytesRead > input.object.byteLength * ceilings.maxReadAmplification + pageBytes * 2) {
		fail("source-work", `read ${bytesRead} bytes for ${input.object.byteLength}`);
	}

	for (const negative of [
		{
			vector: "stale-revision",
			request: {
				objectId: input.object.id,
				authorizationScope: input.object.authorizationScope,
				offset: Math.min(1, input.object.byteLength),
				limit: 1,
				expectedRevision: `stale:${input.object.revision}`,
			},
			codes: ["CONTENT_STALE_REVISION", "stale_read"],
		},
		{
			vector: "authorization",
			request: {
				objectId: input.object.id,
				authorizationScope: `${input.object.authorizationScope}:unauthorized`,
				offset: 0,
				limit: 1,
			},
			codes: ["CONTENT_ACCESS_DENIED", "unauthorized", "forbidden"],
		},
	] as const) {
		try {
			const page = await input.adapter.read(negative.request);
			observeWork(page, negative.vector, false);
			fail(negative.vector, "adapter returned bytes instead of rejecting");
		} catch (error) {
			const code = errorCode(error);
			if (!code || !(negative.codes as readonly string[]).includes(code)) {
				fail(negative.vector, `adapter rejected with untyped code ${code ?? "none"}`);
			}
		}
	}

	let concurrencyVerified = false;
	let repeatedPageVerified = false;
	if (input.object.byteLength > 0) {
		const request = {
			objectId: input.object.id,
			authorizationScope: input.object.authorizationScope,
			offset: 0,
			limit: Math.min(pageBytes, input.object.byteLength),
		};
		try {
			const [left, right] = await Promise.all([
				input.adapter.read(request),
				input.adapter.read(request),
			]);
			const repeated = await input.adapter.read(request);
			for (const [label, page] of [["concurrent-left", left], ["concurrent-right", right], ["repeated-page", repeated]] as const) {
				observeWork(page, label, false);
			}
			concurrencyVerified = Buffer.from(left.bytes).equals(Buffer.from(right.bytes)) && left.view.slice.sliceSha256 === right.view.slice.sliceSha256;
			repeatedPageVerified = Buffer.from(left.bytes).equals(Buffer.from(repeated.bytes)) && left.view.slice.sliceSha256 === repeated.view.slice.sliceSha256;
			if (!concurrencyVerified) fail("concurrency", "same-revision concurrent reads differ");
			if (!repeatedPageVerified) fail("repeated-page", "repeated same-revision page differs");
		} catch (error) {
			fail("concurrency", error instanceof Error ? error.message : "concurrent read failed");
		}
	}

	let cleanupVerified = false;
	let postCleanupProbeVerified = false;
	try {
		await input.adapter.cleanup(input.object.id);
		cleanupVerified = true;
	} catch (error) {
		fail("cleanup", error instanceof Error ? error.message : "cleanup failed");
	}
	if (cleanupVerified) {
		try {
			await input.adapter.read({
				objectId: input.object.id,
				authorizationScope: input.object.authorizationScope,
				offset: 0,
				limit: 1,
			});
			fail("cleanup", "object remained readable after cleanup");
		} catch (error) {
			postCleanupProbeVerified = NOT_FOUND_CODES.has(errorCode(error) ?? "");
			if (!postCleanupProbeVerified) fail("cleanup", `post-cleanup probe rejected with ${errorCode(error) ?? "untyped error"}`);
		}
	}

	const finalResources = await input.adapter.measureResources?.();
	const databaseGrowthBytes =
		initialResources?.databaseBytes === undefined ||
		finalResources?.databaseBytes === undefined
			? undefined
			: Math.max(0, finalResources.databaseBytes - initialResources.databaseBytes);
	const rssGrowthBytes = Math.max(0, process.memoryUsage.rss() - initialRss);
	if (maxPageLatencyMs > ceilings.maxPageLatencyMs) fail("performance", `page latency ${maxPageLatencyMs.toFixed(2)}ms exceeded ceiling`);
	if (rssGrowthBytes > ceilings.maxRssGrowthBytes) fail("performance", `RSS growth ${rssGrowthBytes} exceeded ceiling`);
	if (databaseGrowthBytes !== undefined && ceilings.maxDatabaseGrowthBytes !== undefined && databaseGrowthBytes > ceilings.maxDatabaseGrowthBytes) {
		fail("performance", `database growth ${databaseGrowthBytes} exceeded ceiling`);
	}

	return {
		schemaVersion: PROGRESSIVE_CONTENT_CONFORMANCE_SCHEMA_VERSION,
		adapterId: input.adapter.adapterId,
		objectId: input.object.id,
		deliveryContract: input.adapter.deliveryContract,
		status: failures.length === 0 ? "passed" : "failed",
		pageBytes,
		pages,
		reassembledSha256,
		canariesFound: input.object.canaries.filter((canary) => {
			const state = canaryState.get(canary.label);
			return state?.matched && state.bytesSeen === Buffer.byteLength(canary.text);
		}).map(({ label }) => label).sort(),
		restartVerified,
		concurrencyVerified,
		repeatedPageVerified,
		cleanupVerified,
		postCleanupProbeVerified,
		sourceWork: { readCalls, bytesRead, rowsRead, parentScans },
		performance: {
			elapsedMs: performance.now() - startedAt,
			maxPageLatencyMs,
			rssGrowthBytes,
			readAmplification: input.object.byteLength === 0 ? 0 : bytesRead / input.object.byteLength,
			readCallsPerPageMax,
			rowsPerPageMax,
			...(databaseGrowthBytes === undefined ? {} : { databaseGrowthBytes }),
			ceilings,
		},
		failures,
	};
}
