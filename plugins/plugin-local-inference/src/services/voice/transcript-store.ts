/**
 * Transcript store (#8789 transcripts) — persistence for the rich transcript
 * record (audio URL + word-timed diarized segments).
 *
 * Reuses the runtime's proven `memories` partition mechanism (exactly how the
 * documents store works) rather than a new table/migration: each transcript is
 * one memory row in the `"transcripts"` partition, with the full {@link Transcript}
 * in `content.transcript`. The player loads a whole record by id and the list
 * reads recent rows — no querying INSIDE segments is needed, because search is
 * served by the knowledge mirror (see `transcript-knowledge.ts`). A custom
 * `metadata.type` keeps it clear of the document/fragment CHECK constraints.
 */

import {
	type AccessContext,
	type ArtifactDisclosure,
	type ArtifactRoomSnapshot,
	type ArtifactShareGrant,
	type ArtifactShareGrantMode,
	CompositeEntityRecognizer,
	detectPii,
	ElizaError,
	GazetteerEntityRecognizer,
	type JsonObject,
	type Memory,
	type MemoryMetadata,
	type PiiEntityRecognizer,
	PseudonymSession,
	parseArtifactShareMetadata,
	RegexEntityRecognizer,
	resolveArtifactDisclosure,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type {
	Transcript,
	TranscriptConsentState,
	TranscriptSummary,
} from "@elizaos/shared/transcripts";
import {
	normalizeTranscriptScope,
	summarizeTranscript,
	transcriptCapturePrivacyState,
	transcriptPreview,
} from "@elizaos/shared/transcripts";

/** The `type` column partition transcripts live in (sibling to "messages"). */
export const TRANSCRIPTS_TABLE = "transcripts";
/** `metadata.type` marker — NOT "document"/"fragment", so no CHECK fires. */
export const TRANSCRIPT_METADATA_TYPE = "transcript";

/** The subset of `IAgentRuntime` the store needs (real runtime satisfies it). */
export interface TranscriptStoreRuntime {
	agentId: UUID;
	createMemory(
		memory: Memory,
		tableName: string,
		unique?: boolean,
	): Promise<UUID>;
	getMemories(params: {
		tableName: string;
		roomId?: UUID;
		count?: number;
		orderBy?: "createdAt";
		orderDirection?: "asc" | "desc";
	}): Promise<Memory[]>;
	getMemoryById(id: UUID): Promise<Memory | null>;
	updateMemory(
		memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
	): Promise<boolean>;
	deleteMemory(id: UUID): Promise<void>;
}

export interface CreateTranscriptInput {
	roomId: UUID;
	/** The owner/speaker entity the recording is attributed to. */
	entityId: UUID;
	/** The fully-built transcript record (audio + segments + words). */
	transcript: Transcript;
}

export interface CreateRedactedTranscriptVariantInput {
	/** The stored original transcript id. */
	originalId: UUID;
	/** Entity issuing the redaction, recorded on metadata for audit context. */
	redactedBy?: UUID;
	/** Stable seed for deterministic tests; defaults to the original id. */
	seed?: string;
	/** Epoch ms override for deterministic tests. */
	nowMs?: number;
	/** Verified redacted media URL; absent means the variant withholds audio. */
	redactedAudioUrl?: string;
	/** Optional runtime/model recognizer composed with deterministic local guards. */
	recognizer?: PiiEntityRecognizer;
}

export interface ShareTranscriptGrantInput {
	transcriptId: UUID;
	entityId: UUID;
	mode: ArtifactShareGrantMode;
	grantedBy?: UUID;
	grantedAtMs?: number;
}

export interface RevokeTranscriptGrantInput {
	transcriptId: UUID;
	entityId: UUID;
}

export interface ShareTranscriptRoomSnapshotInput {
	transcriptId: UUID;
	roomId: UUID;
	entityIds: readonly UUID[];
	mode: ArtifactShareGrantMode;
	grantedBy?: UUID;
	grantedAtMs?: number;
}

/** Pull the stored {@link Transcript} back out of a memory row (parses the
 *  JSON blob; a corrupt/legacy row yields null and is skipped by the list). */
function rowToTranscript(row: Memory): Transcript | null {
	const raw = (row.content as { transcript?: unknown }).transcript;
	if (typeof raw !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Transcript) : null;
	} catch {
		// error-policy:J3 corrupt or legacy transcript JSON is an invalid row,
		// never a fabricated empty transcript.
		return null;
	}
}

/**
 * The viewer's disclosure decision for one transcript row — the ONE role-aware
 * predicate from core (#14781) fed with this store's row shape: scope from the
 * stored record (fail-closed normalize), owning entity from
 * `metadata.scopedToEntityId` (else the row's entity), and share grants from
 * `metadata.share.grants`.
 */
export function transcriptRowDisclosure(
	row: Memory,
	transcript: Pick<Transcript, "scope">,
	accessContext: AccessContext | undefined,
	agentId: UUID,
): ArtifactDisclosure {
	const metadata = row.metadata as Record<string, unknown> | undefined;
	const scopedTo = metadata?.scopedToEntityId;
	const scopedEntityId =
		typeof scopedTo === "string" ? (scopedTo as UUID) : row.entityId;
	return resolveArtifactDisclosure(
		{
			scope: normalizeTranscriptScope(transcript.scope),
			scopedEntityId,
			grants: parseArtifactShareMetadata(metadata).grants,
		},
		accessContext,
		agentId,
	);
}

/** Consent state accepted by every transcript-sharing write path. */
export function transcriptConsentAllowsSharing(
	transcript: Transcript,
): boolean {
	const state = transcriptCapturePrivacyState(transcript).consentState;
	return state === "granted" || state === "not_required";
}

/** Fail closed when capture did not persist an affirmative sharing state. */
function assertTranscriptConsentAllowsSharing(transcript: Transcript): void {
	if (transcriptConsentAllowsSharing(transcript)) return;
	const state: TranscriptConsentState =
		transcriptCapturePrivacyState(transcript).consentState ?? "unknown";
	throw new ElizaError(
		`transcript consent state ${state} does not permit sharing`,
		{
			code: "TRANSCRIPT_CONSENT_NOT_SHAREABLE",
			context: { transcriptId: transcript.id, consentState: state },
		},
	);
}

/**
 * Whether this row stores a redacted VARIANT of another transcript (write
 * contract for PERM-REDACT #14779): the variant row's metadata carries
 * `redactionOf: <original id>`. Variants never appear as standalone list rows —
 * they are served only in place of their original for redacted-grant viewers.
 */
function redactionOriginalId(row: Memory): UUID | null {
	const metadata = row.metadata as Record<string, unknown> | undefined;
	const of = metadata?.redactionOf;
	return typeof of === "string" && of.length > 0 ? (of as UUID) : null;
}

/** The original row's link to its redacted variant record, when one exists. */
function redactedVariantId(row: Memory): UUID | null {
	const metadata = row.metadata as Record<string, unknown> | undefined;
	const id = metadata?.redactedVariantId;
	return typeof id === "string" && id.length > 0 ? (id as UUID) : null;
}

/**
 * Project a redacted variant's content onto the ORIGINAL artifact's identity
 * for a redacted-grant viewer: one artifact keeps one id for every viewer,
 * with per-viewer content. Any audio URL comes only from the variant record,
 * and every content field (title, segments, knowledge mirror id, metadata)
 * comes from the variant so nothing of the original can leak through.
 */
function serveRedactedVariant(
	variant: Transcript,
	original: Pick<Transcript, "id" | "createdAt" | "endedAt" | "source">,
): Transcript {
	return {
		...variant,
		id: original.id,
		createdAt: original.createdAt,
		...(original.endedAt !== undefined ? { endedAt: original.endedAt } : {}),
		source: original.source,
		redacted: true,
	};
}

function redactedText(text: string): string {
	const matches = detectPii(text);
	if (matches.length === 0) return text;
	let out = "";
	let cursor = 0;
	for (const match of [...matches].sort((a, b) => a.start - b.start)) {
		if (match.start < cursor) continue;
		out += text.slice(cursor, match.start);
		out += `[${match.kind.toUpperCase()}]`;
		cursor = match.end;
	}
	out += text.slice(cursor);
	return out;
}

function transcriptRosterEntries(
	transcript: Transcript,
): Array<{ kind: string; value: string }> {
	const participants = transcript.metadata?.participants;
	if (!Array.isArray(participants)) return [];
	const names = new Set<string>();
	for (const participant of participants) {
		if (!participant || typeof participant !== "object") continue;
		const displayName = (participant as { displayName?: unknown }).displayName;
		if (typeof displayName !== "string" || !displayName.trim()) continue;
		names.add(displayName.trim());
	}
	return [...names].map((value) => ({ kind: "person", value }));
}

/**
 * Compose the transcript redactor's deterministic structured-PII and roster
 * recognizers with the optional local model recognizer supplied by the runtime.
 */
export function transcriptPiiRecognizer(
	transcript: Transcript,
	supplemental?: PiiEntityRecognizer,
): PiiEntityRecognizer {
	const recognizers: PiiEntityRecognizer[] = [new RegexEntityRecognizer()];
	const roster = transcriptRosterEntries(transcript);
	if (roster.length > 0) {
		recognizers.push(
			new GazetteerEntityRecognizer(roster, { name: "transcript-roster" }),
		);
	}
	if (supplemental) recognizers.push(supplemental);
	return new CompositeEntityRecognizer(recognizers);
}

function transcriptTextCorpus(transcript: Transcript): string {
	return [
		transcript.title,
		...transcript.segments.flatMap((segment) => [
			segment.speakerLabel ?? "",
			segment.text,
			...segment.words.map((word) => word.text),
		]),
	].join("\n");
}

async function redactTranscript(
	original: Transcript,
	redactedAudioUrl?: string,
	seed?: string,
	supplementalRecognizer?: PiiEntityRecognizer,
): Promise<Transcript> {
	const pseudonyms = new PseudonymSession({
		salt: `transcript-redaction:${original.id}:${seed ?? ""}`,
		recognizer: transcriptPiiRecognizer(original, supplementalRecognizer),
	});
	await pseudonyms.learn(transcriptTextCorpus(original));
	const safeText = (text: string): string =>
		redactedText(pseudonyms.substituteText(text));
	const segments = original.segments.map((segment) => ({
		id: segment.id,
		...(segment.speakerLabel
			? { speakerLabel: safeText(segment.speakerLabel) }
			: {}),
		startMs: segment.startMs,
		endMs: segment.endMs,
		text: safeText(segment.text),
		words: segment.words.map((word) => ({
			...word,
			text: safeText(word.text),
		})),
		...(segment.confidence !== undefined
			? { confidence: segment.confidence }
			: {}),
	}));
	return {
		id: original.id,
		title: `${safeText(original.title)} (redacted)`,
		createdAt: original.createdAt,
		...(original.endedAt !== undefined ? { endedAt: original.endedAt } : {}),
		...(original.editedAt !== undefined ? { editedAt: original.editedAt } : {}),
		durationMs: original.durationMs,
		...(redactedAudioUrl
			? {
					audioUrl: redactedAudioUrl,
					...(original.audioContentType
						? { audioContentType: original.audioContentType }
						: {}),
				}
			: {}),
		segments,
		source: original.source,
		scope: original.scope,
		status: original.status,
		speakerCount: original.speakerCount,
	};
}

function mergedGrant(
	grants: readonly ArtifactShareGrant[],
	next: ArtifactShareGrant,
): ArtifactShareGrant[] {
	const out = grants.filter((grant) => grant.entityId !== next.entityId);
	out.push(next);
	return out;
}

function shareGrantsMetadata(
	grants: readonly ArtifactShareGrant[],
	roomSnapshot?: ArtifactRoomSnapshot,
): JsonObject {
	return {
		grants: grants.map((grant) => ({
			entityId: grant.entityId,
			mode: grant.mode,
			...(grant.grantedBy ? { grantedBy: grant.grantedBy } : {}),
			...(grant.grantedAtMs !== undefined
				? { grantedAtMs: grant.grantedAtMs }
				: {}),
		})),
		...(roomSnapshot
			? {
					roomSnapshot: {
						roomId: roomSnapshot.roomId,
						entityIds: [...roomSnapshot.entityIds],
						atMs: roomSnapshot.atMs,
					},
				}
			: {}),
	};
}

/** CRUD for transcript records over the runtime memory partition. */
export class TranscriptStore {
	constructor(private readonly runtime: TranscriptStoreRuntime) {}

	/** Persist a transcript record; returns it unchanged. */
	async create(input: CreateTranscriptInput): Promise<Transcript> {
		const { roomId, entityId, transcript } = input;
		const metadata: MemoryMetadata = {
			type: "custom",
			source: TRANSCRIPT_METADATA_TYPE,
			scope: transcript.scope,
			scopedToEntityId: entityId,
			timestamp: transcript.createdAt,
			transcriptId: transcript.id,
			durationMs: transcript.durationMs,
			speakerCount: transcript.speakerCount,
			status: transcript.status,
		};
		const memory: Memory = {
			id: transcript.id as UUID,
			entityId,
			roomId,
			agentId: this.runtime.agentId,
			createdAt: transcript.createdAt,
			content: {
				// A text body so generic memory consumers see something useful.
				text: transcriptPreview(transcript.segments),
				// The full record is JSON-serialized into the content blob — Content's
				// value type is strict JSON, so a typed interface isn't structurally
				// assignable; `rowToTranscript` parses it back.
				transcript: JSON.stringify(transcript),
			},
			metadata,
		};
		await this.runtime.createMemory(memory, TRANSCRIPTS_TABLE);
		return transcript;
	}

	/**
	 * List recent transcripts (newest first) as compact summaries, selected per
	 * viewer (#14781): full rows for privileged viewers, the redacted variant's
	 * preview (flagged, with only variant audio) for redacted-grant viewers, nothing for
	 * viewers with no disclosure. Variant rows themselves never list.
	 */
	async list(
		roomId?: UUID,
		limit = 100,
		accessContext?: AccessContext,
	): Promise<TranscriptSummary[]> {
		const rows = await this.runtime.getMemories({
			tableName: TRANSCRIPTS_TABLE,
			roomId,
			count: limit,
			orderBy: "createdAt",
			orderDirection: "desc",
		});
		const summaries: TranscriptSummary[] = [];
		for (const row of rows) {
			const t = rowToTranscript(row);
			if (!t || redactionOriginalId(row) !== null) continue;
			const disclosure = transcriptRowDisclosure(
				row,
				t,
				accessContext,
				this.runtime.agentId,
			);
			if (disclosure === "full") {
				summaries.push(summarizeTranscript(t));
			} else if (disclosure === "redacted") {
				const variant = await this.loadRedactedVariant(row);
				// A redacted grant with no readable variant discloses NOTHING —
				// omitting the row is the fail-closed branch, never the original.
				if (variant) {
					const served = serveRedactedVariant(variant, t);
					summaries.push({
						...summarizeTranscript(served),
						hasAudio: Boolean(served.audioUrl),
						redacted: true,
					});
				}
			}
		}
		return summaries;
	}

	/**
	 * Load one transcript by id, selected per viewer (#14781): the stored record
	 * for full disclosure, the redacted variant served under the ORIGINAL id
	 * (flagged, with only variant audio) for redacted-grant viewers, and `null` — which
	 * the route answers as 404, keeping denied ids non-enumerable — otherwise.
	 * Addressing a variant row directly discloses only to viewers whose
	 * disclosure on the linked original resolves `full`.
	 */
	async get(
		id: UUID,
		accessContext?: AccessContext,
	): Promise<Transcript | null> {
		const row = await this.runtime.getMemoryById(id);
		if (!row) return null;
		const transcript = rowToTranscript(row);
		if (!transcript) return null;

		const originalId = redactionOriginalId(row);
		if (originalId !== null) {
			const originalRow = await this.runtime.getMemoryById(originalId);
			const original = originalRow ? rowToTranscript(originalRow) : null;
			// A variant whose original is gone/corrupt is owner-tier storage only.
			const gate = originalRow && original ? originalRow : row;
			const gateTranscript = originalRow && original ? original : transcript;
			const disclosure = transcriptRowDisclosure(
				gate,
				gateTranscript,
				accessContext,
				this.runtime.agentId,
			);
			return disclosure === "full" ? transcript : null;
		}

		const disclosure = transcriptRowDisclosure(
			row,
			transcript,
			accessContext,
			this.runtime.agentId,
		);
		if (disclosure === "full") return transcript;
		if (disclosure === "redacted") {
			const variant = await this.loadRedactedVariant(row);
			return variant ? serveRedactedVariant(variant, transcript) : null;
		}
		return null;
	}

	/** Load + parse the redacted variant linked from an original's row. */
	private async loadRedactedVariant(row: Memory): Promise<Transcript | null> {
		const variantId = redactedVariantId(row);
		if (!variantId) return null;
		const variantRow = await this.runtime.getMemoryById(variantId);
		if (!variantRow) return null;
		return rowToTranscript(variantRow);
	}

	/**
	 * Create or refresh the deterministic redacted variant linked to an original.
	 * The original transcript and retained audio URL are never modified. A
	 * verified redacted audio URL may be stored on the variant; otherwise audio
	 * is withheld. Only the original row's metadata gains `redactedVariantId`.
	 */
	async createRedactedVariant(
		input: CreateRedactedTranscriptVariantInput,
	): Promise<Transcript> {
		const originalRow = await this.runtime.getMemoryById(input.originalId);
		if (!originalRow) {
			throw new Error(`transcript ${input.originalId} not found`);
		}
		const original = rowToTranscript(originalRow);
		if (!original) {
			throw new Error(`transcript ${input.originalId} is corrupt`);
		}
		const existingVariantId = redactedVariantId(originalRow);
		const variantId =
			existingVariantId ??
			(stringToUuid(
				`transcript-redaction:${input.originalId}:${input.seed ?? ""}`,
			) as UUID);
		const nowMs = input.nowMs ?? Date.now();
		const variant = {
			...(await redactTranscript(
				original,
				input.redactedAudioUrl,
				input.seed,
				input.recognizer,
			)),
			id: variantId,
			createdAt: nowMs,
			metadata: {
				redactionOf: input.originalId,
				redactedAtMs: nowMs,
				...(input.redactedBy ? { redactedBy: input.redactedBy } : {}),
			},
		};
		const existingVariant = await this.runtime.getMemoryById(variantId);
		if (existingVariant) {
			await this.update(variant);
		} else {
			await this.create({
				roomId: originalRow.roomId,
				entityId: originalRow.entityId,
				transcript: variant,
			});
		}
		const variantRow = await this.runtime.getMemoryById(variantId);
		const variantMeta = variantRow?.metadata as
			| Record<string, unknown>
			| undefined;
		const variantOk = await this.runtime.updateMemory({
			id: variantId,
			metadata: {
				...(variantMeta ?? {}),
				type: "custom",
				source: TRANSCRIPT_METADATA_TYPE,
				redactionOf: input.originalId,
				redactedAtMs: nowMs,
				...(input.redactedBy ? { redactedBy: input.redactedBy } : {}),
			} as MemoryMetadata,
		});
		if (!variantOk) {
			throw new Error(`redacted transcript variant ${variantId} not found`);
		}
		const meta = originalRow.metadata as Record<string, unknown> | undefined;
		const ok = await this.runtime.updateMemory({
			id: input.originalId,
			metadata: {
				...(meta ?? {}),
				type: "custom",
				source: TRANSCRIPT_METADATA_TYPE,
				redactedVariantId: variantId,
			} as MemoryMetadata,
		});
		if (!ok) {
			throw new Error(`transcript ${input.originalId} not found`);
		}
		return variant;
	}

	/** Add or replace one per-entity share grant on the original transcript row. */
	async share(input: ShareTranscriptGrantInput): Promise<void> {
		const row = await this.runtime.getMemoryById(input.transcriptId);
		if (!row) {
			throw new Error(`transcript ${input.transcriptId} not found`);
		}
		if (redactionOriginalId(row)) {
			throw new Error(
				"share grants must be attached to the original transcript",
			);
		}
		const transcript = rowToTranscript(row);
		if (!transcript) {
			throw new Error(`transcript ${input.transcriptId} is corrupt`);
		}
		assertTranscriptConsentAllowsSharing(transcript);
		const metadata = row.metadata as Record<string, unknown> | undefined;
		const share = parseArtifactShareMetadata(metadata);
		const nextGrant: ArtifactShareGrant = {
			entityId: input.entityId,
			mode: input.mode,
			...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
			...(input.grantedAtMs !== undefined
				? { grantedAtMs: input.grantedAtMs }
				: {}),
		};
		const ok = await this.runtime.updateMemory({
			id: input.transcriptId,
			metadata: {
				...(metadata ?? {}),
				type: "custom",
				source: TRANSCRIPT_METADATA_TYPE,
				share: shareGrantsMetadata(
					mergedGrant(share.grants, nextGrant),
					share.roomSnapshot,
				),
			} as MemoryMetadata,
		});
		if (!ok) {
			throw new Error(`transcript ${input.transcriptId} not found`);
		}
	}

	/**
	 * Snapshot the persisted room roster and materialize one grant per member.
	 * Later roster changes cannot widen access because disclosure reads only the
	 * captured entity ids and grants written here.
	 */
	async shareRoomSnapshot(
		input: ShareTranscriptRoomSnapshotInput,
	): Promise<void> {
		const row = await this.runtime.getMemoryById(input.transcriptId);
		if (!row) {
			throw new Error(`transcript ${input.transcriptId} not found`);
		}
		if (redactionOriginalId(row)) {
			throw new Error(
				"share grants must be attached to the original transcript",
			);
		}
		if (row.roomId !== input.roomId) {
			throw new ElizaError("room snapshot does not match transcript room", {
				code: "TRANSCRIPT_ROOM_MISMATCH",
				context: {
					transcriptId: input.transcriptId,
					transcriptRoomId: row.roomId,
					requestedRoomId: input.roomId,
				},
			});
		}
		const transcript = rowToTranscript(row);
		if (!transcript) {
			throw new Error(`transcript ${input.transcriptId} is corrupt`);
		}
		assertTranscriptConsentAllowsSharing(transcript);
		const entityIds = [...new Set(input.entityIds)];
		if (entityIds.length === 0) {
			throw new ElizaError("room snapshot has no resolved entities", {
				code: "TRANSCRIPT_ROOM_SNAPSHOT_EMPTY",
				context: { transcriptId: input.transcriptId, roomId: input.roomId },
			});
		}
		const grantedAtMs = input.grantedAtMs ?? Date.now();
		const metadata = row.metadata as Record<string, unknown> | undefined;
		let grants = parseArtifactShareMetadata(metadata).grants;
		for (const entityId of entityIds) {
			grants = mergedGrant(grants, {
				entityId,
				mode: input.mode,
				...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
				grantedAtMs,
			});
		}
		const roomSnapshot: ArtifactRoomSnapshot = {
			roomId: input.roomId,
			entityIds,
			atMs: grantedAtMs,
		};
		const ok = await this.runtime.updateMemory({
			id: input.transcriptId,
			metadata: {
				...(metadata ?? {}),
				type: "custom",
				source: TRANSCRIPT_METADATA_TYPE,
				share: shareGrantsMetadata(grants, roomSnapshot),
			} as MemoryMetadata,
		});
		if (!ok) {
			throw new Error(`transcript ${input.transcriptId} not found`);
		}
	}

	/** Remove one per-entity share grant from the original transcript row. */
	async revokeShare(input: RevokeTranscriptGrantInput): Promise<void> {
		const row = await this.runtime.getMemoryById(input.transcriptId);
		if (!row) {
			throw new Error(`transcript ${input.transcriptId} not found`);
		}
		if (redactionOriginalId(row)) {
			throw new Error(
				"share grants must be revoked from the original transcript",
			);
		}
		const metadata = row.metadata as Record<string, unknown> | undefined;
		const share = parseArtifactShareMetadata(metadata);
		const ok = await this.runtime.updateMemory({
			id: input.transcriptId,
			metadata: {
				...(metadata ?? {}),
				type: "custom",
				source: TRANSCRIPT_METADATA_TYPE,
				share: shareGrantsMetadata(
					share.grants.filter((grant) => grant.entityId !== input.entityId),
					share.roomSnapshot,
				),
			} as MemoryMetadata,
		});
		if (!ok) {
			throw new Error(`transcript ${input.transcriptId} not found`);
		}
	}

	/**
	 * Overwrite an existing transcript record in place (same id/row) — used when
	 * the user edits the transcript text. Re-derives the preview text body and
	 * the timing/speaker metadata from the updated record so generic memory
	 * consumers and the list stay consistent. Returns the record as stored.
	 */
	async update(transcript: Transcript): Promise<Transcript> {
		const existing = await this.runtime.getMemoryById(transcript.id as UUID);
		// Preserve the additive keys other writers own — share grants
		// (`share`) and redaction links (`redactedVariantId` / `redactionOf`,
		// #14781) — through a text edit. Narrowed at the jsonb boundary (not a
		// whole-metadata spread) so the discriminated `MemoryMetadata` union
		// keeps its `type: "custom"` shape and no `unknown` leaks in.
		const preserved = existing?.metadata as Record<string, unknown> | undefined;
		const carriedShare =
			preserved?.share && typeof preserved.share === "object"
				? (preserved.share as JsonObject)
				: undefined;
		const carriedVariantId =
			typeof preserved?.redactedVariantId === "string"
				? preserved.redactedVariantId
				: undefined;
		const carriedRedactionOf =
			typeof preserved?.redactionOf === "string"
				? preserved.redactionOf
				: undefined;
		const ok = await this.runtime.updateMemory({
			id: transcript.id as UUID,
			content: {
				text: transcriptPreview(transcript.segments),
				transcript: JSON.stringify(transcript),
			},
			metadata: {
				type: "custom",
				source: TRANSCRIPT_METADATA_TYPE,
				scope: transcript.scope,
				scopedToEntityId: existing?.entityId,
				timestamp: transcript.createdAt,
				transcriptId: transcript.id,
				durationMs: transcript.durationMs,
				speakerCount: transcript.speakerCount,
				status: transcript.status,
				...(carriedShare !== undefined ? { share: carriedShare } : {}),
				...(carriedVariantId !== undefined
					? { redactedVariantId: carriedVariantId }
					: {}),
				...(carriedRedactionOf !== undefined
					? { redactionOf: carriedRedactionOf }
					: {}),
			},
		});
		if (!ok) {
			throw new Error(`transcript ${transcript.id} not found`);
		}
		return transcript;
	}

	/** Delete a transcript record (the knowledge mirror is removed separately). */
	async delete(id: UUID): Promise<void> {
		await this.runtime.deleteMemory(id);
	}
}
