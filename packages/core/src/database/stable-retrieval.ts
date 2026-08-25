/**
 * Builds and validates adapter-issued retrieval snapshots and exclusive
 * keyset pages over an already authorized, deterministically ordered corpus.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ElizaError } from "../errors";
import type {
	Memory,
	StableRetrievalCursor,
	StableRetrievalSnapshot,
	UUID,
} from "../types";
import { stableStringify } from "../utils/deterministic";

const EMPTY_UPPER_ID = "00000000-0000-4000-8000-000000000000" as UUID;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function retrievalKey(memory: Memory): { createdAt: number; id: UUID } {
	if (
		typeof memory.createdAt !== "number" ||
		!Number.isSafeInteger(memory.createdAt) ||
		typeof memory.id !== "string" ||
		!UUID_PATTERN.test(memory.id)
	) {
		throw new ElizaError("Stable retrieval row has no usable ordering key", {
			code: "RETRIEVAL_ORDER_KEY_INVALID",
			context: { id: memory.id, createdAt: memory.createdAt },
			severity: "fatal",
		});
	}
	return { createdAt: memory.createdAt, id: memory.id };
}

function assertSnapshot(snapshot: StableRetrievalSnapshot): void {
	if (
		snapshot.version !== 1 ||
		!Number.isSafeInteger(snapshot.upperCreatedAt) ||
		!UUID_PATTERN.test(snapshot.upperId) ||
		!Number.isSafeInteger(snapshot.totalCount) ||
		snapshot.totalCount < 0 ||
		!SHA256_PATTERN.test(snapshot.queryFingerprint) ||
		!SHA256_PATTERN.test(snapshot.fingerprint)
	) {
		throw new ElizaError("Stable retrieval snapshot is malformed", {
			code: "RETRIEVAL_SNAPSHOT_INVALID",
			context: { version: snapshot.version, totalCount: snapshot.totalCount },
			severity: "fatal",
		});
	}
}

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareRows(
	left: Memory,
	right: Memory,
	rankBySimilarity: boolean,
): number {
	if (rankBySimilarity) {
		const leftScore = left.similarity;
		const rightScore = right.similarity;
		if (
			typeof leftScore !== "number" ||
			!Number.isFinite(leftScore) ||
			typeof rightScore !== "number" ||
			!Number.isFinite(rightScore)
		) {
			throw new ElizaError("Stable vector retrieval row has no finite score", {
				code: "RETRIEVAL_ORDER_KEY_INVALID",
				context: { leftId: left.id, rightId: right.id },
				severity: "fatal",
			});
		}
		if (leftScore !== rightScore) return rightScore - leftScore;
	}
	const leftKey = retrievalKey(left);
	const rightKey = retrievalKey(right);
	if (leftKey.createdAt !== rightKey.createdAt) {
		return rightKey.createdAt - leftKey.createdAt;
	}
	return compareIds(rightKey.id, leftKey.id);
}

function isWithinUpperBound(
	memory: Memory,
	snapshot: Pick<StableRetrievalSnapshot, "upperCreatedAt" | "upperId">,
): boolean {
	const key = retrievalKey(memory);
	return (
		key.createdAt < snapshot.upperCreatedAt ||
		(key.createdAt === snapshot.upperCreatedAt && key.id <= snapshot.upperId)
	);
}

function sha256Hex(value: unknown): string {
	const canonical = stableStringify(value);
	return Array.from(sha256(new TextEncoder().encode(canonical)))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Bind a snapshot to every semantic query and authorization input. */
export function stableRetrievalQueryFingerprint(value: unknown): string {
	return sha256Hex(value);
}

function fingerprint(memories: readonly Memory[]): string {
	return sha256Hex(
		memories.map((memory) => ({
			id: memory.id,
			createdAt: memory.createdAt,
			similarity: memory.similarity,
			content: memory.content,
			embedding: memory.embedding,
			metadata: memory.metadata,
			roomId: memory.roomId,
			worldId: memory.worldId,
			entityId: memory.entityId,
		})),
	);
}

function buildSnapshot(
	ordered: readonly Memory[],
	queryFingerprint: string,
	upper?: Pick<StableRetrievalSnapshot, "upperCreatedAt" | "upperId">,
): StableRetrievalSnapshot {
	let upperCreatedAt = upper?.upperCreatedAt ?? 0;
	let upperId = upper?.upperId ?? EMPTY_UPPER_ID;
	if (!upper) {
		for (const memory of ordered) {
			const key = retrievalKey(memory);
			if (
				key.createdAt > upperCreatedAt ||
				(key.createdAt === upperCreatedAt && key.id > upperId)
			) {
				upperCreatedAt = key.createdAt;
				upperId = key.id;
			}
		}
	}
	return {
		version: 1,
		upperCreatedAt,
		upperId,
		totalCount: ordered.length,
		queryFingerprint,
		fingerprint: fingerprint(ordered),
	};
}

function assertSnapshotMatches(
	expected: StableRetrievalSnapshot,
	actual: StableRetrievalSnapshot,
): void {
	if (
		expected.version !== 1 ||
		expected.upperCreatedAt !== actual.upperCreatedAt ||
		expected.upperId !== actual.upperId ||
		expected.totalCount !== actual.totalCount ||
		expected.queryFingerprint !== actual.queryFingerprint ||
		expected.fingerprint !== actual.fingerprint
	) {
		throw new ElizaError(
			"Retrieval source changed inside its stable snapshot",
			{
				code: "RETRIEVAL_SNAPSHOT_CONFLICT",
				context: {
					expectedCount: expected.totalCount,
					actualCount: actual.totalCount,
					action: "restart-from-first-page",
				},
			},
		);
	}
}

/** Create one verified page from an authorized and fully ranked source. */
export function createStableRetrievalPage(
	orderedSource: readonly Memory[],
	options: {
		limit: number;
		cursor?: StableRetrievalCursor;
		rankBySimilarity: boolean;
		queryFingerprint: string;
	},
): {
	items: Memory[];
	snapshot: StableRetrievalSnapshot;
	nextCursor?: StableRetrievalCursor;
	hasMore: boolean;
} {
	if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
		throw new ElizaError("Stable retrieval page size is invalid", {
			code: "RETRIEVAL_PAGE_INVALID",
			context: { limit: options.limit },
			severity: "fatal",
		});
	}
	const seen = new Set<string>();
	for (let index = 0; index < orderedSource.length; index += 1) {
		const row = orderedSource[index];
		const key = retrievalKey(row);
		if (
			seen.has(key.id) ||
			(index > 0 &&
				compareRows(orderedSource[index - 1], row, options.rankBySimilarity) >=
					0)
		) {
			throw new ElizaError("Retrieval source is duplicated or out of order", {
				code: "RETRIEVAL_PAGINATION_CONFLICT",
				context: { index, id: key.id },
			});
		}
		seen.add(key.id);
	}

	const cursor = options.cursor;
	if (cursor) assertSnapshot(cursor.snapshot);
	const fenced = cursor
		? orderedSource.filter((row) => isWithinUpperBound(row, cursor.snapshot))
		: [...orderedSource];
	const snapshot = buildSnapshot(
		fenced,
		options.queryFingerprint,
		cursor?.snapshot,
	);
	if (cursor) assertSnapshotMatches(cursor.snapshot, snapshot);

	const remaining = cursor
		? fenced.filter((row) => {
				const cursorRow: Memory = {
					id: cursor.id,
					createdAt: cursor.createdAt,
					entityId: EMPTY_UPPER_ID,
					roomId: EMPTY_UPPER_ID,
					content: {},
					similarity: cursor.similarity,
				};
				return compareRows(row, cursorRow, options.rankBySimilarity) > 0;
			})
		: fenced;
	const hasMore = remaining.length > options.limit;
	const items = remaining.slice(0, options.limit);
	const last = items.at(-1);
	return {
		items,
		snapshot,
		hasMore,
		...(hasMore && last
			? {
					nextCursor: {
						...retrievalKey(last),
						...(options.rankBySimilarity
							? { similarity: last.similarity }
							: {}),
						snapshot,
					},
				}
			: {}),
	};
}

/** Validate a page envelope supplied across an adapter boundary. */
export function validateStableRetrievalPageEnvelope(
	page: {
		items: Memory[];
		snapshot: StableRetrievalSnapshot;
		nextCursor?: StableRetrievalCursor;
		hasMore: boolean;
	},
	options: {
		limit: number;
		requestCursor?: StableRetrievalCursor;
		rankBySimilarity: boolean;
	},
): void {
	assertSnapshot(page.snapshot);
	if (options.requestCursor) {
		assertSnapshot(options.requestCursor.snapshot);
		if (
			!UUID_PATTERN.test(options.requestCursor.id) ||
			!Number.isSafeInteger(options.requestCursor.createdAt) ||
			(options.rankBySimilarity &&
				(typeof options.requestCursor.similarity !== "number" ||
					!Number.isFinite(options.requestCursor.similarity)))
		) {
			throw new ElizaError("Stable retrieval cursor is malformed", {
				code: "RETRIEVAL_CURSOR_INVALID",
				severity: "fatal",
			});
		}
	}
	if (
		page.items.length > options.limit ||
		page.hasMore !== (page.nextCursor !== undefined) ||
		(page.hasMore && page.items.length !== options.limit)
	) {
		throw new ElizaError("Stable retrieval page envelope is inconsistent", {
			code: "RETRIEVAL_PAGE_INVALID",
			context: {
				limit: options.limit,
				returned: page.items.length,
				hasMore: page.hasMore,
				hasCursor: page.nextCursor !== undefined,
			},
		});
	}
	for (let index = 0; index < page.items.length; index += 1) {
		const item = page.items[index];
		if (!isWithinUpperBound(item, page.snapshot)) {
			throw new ElizaError("Stable retrieval page escaped its snapshot fence", {
				code: "RETRIEVAL_SNAPSHOT_CONFLICT",
				context: { id: item.id },
			});
		}
		if (
			index > 0 &&
			compareRows(page.items[index - 1], item, options.rankBySimilarity) >= 0
		) {
			throw new ElizaError("Stable retrieval page is duplicated or reordered", {
				code: "RETRIEVAL_PAGINATION_CONFLICT",
				context: { index, id: item.id },
			});
		}
	}
	const requestCursor = options.requestCursor;
	const first = page.items[0];
	if (requestCursor && first) {
		const cursorRow: Memory = {
			id: requestCursor.id,
			createdAt: requestCursor.createdAt,
			entityId: EMPTY_UPPER_ID,
			roomId: EMPTY_UPPER_ID,
			content: {},
			similarity: requestCursor.similarity,
		};
		if (compareRows(first, cursorRow, options.rankBySimilarity) <= 0) {
			throw new ElizaError("Stable retrieval continuation did not advance", {
				code: "RETRIEVAL_PAGINATION_CONFLICT",
				context: { id: first.id },
			});
		}
	}
	const last = page.items.at(-1);
	if (page.nextCursor && last) {
		const key = retrievalKey(last);
		if (
			page.nextCursor.id !== key.id ||
			page.nextCursor.createdAt !== key.createdAt ||
			(options.rankBySimilarity &&
				page.nextCursor.similarity !== last.similarity) ||
			JSON.stringify(page.nextCursor.snapshot) !== JSON.stringify(page.snapshot)
		) {
			throw new ElizaError("Stable retrieval continuation cursor is invalid", {
				code: "RETRIEVAL_PAGE_INVALID",
				context: { id: last.id },
			});
		}
	}
}
