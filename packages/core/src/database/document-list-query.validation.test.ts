/**
 * Covers the document-list helpers that the existing suite never imports:
 * the portable tokenizer, the ordering comparator, and every parameter,
 * result, and capability validator.
 *
 * These are the functions an adapter author is told to trust. The tokenizer in
 * particular carries an explicit cross-engine claim — that JavaScript and
 * PostgreSQL cannot disagree about a term — which is asserted here rather than
 * assumed.
 */

import { describe, expect, it } from "vitest";
import type {
	DocumentFragmentQueryParams,
	DocumentListQueryParams,
	DocumentRequesterContext,
	IDatabaseAdapter,
	Memory,
	UUID,
} from "../types";
import { MemoryType } from "../types";
import {
	compareDocumentOrder,
	DOCUMENT_LIST_MAX_LIMIT,
	DOCUMENT_LIST_MAX_OFFSET,
	DOCUMENT_LIST_MAX_QUERY_LENGTH,
	DOCUMENT_LIST_MAX_REQUESTER_ROOMS,
	DOCUMENT_LIST_MAX_TAG_LENGTH,
	DOCUMENT_LIST_MAX_TAGS,
	DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
	documentCreatedAt,
	documentRoleHasGlobalVisibility,
	documentSearchText,
	hasDocumentListQueryCapability,
	portableDocumentSearchTokens,
	validateDocumentFragmentQueryParams,
	validateDocumentListQueryParams,
	validateDocumentListQueryResult,
	validateDocumentRequesterContext,
} from "./document-list-query";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const DOC_ID = "10000000-0000-0000-0000-000000000001" as UUID;

const requester: DocumentRequesterContext = {
	agentId: AGENT_ID,
	requesterEntityId: REQUESTER_ID,
	requesterRoomIds: [],
	requesterRole: "RUNTIME",
};

const listParams: DocumentListQueryParams = {
	...requester,
	limit: 25,
	offset: 0,
};

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: DOC_ID,
		agentId: AGENT_ID,
		entityId: REQUESTER_ID,
		roomId: ROOM_ID,
		createdAt: 1_000,
		content: { text: "body" },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId: DOC_ID,
			scope: "global",
		},
		...overrides,
	} as Memory;
}

/** A minimal adapter that satisfies every capability probe. */
function capableAdapter(): Record<string, unknown> {
	return {
		documentListQueryCapability: DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
		queryDocuments: () => undefined,
		getDocument: () => undefined,
		queryDocumentFragments: () => undefined,
		compareAndSwapDocument: () => undefined,
		updateDocumentDirectGrants: () => undefined,
		replaceDocumentRevision: () => undefined,
		deleteDocumentWithSnapshot: () => undefined,
	};
}

describe("portableDocumentSearchTokens keeps JS and PostgreSQL in agreement", () => {
	it("splits on ASCII whitespace only", () => {
		const separators = [" ", "\t", "\r", "\n", "\f"];
		for (const separator of separators) {
			expect(portableDocumentSearchTokens(`alpha${separator}beta`)).toEqual([
				"alpha",
				"beta",
			]);
		}
		expect(portableDocumentSearchTokens("  alpha \t\r\n beta  ")).toEqual([
			"alpha",
			"beta",
		]);
	});

	it("does NOT split on non-ASCII spaces", () => {
		// A locale-aware tokenizer would break these; PostgreSQL's would not, and
		// the docstring promises the two agree.
		const exotic = [0x00a0, 0x2028, 0x2029, 0x3000, 0x200b, 0x2003];
		for (const codePoint of exotic) {
			const value = `alpha${String.fromCharCode(codePoint)}beta`;
			expect(portableDocumentSearchTokens(value)).toHaveLength(1);
		}
	});

	it("case-folds ASCII only", () => {
		expect(portableDocumentSearchTokens("MiXeD Case")).toEqual([
			"mixed",
			"case",
		]);
	});

	it("leaves non-ASCII uppercase EXACTLY as written", () => {
		// toLowerCase() would fold all three and disagree with PostgreSQL's
		// lower() under a different collation. Dotted capital I is the classic
		// Turkish-locale hazard; U+212A KELVIN SIGN folds to a plain "k".
		const cases = [
			String.fromCharCode(0x0130), // LATIN CAPITAL LETTER I WITH DOT ABOVE
			String.fromCharCode(0x212a), // KELVIN SIGN
			String.fromCharCode(0xff21), // FULLWIDTH LATIN CAPITAL LETTER A
			"ÉÜÑ",
			"ПРИВЕТ",
		];
		for (const value of cases) {
			expect(portableDocumentSearchTokens(value)).toEqual([value]);
			expect(portableDocumentSearchTokens(value)[0]).not.toBe(
				value.toLowerCase(),
			);
		}
	});

	it("keeps punctuation-bearing terms whole", () => {
		// Emails, URLs and versions are the terms users actually search for.
		for (const term of [
			"user.name+tag@example.com",
			"https://example.com/a/b?c=d#e",
			"v1.2.3-rc.4",
			"snake_case-kebab",
		]) {
			expect(portableDocumentSearchTokens(term)).toEqual([term.toLowerCase()]);
		}
	});

	it("drops empty tokens rather than emitting them", () => {
		expect(portableDocumentSearchTokens("")).toEqual([]);
		expect(portableDocumentSearchTokens("   \t\n  ")).toEqual([]);
	});
});

describe("documentSearchText", () => {
	it("joins the searchable fields with newlines in a fixed order", () => {
		const value = documentSearchText(
			memory({
				content: { text: "body" },
				metadata: {
					type: MemoryType.DOCUMENT,
					title: "Title",
					filename: "stored.pdf",
					originalFilename: "Original.pdf",
					source: "upload",
				},
			}),
		);
		expect(value).toBe("body\nTitle\nstored.pdf\nOriginal.pdf\nupload");
	});

	it("drops non-string fields instead of stringifying them", () => {
		// "[object Object]" or "42" in the haystack would make a document
		// findable by a term nobody wrote.
		const value = documentSearchText(
			memory({
				metadata: {
					type: MemoryType.DOCUMENT,
					title: 42,
					filename: null,
					source: { nested: true },
				},
			} as Partial<Memory>),
		);
		expect(value).toBe("body");
	});

	it("tolerates a document with no metadata at all", () => {
		expect(
			documentSearchText({ ...memory(), metadata: undefined } as Memory),
		).toBe("body");
	});
});

describe("documentCreatedAt", () => {
	it("returns a safe-integer timestamp", () => {
		expect(documentCreatedAt(memory({ createdAt: 1_700_000_000_000 }))).toBe(
			1_700_000_000_000,
		);
	});

	it("refuses anything that would corrupt the ordering key", () => {
		for (const createdAt of [
			undefined,
			null,
			"1000",
			1.5,
			Number.NaN,
			Number.MAX_SAFE_INTEGER + 2,
		]) {
			expect(() =>
				documentCreatedAt(memory({ createdAt } as Partial<Memory>)),
			).toThrow(/valid creation time/);
		}
	});
});

describe("compareDocumentOrder", () => {
	const older = memory({
		id: "10000000-0000-0000-0000-000000000001" as UUID,
		createdAt: 1_000,
	});
	const newer = memory({
		id: "10000000-0000-0000-0000-000000000002" as UUID,
		createdAt: 2_000,
	});

	it("orders newest first", () => {
		expect(compareDocumentOrder(newer, older)).toBeLessThan(0);
		expect(compareDocumentOrder(older, newer)).toBeGreaterThan(0);
	});

	it("breaks a timestamp tie by DESCENDING id", () => {
		const low = memory({
			id: "10000000-0000-0000-0000-00000000000a" as UUID,
			createdAt: 5,
		});
		const high = memory({
			id: "10000000-0000-0000-0000-00000000000b" as UUID,
			createdAt: 5,
		});
		expect(compareDocumentOrder(high, low)).toBe(-1);
		expect(compareDocumentOrder(low, high)).toBe(1);
	});

	it("compares ids case-insensitively and is reflexive", () => {
		const lower = memory({
			id: "10000000-0000-0000-0000-0000000000ab" as UUID,
			createdAt: 5,
		});
		const upper = memory({
			id: "10000000-0000-0000-0000-0000000000AB" as UUID,
			createdAt: 5,
		});
		expect(compareDocumentOrder(lower, upper)).toBe(0);
		expect(compareDocumentOrder(lower, lower)).toBe(0);
	});

	it("is antisymmetric across a mixed batch", () => {
		const batch = [older, newer, memory({ createdAt: 2_000 })];
		for (const left of batch) {
			for (const right of batch) {
				// `|| 0` normalizes -0, which Object.is distinguishes from +0.
				expect(Math.sign(compareDocumentOrder(left, right)) || 0).toBe(
					-Math.sign(compareDocumentOrder(right, left)) || 0,
				);
			}
		}
	});

	it("produces a total order that a cursor can walk without repeats", () => {
		// The comparator and the cursor advance rule have to agree, or paging
		// either skips a document or serves one twice.
		const batch = [
			memory({
				id: "10000000-0000-0000-0000-00000000000a" as UUID,
				createdAt: 5,
			}),
			memory({
				id: "10000000-0000-0000-0000-00000000000c" as UUID,
				createdAt: 5,
			}),
			memory({
				id: "10000000-0000-0000-0000-00000000000b" as UUID,
				createdAt: 9,
			}),
		];
		const sorted = [...batch].sort(compareDocumentOrder);
		expect(sorted.map((entry) => entry.id)).toEqual([
			"10000000-0000-0000-0000-00000000000b",
			"10000000-0000-0000-0000-00000000000c",
			"10000000-0000-0000-0000-00000000000a",
		]);
		for (let index = 1; index < sorted.length; index++) {
			const previous = sorted[index - 1];
			const current = sorted[index];
			const sameTime = previous.createdAt === current.createdAt;
			// Strictly after the predecessor: older, or equal time and a smaller id.
			expect(
				(current.createdAt as number) < (previous.createdAt as number) ||
					(sameTime &&
						(current.id as string).toLowerCase() <
							(previous.id as string).toLowerCase()),
			).toBe(true);
		}
	});
});

describe("documentRoleHasGlobalVisibility", () => {
	it("grants global visibility to exactly OWNER, AGENT and RUNTIME", () => {
		for (const role of ["OWNER", "AGENT", "RUNTIME"] as const) {
			expect(documentRoleHasGlobalVisibility(role)).toBe(true);
		}
	});

	it("withholds it from every other known role", () => {
		for (const role of ["ADMIN", "USER", "GUEST", "UNRESOLVED"] as const) {
			expect(documentRoleHasGlobalVisibility(role)).toBe(false);
		}
	});
});

describe("validateDocumentRequesterContext", () => {
	it("accepts a well-formed context", () => {
		expect(() => validateDocumentRequesterContext(requester)).not.toThrow();
	});

	it("rejects a non-UUID agent or requester", () => {
		expect(() =>
			validateDocumentRequesterContext({
				...requester,
				agentId: "not-a-uuid" as UUID,
			}),
		).toThrow(/requester identity is invalid/);
		expect(() =>
			validateDocumentRequesterContext({
				...requester,
				requesterEntityId: undefined as unknown as UUID,
			}),
		).toThrow(/requester identity is invalid/);
	});

	it("rejects a role outside the known set", () => {
		expect(() =>
			validateDocumentRequesterContext({
				...requester,
				requesterRole: "SUPERUSER" as never,
			}),
		).toThrow(/requester role is invalid/);
	});

	it("bounds the requester room list", () => {
		const rooms = Array.from(
			{ length: DOCUMENT_LIST_MAX_REQUESTER_ROOMS },
			() => ROOM_ID,
		);
		expect(() =>
			validateDocumentRequesterContext({
				...requester,
				requesterRoomIds: rooms,
			}),
		).not.toThrow();
		expect(() =>
			validateDocumentRequesterContext({
				...requester,
				requesterRoomIds: [...rooms, ROOM_ID],
			}),
		).toThrow(/requester rooms are invalid/);
		expect(() =>
			validateDocumentRequesterContext({
				...requester,
				requesterRoomIds: ["nope" as UUID],
			}),
		).toThrow(/requester rooms are invalid/);
	});
});

describe("validateDocumentListQueryParams", () => {
	it("accepts the documented bounds at both ends", () => {
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, limit: 1, offset: 0 }),
		).not.toThrow();
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				limit: DOCUMENT_LIST_MAX_LIMIT,
				offset: DOCUMENT_LIST_MAX_OFFSET,
			}),
		).not.toThrow();
	});

	it("rejects one step outside each bound", () => {
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, limit: 0 }),
		).toThrow(/limit must be an integer/);
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				limit: DOCUMENT_LIST_MAX_LIMIT + 1,
			}),
		).toThrow(/limit must be an integer/);
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, offset: -1 }),
		).toThrow(/offset must be an integer/);
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				offset: DOCUMENT_LIST_MAX_OFFSET + 1,
			}),
		).toThrow(/offset must be an integer/);
	});

	it("refuses a cursor combined with a non-zero offset", () => {
		const cursor = { createdAt: 10, id: DOC_ID };
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, cursor }),
		).not.toThrow();
		// Both would move the window; applying them together double-skips.
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, cursor, offset: 5 }),
		).toThrow(/cannot be combined with a non-zero offset/);
	});

	it("rejects a malformed cursor", () => {
		for (const cursor of [
			{ createdAt: 1.5, id: DOC_ID },
			{ createdAt: 10, id: "nope" },
			{ createdAt: 10, id: DOC_ID, snapshotCreatedAt: 10 },
			{ createdAt: 10, id: DOC_ID, snapshotId: DOC_ID },
		]) {
			expect(() =>
				validateDocumentListQueryParams({
					...listParams,
					cursor: cursor as never,
				}),
			).toThrow(/cursor is invalid/);
		}
	});

	it("allows a query exactly at the length ceiling and refuses one more", () => {
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				query: "q".repeat(DOCUMENT_LIST_MAX_QUERY_LENGTH),
			}),
		).not.toThrow();
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				query: "q".repeat(DOCUMENT_LIST_MAX_QUERY_LENGTH + 1),
			}),
		).toThrow(/cannot exceed/);
	});

	it("rejects an unknown scope and non-UUID entity filters", () => {
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				scope: "everyone" as never,
			}),
		).toThrow(/scope is invalid/);
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				scopedToEntityId: "nope" as UUID,
			}),
		).toThrow(/scoped entity is invalid/);
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				addedBy: "nope" as UUID,
			}),
		).toThrow(/addedBy entity is invalid/);
	});

	it("rejects an inverted time range but accepts a single-instant one", () => {
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				timeRangeStart: 10,
				timeRangeEnd: 10,
			}),
		).not.toThrow();
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				timeRangeStart: 11,
				timeRangeEnd: 10,
			}),
		).toThrow(/time range is inverted/);
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, timeRangeStart: 1.5 }),
		).toThrow(/timeRangeStart must be a safe integer/);
	});

	it("bounds both the tag count and each tag's length", () => {
		const tags = Array.from({ length: DOCUMENT_LIST_MAX_TAGS }, () => "t");
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, tags }),
		).not.toThrow();
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, tags: [...tags, "t"] }),
		).toThrow(/tags exceed the supported bounds/);
		expect(() =>
			validateDocumentListQueryParams({ ...listParams, tags: [""] }),
		).toThrow(/tags exceed the supported bounds/);
		expect(() =>
			validateDocumentListQueryParams({
				...listParams,
				tags: ["t".repeat(DOCUMENT_LIST_MAX_TAG_LENGTH + 1)],
			}),
		).toThrow(/tags exceed the supported bounds/);
	});
});

describe("validateDocumentFragmentQueryParams", () => {
	const fragmentParams: DocumentFragmentQueryParams = {
		...requester,
		limit: 10,
	} as DocumentFragmentQueryParams;

	it("accepts the limit bounds and refuses one step outside", () => {
		for (const limit of [1, 1_000]) {
			expect(() =>
				validateDocumentFragmentQueryParams({ ...fragmentParams, limit }),
			).not.toThrow();
		}
		for (const limit of [0, 1_001, 1.5]) {
			expect(() =>
				validateDocumentFragmentQueryParams({ ...fragmentParams, limit }),
			).toThrow(/between 1 and 1000/);
		}
	});

	it("rejects a negative or fractional offset", () => {
		expect(() =>
			validateDocumentFragmentQueryParams({ ...fragmentParams, offset: 0 }),
		).not.toThrow();
		for (const offset of [-1, 2.5]) {
			expect(() =>
				validateDocumentFragmentQueryParams({ ...fragmentParams, offset }),
			).toThrow(/offset must be a non-negative integer/);
		}
	});

	it("rejects a non-UUID parent document id", () => {
		expect(() =>
			validateDocumentFragmentQueryParams({
				...fragmentParams,
				documentId: "nope" as UUID,
			}),
		).toThrow(/parent id is invalid/);
	});

	it("refuses a match threshold with no embedding to compare against", () => {
		expect(() =>
			validateDocumentFragmentQueryParams({
				...fragmentParams,
				matchThreshold: 0.5,
			}),
		).toThrow(/threshold requires an embedding/);
	});

	it("rejects an empty or non-finite embedding", () => {
		for (const embedding of [[], [1, Number.NaN], [Number.POSITIVE_INFINITY]]) {
			expect(() =>
				validateDocumentFragmentQueryParams({ ...fragmentParams, embedding }),
			).toThrow(/embedding is invalid/);
		}
	});

	it("enforces the expected embedding dimension when one is supplied", () => {
		expect(() =>
			validateDocumentFragmentQueryParams(
				{ ...fragmentParams, embedding: [1, 2, 3] },
				3,
			),
		).not.toThrow();
		expect(() =>
			validateDocumentFragmentQueryParams(
				{ ...fragmentParams, embedding: [1, 2] },
				3,
			),
		).toThrow(/embedding is invalid/);
	});

	it("accepts the full cosine range and refuses just outside it", () => {
		for (const matchThreshold of [-1, 0, 1]) {
			expect(() =>
				validateDocumentFragmentQueryParams({
					...fragmentParams,
					embedding: [1],
					matchThreshold,
				}),
			).not.toThrow();
		}
		for (const matchThreshold of [-1.0001, 1.0001, Number.NaN]) {
			expect(() =>
				validateDocumentFragmentQueryParams({
					...fragmentParams,
					embedding: [1],
					matchThreshold,
				}),
			).toThrow(/match threshold is invalid/);
		}
	});
});

describe("validateDocumentListQueryResult", () => {
	function result(overrides: Record<string, unknown> = {}) {
		return {
			documents: [],
			availableDocuments: [],
			totalVisible: 0,
			totalAvailable: 0,
			totalMatched: 0,
			hasMore: false,
			availableHasMore: false,
			...overrides,
		};
	}

	it("accepts a well-formed result", () => {
		expect(() =>
			validateDocumentListQueryResult(result(), listParams),
		).not.toThrow();
	});

	it("rejects a non-object", () => {
		for (const value of [null, undefined, 7, "rows"]) {
			expect(() => validateDocumentListQueryResult(value, listParams)).toThrow(
				/non-object/,
			);
		}
	});

	it("caps each row array at the requested limit", () => {
		const params = { ...listParams, limit: 2 };
		expect(() =>
			validateDocumentListQueryResult(
				result({ documents: [memory(), memory()] }),
				params,
			),
		).not.toThrow();
		// An adapter that ignores the limit would let a caller pull the table.
		expect(() =>
			validateDocumentListQueryResult(
				result({ documents: [memory(), memory(), memory()] }),
				params,
			),
		).toThrow(/invalid documents/);
		expect(() =>
			validateDocumentListQueryResult(
				result({ availableDocuments: [memory(), memory(), memory()] }),
				params,
			),
		).toThrow(/invalid availableDocuments/);
	});

	it("rejects non-object rows", () => {
		expect(() =>
			validateDocumentListQueryResult(
				result({ documents: [null] }),
				listParams,
			),
		).toThrow(/invalid documents/);
	});

	it("rejects negative or non-integer counts on every count field", () => {
		for (const field of ["totalVisible", "totalAvailable", "totalMatched"]) {
			for (const count of [-1, 1.5, "3", undefined]) {
				expect(() =>
					validateDocumentListQueryResult(
						result({ [field]: count }),
						listParams,
					),
				).toThrow(new RegExp(`invalid ${field}`));
			}
		}
	});

	it("requires hasMore and its cursor to agree in BOTH directions", () => {
		const cursor = { createdAt: 10, id: DOC_ID };
		expect(() =>
			validateDocumentListQueryResult(
				result({ hasMore: true, nextCursor: cursor }),
				listParams,
			),
		).not.toThrow();
		// hasMore without a cursor strands the caller mid-page...
		expect(() =>
			validateDocumentListQueryResult(result({ hasMore: true }), listParams),
		).toThrow(/invalid nextCursor/);
		// ...and a cursor without hasMore invites an extra empty round trip.
		expect(() =>
			validateDocumentListQueryResult(
				result({ hasMore: false, nextCursor: cursor }),
				listParams,
			),
		).toThrow(/invalid nextCursor/);
		expect(() =>
			validateDocumentListQueryResult(
				result({ availableHasMore: true }),
				listParams,
			),
		).toThrow(/invalid availableNextCursor/);
	});

	it("rejects a malformed cursor even when hasMore agrees", () => {
		expect(() =>
			validateDocumentListQueryResult(
				result({ hasMore: true, nextCursor: { createdAt: 1.5, id: DOC_ID } }),
				listParams,
			),
		).toThrow(/invalid nextCursor/);
	});
});

describe("hasDocumentListQueryCapability", () => {
	it("accepts an adapter that declares the current version and every method", () => {
		expect(
			hasDocumentListQueryCapability(
				capableAdapter() as unknown as IDatabaseAdapter,
			),
		).toBe(true);
	});

	it("refuses a stale or absent capability version", () => {
		for (const version of [
			undefined,
			DOCUMENT_LIST_QUERY_CAPABILITY_VERSION - 1,
			String(DOCUMENT_LIST_QUERY_CAPABILITY_VERSION),
		]) {
			const adapter = capableAdapter();
			adapter.documentListQueryCapability = version;
			expect(
				hasDocumentListQueryCapability(adapter as unknown as IDatabaseAdapter),
			).toBe(false);
		}
	});

	it("requires EVERY method, not merely some of them", () => {
		// Each name is load-bearing: a partial adapter that passed here would
		// fail at call time instead of at negotiation time.
		const methods = [
			"queryDocuments",
			"getDocument",
			"queryDocumentFragments",
			"compareAndSwapDocument",
			"updateDocumentDirectGrants",
			"replaceDocumentRevision",
			"deleteDocumentWithSnapshot",
		];
		for (const method of methods) {
			const adapter = capableAdapter();
			delete adapter[method];
			expect(
				hasDocumentListQueryCapability(adapter as unknown as IDatabaseAdapter),
			).toBe(false);
		}
		for (const method of methods) {
			const adapter = capableAdapter();
			adapter[method] = "not-a-function";
			expect(
				hasDocumentListQueryCapability(adapter as unknown as IDatabaseAdapter),
			).toBe(false);
		}
	});
});
