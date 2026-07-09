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
	type ArtifactShareGrant,
	type ArtifactShareGrantMode,
	detectPii,
	type JsonObject,
	type Memory,
	type MemoryMetadata,
	parseArtifactShareGrants,
	resolveArtifactDisclosure,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type {
	Transcript,
	TranscriptSummary,
} from "@elizaos/shared/transcripts";
import {
	normalizeTranscriptScope,
	summarizeTranscript,
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
}

export interface ShareTranscriptGrantInput {
	transcriptId: UUID;
	entityId: UUID;
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
			grants: parseArtifactShareGrants(metadata),
		},
		accessContext,
		agentId,
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
 * with per-viewer content. Audio is always withheld (never redacted in v1),
 * and every content field (title, segments, knowledge mirror id, metadata)
 * comes from the variant so nothing of the original can leak through.
 */
function serveRedactedVariant(
	variant: Transcript,
	original: Pick<Transcript, "id" | "createdAt" | "endedAt" | "source">,
): Transcript {
	const {
		audioUrl: _audioUrl,
		audioContentType: _audioContentType,
		...variantFields
	} = variant;
	return {
		...variantFields,
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

function redactTranscript(original: Transcript): Transcript {
	const segments = original.segments.map((segment) => ({
		...segment,
		text: redactedText(segment.text),
		words: segment.words.map((word) => ({
			...word,
			text: redactedText(word.text),
		})),
	}));
	return {
		...original,
		title: `${original.title} (redacted)`,
		audioUrl: undefined,
		audioContentType: undefined,
		segments,
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
	 * preview (flagged, audio withheld) for redacted-grant viewers, nothing for
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
					summaries.push({
						...summarizeTranscript(serveRedactedVariant(variant, t)),
						hasAudio: false,
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
	 * (flagged, audio withheld) for redacted-grant viewers, and `null` — which
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
	 * The original transcript and retained audio URL are never modified; only the
	 * original row's metadata gains/updates `redactedVariantId`.
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
			...redactTranscript(original),
			id: variantId,
			createdAt: nowMs,
			metadata: {
				...(original.metadata ?? {}),
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
		const metadata = row.metadata as Record<string, unknown> | undefined;
		const grants = parseArtifactShareGrants(metadata);
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
				share: {
					grants: mergedGrant(grants, nextGrant),
				} as unknown as JsonObject,
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
