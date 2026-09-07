/**
 * Persists complete session-summary content ledgers as immutable, ordered
 * memory shards behind an atomically published room head. Stored records contain
 * opaque references and ranges only, never source bodies or native paths.
 */
import { ElizaError } from "../../errors.ts";
import {
	type CompactionContentEntry,
	type CompactionContentManifest,
	validateCompactionContentManifest,
} from "../../types/content-manifest.ts";
import type { Memory } from "../../types/memory.ts";
import type { JsonValue, UUID } from "../../types/primitives.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import { createHash } from "../../utils/crypto-compat.ts";
import { stringToUuid } from "../../utils.ts";

export const SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY =
	"elizaos:progressiveContent";
export const SESSION_SUMMARY_PROGRESSIVE_CONTENT_SCHEMA_VERSION = 2 as const;
export const SESSION_SUMMARY_CONTENT_HEAD_TABLE =
	"session_summary_content_heads";
export const SESSION_SUMMARY_CONTENT_SHARD_TABLE =
	"session_summary_content_shards";
export const SESSION_SUMMARY_CONTENT_SHARD_MAX_RECORDS = 32;
export const SESSION_SUMMARY_CONTENT_SHARD_MAX_BYTES = 48 * 1024;
const MAX_CAS_ATTEMPTS = 8;
const ENVELOPE_KEYS = new Set([
	"schemaVersion",
	"headMemoryId",
	"headRevision",
	"ledgerDigest",
	"recordCount",
	"shardCount",
]);
const HEAD_KEYS = new Set([
	"schemaVersion",
	"headRevision",
	"firstShardId",
	"firstShardDigest",
	"ledgerDigest",
	"recordCount",
	"shardCount",
]);
const SHARD_KEYS = new Set([
	"schemaVersion",
	"position",
	"publicationDigest",
	"records",
	"nextShardId",
	"nextShardDigest",
]);

type ModifiedFile = CompactionContentManifest["modifiedFiles"][number];
type PendingProcess = CompactionContentManifest["pendingProcesses"][number];
export type SessionSummaryContentRecord =
	| { kind: "content-reference"; value: CompactionContentEntry }
	| { kind: "modified-file"; value: ModifiedFile }
	| { kind: "pending-process"; value: PendingProcess };
export interface SessionSummaryContentHead {
	schemaVersion: 1;
	headRevision: string;
	firstShardId: UUID | null;
	firstShardDigest: string | null;
	ledgerDigest: string;
	recordCount: number;
	shardCount: number;
}
export interface SessionSummaryContentEnvelope {
	schemaVersion: typeof SESSION_SUMMARY_PROGRESSIVE_CONTENT_SCHEMA_VERSION;
	headMemoryId: UUID;
	headRevision: string;
	ledgerDigest: string;
	recordCount: number;
	shardCount: number;
}
interface SessionSummaryContentShard {
	schemaVersion: 1;
	position: number;
	publicationDigest: string;
	records: SessionSummaryContentRecord[];
	nextShardId: UUID | null;
	nextShardDigest: string | null;
}
export interface SessionSummaryContentLedger {
	envelope: SessionSummaryContentEnvelope;
	records: SessionSummaryContentRecord[];
	publicationDigests: ReadonlySet<string>;
}
export interface PublishSessionSummaryContentParams {
	runtime: IAgentRuntime;
	roomId: UUID;
	entityId: UUID;
	manifests: readonly unknown[];
}
export interface SessionSummaryManifestRenderOptions {
	maxRecords?: number;
	maxCharacters?: number;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function exactKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length)
		throw new TypeError(
			`${label} contains unsupported field(s): ${unknown.join(", ")}`,
		);
}
function nonnegative(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError(`${label} must be a nonnegative safe integer`);
	return value;
}
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
		throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
	return value;
}
function uuid(value: unknown, label: string): UUID {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
			value,
		)
	)
		throw new TypeError(`${label} must be a UUID`);
	return value as UUID;
}
function validateEnvelope(value: unknown): SessionSummaryContentEnvelope {
	const input = objectRecord(value, "session summary content envelope");
	exactKeys(input, ENVELOPE_KEYS, "session summary content envelope");
	if (input.schemaVersion !== 2)
		throw new TypeError(
			"session summary content envelope schemaVersion is unsupported",
		);
	return {
		schemaVersion: 2,
		headMemoryId: uuid(input.headMemoryId, "headMemoryId"),
		headRevision: sha256(input.headRevision, "headRevision"),
		ledgerDigest: sha256(input.ledgerDigest, "ledgerDigest"),
		recordCount: nonnegative(input.recordCount, "recordCount"),
		shardCount: nonnegative(input.shardCount, "shardCount"),
	};
}
function validateHead(value: unknown): SessionSummaryContentHead {
	const input = objectRecord(value, "session summary content head");
	exactKeys(input, HEAD_KEYS, "session summary content head");
	if (input.schemaVersion !== 1)
		throw new TypeError("content head schemaVersion is unsupported");
	const head: SessionSummaryContentHead = {
		schemaVersion: 1,
		headRevision: sha256(input.headRevision, "headRevision"),
		firstShardId:
			input.firstShardId === null
				? null
				: uuid(input.firstShardId, "firstShardId"),
		firstShardDigest:
			input.firstShardDigest === null
				? null
				: sha256(input.firstShardDigest, "firstShardDigest"),
		ledgerDigest: sha256(input.ledgerDigest, "ledgerDigest"),
		recordCount: nonnegative(input.recordCount, "recordCount"),
		shardCount: nonnegative(input.shardCount, "shardCount"),
	};
	if (
		(head.firstShardId === null) !== (head.firstShardDigest === null) ||
		(head.shardCount === 0) !== (head.firstShardId === null)
	)
		throw new TypeError("content head chain metadata mismatch");
	const {
		schemaVersion: _schemaVersion,
		headRevision: _headRevision,
		...seed
	} = head;
	if (hash(seed) !== head.headRevision)
		throw new TypeError("content head revision does not bind its fields");
	return head;
}
function validateRecord(value: unknown): SessionSummaryContentRecord {
	const input = objectRecord(value, "session summary content record");
	if (Object.keys(input).sort().join() !== "kind,value")
		throw new TypeError(
			"session summary content record has unsupported fields",
		);
	const base = {
		schemaVersion: 1,
		contentRefs: [],
		modifiedFiles: [],
		pendingProcesses: [],
	};
	if (input.kind === "content-reference") {
		const manifest = validateCompactionContentManifest({
			...base,
			contentRefs: [input.value],
		});
		return { kind: input.kind, value: manifest.contentRefs[0] };
	}
	if (input.kind === "modified-file") {
		const manifest = validateCompactionContentManifest({
			...base,
			modifiedFiles: [input.value],
		});
		return { kind: input.kind, value: manifest.modifiedFiles[0] };
	}
	if (input.kind === "pending-process") {
		const manifest = validateCompactionContentManifest({
			...base,
			pendingProcesses: [input.value],
		});
		return { kind: input.kind, value: manifest.pendingProcesses[0] };
	}
	throw new TypeError("session summary content record kind is unsupported");
}
function validateShard(value: unknown): SessionSummaryContentShard {
	const input = objectRecord(value, "session summary content shard");
	exactKeys(input, SHARD_KEYS, "session summary content shard");
	if (input.schemaVersion !== 1)
		throw new TypeError("content shard schemaVersion is unsupported");
	if (!Array.isArray(input.records) || input.records.length === 0)
		throw new TypeError("content shard records must be a nonempty array");
	if (input.records.length > SESSION_SUMMARY_CONTENT_SHARD_MAX_RECORDS)
		throw new TypeError("content shard exceeds its record ceiling");
	const shard: SessionSummaryContentShard = {
		schemaVersion: 1,
		position: nonnegative(input.position, "content shard position"),
		publicationDigest: sha256(input.publicationDigest, "publicationDigest"),
		records: input.records.map(validateRecord),
		nextShardId:
			input.nextShardId === null
				? null
				: uuid(input.nextShardId, "nextShardId"),
		nextShardDigest:
			input.nextShardDigest === null
				? null
				: sha256(input.nextShardDigest, "nextShardDigest"),
	};
	if ((shard.nextShardId === null) !== (shard.nextShardDigest === null))
		throw new TypeError("content shard next id/digest presence mismatch");
	if (
		new TextEncoder().encode(JSON.stringify(shard)).byteLength >
		SESSION_SUMMARY_CONTENT_SHARD_MAX_BYTES
	)
		throw new TypeError("content shard exceeds its serialized byte ceiling");
	return shard;
}
function recordsFromManifests(
	manifests: readonly unknown[],
): SessionSummaryContentRecord[] {
	const records: SessionSummaryContentRecord[] = [];
	for (const value of manifests) {
		const manifest = validateCompactionContentManifest(value);
		for (const entry of manifest.contentRefs)
			records.push({ kind: "content-reference", value: entry });
		for (const file of manifest.modifiedFiles)
			records.push({ kind: "modified-file", value: file });
		for (const process of manifest.pendingProcesses)
			records.push({ kind: "pending-process", value: process });
	}
	return records;
}
function memoryJson(memory: Memory, label: string): unknown {
	if (typeof memory.content.text !== "string")
		throw new TypeError(`${label} content must be JSON text`);
	try {
		return JSON.parse(memory.content.text);
	} catch (cause) {
		throw new ElizaError(`${label} content is not valid JSON`, {
			code: "CONTENT_CONTINUITY_INTEGRITY_FAILED",
			cause,
		});
	}
}
function envelopeFor(
	id: UUID,
	head: SessionSummaryContentHead,
): SessionSummaryContentEnvelope {
	return {
		schemaVersion: 2,
		headMemoryId: id,
		headRevision: head.headRevision,
		ledgerDigest: head.ledgerDigest,
		recordCount: head.recordCount,
		shardCount: head.shardCount,
	};
}
export function parseSessionSummaryContentEnvelope(
	metadata: Record<string, JsonValue> | undefined,
): SessionSummaryContentEnvelope | undefined {
	const value = (metadata as Record<string, unknown> | undefined)?.[
		SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY
	];
	return value === undefined ? undefined : validateEnvelope(value);
}
export function mergeSessionSummaryMetadata(
	existingMetadata: Record<string, JsonValue> | undefined,
	keyPoints: readonly string[],
	envelope?: SessionSummaryContentEnvelope,
): Record<string, JsonValue> {
	return {
		...existingMetadata,
		keyPoints: [...keyPoints],
		...(envelope
			? {
					[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]:
						envelope as unknown as JsonValue,
				}
			: {}),
	};
}
/** Selects the newest monotonic room pointer from retained summary/messages. */
export function latestSessionSummaryContentEnvelope(
	existingMetadata: Record<string, JsonValue> | undefined,
	messages: readonly Memory[],
): SessionSummaryContentEnvelope | undefined {
	const candidates = [
		parseSessionSummaryContentEnvelope(existingMetadata),
		...messages.map((message) =>
			parseSessionSummaryContentEnvelope(
				message.metadata as Record<string, JsonValue> | undefined,
			),
		),
	].filter(
		(value): value is SessionSummaryContentEnvelope => value !== undefined,
	);
	if (!candidates.length) return undefined;
	const headIds = new Set(
		candidates.map((candidate) => candidate.headMemoryId),
	);
	if (headIds.size !== 1)
		throw new TypeError("session summary content pointers cross room heads");
	return candidates.reduce((latest, candidate) =>
		candidate.recordCount > latest.recordCount ||
		(candidate.recordCount === latest.recordCount &&
			candidate.shardCount > latest.shardCount)
			? candidate
			: latest,
	);
}
function deterministicHeadId(agentId: UUID, roomId: UUID): UUID {
	return stringToUuid(`session-summary-content-head:${agentId}:${roomId}`);
}
async function readHead(
	runtime: IAgentRuntime,
	id: UUID,
	roomId: UUID,
): Promise<SessionSummaryContentHead | null> {
	const memory = await runtime.getMemoryById(id);
	if (!memory) return null;
	if (memory.agentId !== runtime.agentId)
		throw new TypeError("content head belongs to another agent");
	if (memory.roomId !== roomId)
		throw new TypeError("content head belongs to another room");
	return validateHead(memoryJson(memory, "session summary content head"));
}

/** Traverses every shard and rejects any valid-looking prefix of a malformed chain. */
export async function loadSessionSummaryContentLedger(
	runtime: IAgentRuntime,
	envelopeValue: unknown,
	roomId: UUID,
): Promise<SessionSummaryContentLedger> {
	const envelope = validateEnvelope(envelopeValue);
	const headMemory = await runtime.getMemoryById(envelope.headMemoryId);
	if (!headMemory)
		throw new ElizaError("Session-summary content head is missing", {
			code: "CONTENT_CONTINUITY_HEAD_MISSING",
		});
	if (headMemory.agentId !== runtime.agentId || headMemory.roomId !== roomId)
		throw new ElizaError(
			"Session-summary content head is outside the authorized room",
			{ code: "CONTENT_CONTINUITY_UNAUTHORIZED_HEAD" },
		);
	const head = validateHead(
		memoryJson(headMemory, "session summary content head"),
	);
	if (
		head.headRevision !== envelope.headRevision ||
		head.ledgerDigest !== envelope.ledgerDigest ||
		head.recordCount !== envelope.recordCount ||
		head.shardCount !== envelope.shardCount
	)
		throw new ElizaError(
			"Session-summary content envelope does not match its head",
			{ code: "CONTENT_CONTINUITY_HEAD_MISMATCH" },
		);
	const visited = new Set<UUID>();
	const descending: SessionSummaryContentShard[] = [];
	const publications = new Set<string>();
	let nextId = head.firstShardId;
	let expectedDigest = head.firstShardDigest;
	let expectedPosition = head.shardCount - 1;
	while (nextId) {
		if (visited.has(nextId))
			throw new ElizaError(
				"Session-summary content shard cycle/repeat detected",
				{ code: "CONTENT_CONTINUITY_CYCLE" },
			);
		visited.add(nextId);
		const memory = await runtime.getMemoryById(nextId);
		if (!memory)
			throw new ElizaError("Session-summary content shard is missing", {
				code: "CONTENT_CONTINUITY_SHARD_MISSING",
				context: { shardId: nextId },
			});
		if (memory.agentId !== runtime.agentId || memory.roomId !== roomId)
			throw new ElizaError(
				"Session-summary content shard is outside the authorized room",
				{
					code: "CONTENT_CONTINUITY_UNAUTHORIZED_SHARD",
					context: { shardId: nextId },
				},
			);
		const raw = memoryJson(memory, "session summary content shard");
		if (hash(raw) !== expectedDigest)
			throw new ElizaError("Session-summary content shard digest mismatch", {
				code: "CONTENT_CONTINUITY_DIGEST_MISMATCH",
				context: { shardId: nextId },
			});
		const shard = validateShard(raw);
		if (shard.position !== expectedPosition)
			throw new ElizaError(
				"Session-summary content shard order/skip mismatch",
				{
					code: "CONTENT_CONTINUITY_ORDER_MISMATCH",
					context: { expectedPosition, actualPosition: shard.position },
				},
			);
		descending.push(shard);
		publications.add(shard.publicationDigest);
		nextId = shard.nextShardId;
		expectedDigest = shard.nextShardDigest;
		expectedPosition -= 1;
	}
	if (
		descending.length !== head.shardCount ||
		expectedPosition !== -1 ||
		expectedDigest !== null
	)
		throw new ElizaError("Session-summary content shard chain ended early", {
			code: "CONTENT_CONTINUITY_CHAIN_LENGTH_MISMATCH",
		});
	const records = descending.reverse().flatMap((shard) => shard.records);
	if (
		records.length !== head.recordCount ||
		hash(records) !== head.ledgerDigest
	)
		throw new ElizaError(
			"Session-summary content ledger count or digest mismatch",
			{ code: "CONTENT_CONTINUITY_LEDGER_MISMATCH" },
		);
	return { envelope, records, publicationDigests: publications };
}
function chunksFor(
	records: SessionSummaryContentRecord[],
): SessionSummaryContentRecord[][] {
	const chunks: SessionSummaryContentRecord[][] = [];
	let current: SessionSummaryContentRecord[] = [];
	for (const record of records) {
		const candidate = [...current, record];
		const byteLength = (values: SessionSummaryContentRecord[]) =>
			new TextEncoder().encode(
				JSON.stringify({
					schemaVersion: 1,
					position: 0,
					publicationDigest: "0".repeat(64),
					records: values,
					nextShardId: null,
					nextShardDigest: null,
				}),
			).byteLength;
		if (
			current.length &&
			(candidate.length > SESSION_SUMMARY_CONTENT_SHARD_MAX_RECORDS ||
				byteLength(candidate) > SESSION_SUMMARY_CONTENT_SHARD_MAX_BYTES)
		) {
			chunks.push(current);
			current = [record];
		} else current = candidate;
		if (byteLength(current) > SESSION_SUMMARY_CONTENT_SHARD_MAX_BYTES)
			throw new TypeError(
				"one content ledger record exceeds the shard byte ceiling",
			);
	}
	if (current.length) chunks.push(current);
	return chunks;
}

/** Appends one publication and CAS-publishes its head, retrying conflicts safely. */
export async function publishSessionSummaryContentManifests(
	params: PublishSessionSummaryContentParams,
): Promise<SessionSummaryContentEnvelope | undefined> {
	const incoming = recordsFromManifests(params.manifests);
	if (!incoming.length) return undefined;
	const publicationDigest = hash(incoming);
	const id = deterministicHeadId(params.runtime.agentId, params.roomId);
	const cas = params.runtime.adapter.compareAndSwapMemoryPublication;
	if (!cas)
		throw new ElizaError(
			"Database adapter has no atomic memory publication capability",
			{ code: "CONTENT_CONTINUITY_ATOMIC_PUBLICATION_UNSUPPORTED" },
		);
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
		const priorHead = await readHead(params.runtime, id, params.roomId);
		let priorRecords: SessionSummaryContentRecord[] = [];
		if (priorHead) {
			const prior = await loadSessionSummaryContentLedger(
				params.runtime,
				envelopeFor(id, priorHead),
				params.roomId,
			);
			if (prior.publicationDigests.has(publicationDigest))
				return prior.envelope;
			priorRecords = prior.records;
		}
		const allRecords = [...priorRecords, ...incoming];
		const chunks = chunksFor(incoming);
		let nextShardId: UUID | null = priorHead?.firstShardId ?? null;
		let nextShardDigest: string | null = priorHead?.firstShardDigest ?? null;
		const dependencies: Array<{ memory: Memory; tableName: string }> = [];
		for (let offset = 0; offset < chunks.length; offset += 1) {
			const position = (priorHead?.shardCount ?? 0) + offset;
			const shard: SessionSummaryContentShard = {
				schemaVersion: 1,
				position,
				publicationDigest,
				records: chunks[offset],
				nextShardId,
				nextShardDigest,
			};
			const shardDigest = hash(shard);
			const shardId = stringToUuid(
				`session-summary-content-shard:${shardDigest}`,
			);
			dependencies.push({
				tableName: SESSION_SUMMARY_CONTENT_SHARD_TABLE,
				memory: {
					id: shardId,
					agentId: params.runtime.agentId,
					entityId: params.entityId,
					roomId: params.roomId,
					content: { text: JSON.stringify(shard) },
					metadata: {
						type: "custom",
						source: "session-summary-content-shard",
						scope: "room",
					},
					unique: true,
				},
			});
			nextShardId = shardId;
			nextShardDigest = shardDigest;
		}
		const seed = {
			firstShardId: nextShardId,
			firstShardDigest: nextShardDigest,
			ledgerDigest: hash(allRecords),
			recordCount: allRecords.length,
			shardCount: (priorHead?.shardCount ?? 0) + chunks.length,
		};
		const head: SessionSummaryContentHead = {
			schemaVersion: 1,
			headRevision: hash(seed),
			...seed,
		};
		const result = await cas.call(params.runtime.adapter, {
			expectedRevision: priorHead?.headRevision ?? null,
			dependencies,
			head: {
				tableName: SESSION_SUMMARY_CONTENT_HEAD_TABLE,
				memory: {
					id,
					agentId: params.runtime.agentId,
					entityId: params.entityId,
					roomId: params.roomId,
					content: { text: JSON.stringify(head) },
					metadata: {
						type: "custom",
						source: "session-summary-content-head",
						scope: "room",
						revision: head.headRevision,
					},
					unique: true,
				},
			},
		});
		if (result.status === "published") return envelopeFor(id, head);
	}
	throw new ElizaError(
		"Session-summary content publication exhausted CAS retries",
		{
			code: "CONTENT_CONTINUITY_CAS_EXHAUSTED",
			context: { roomId: params.roomId },
		},
	);
}
function positive(
	value: number | undefined,
	fallback: number,
	label: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1)
		throw new TypeError(`${label} must be a positive safe integer`);
	return value;
}
/** Renders a bounded body-free projection while the durable ledger stays complete. */
export function renderSessionSummaryContentLedger(
	ledger: SessionSummaryContentLedger,
	options: SessionSummaryManifestRenderOptions = {},
): string {
	const maxRecords = positive(options.maxRecords, 12, "maxRecords");
	const maxCharacters = positive(options.maxCharacters, 4096, "maxCharacters");
	const lines = ["**Recoverable content references (source bodies omitted)**"];
	for (const record of ledger.records.slice(-maxRecords)) {
		if (record.kind === "content-reference") {
			const entry = record.value;
			const revision = entry.revision ?? entry.reference.revision;
			const ranges = entry.rangesUsed
				.map((range) => `${range.unit}:${range.start}-${range.end}`)
				.join(", ");
			lines.push(
				`- ${entry.reference.kind}:${entry.reference.ref}${revision ? `@${revision}` : ""}${ranges ? ` [${ranges}]` : ""}`,
			);
		} else if (record.kind === "modified-file")
			lines.push(
				`- modified ${record.value.reference.kind}:${record.value.reference.ref}`,
			);
		else lines.push(`- pending ${record.value.id}`);
	}
	if (ledger.records.length > maxRecords)
		lines.push(
			`- … ${ledger.records.length - maxRecords} earlier durable records`,
		);
	let rendered = "";
	for (const line of lines) {
		const candidate = rendered ? `${rendered}\n${line}` : line;
		if (candidate.length > maxCharacters) break;
		rendered = candidate;
	}
	return rendered;
}
