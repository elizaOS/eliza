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
	actorFromAccessContext,
	canReadScope,
	type Memory,
	type MemoryMetadata,
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

export function canAccessTranscriptRecord(
	transcript: Pick<Transcript, "scope">,
	scopedEntityId: UUID | undefined,
	accessContext: AccessContext | undefined,
	agentId: UUID,
): boolean {
	if (!accessContext) return true;
	if (accessContext.requesterEntityId === agentId) return true;
	const actor = actorFromAccessContext(accessContext, agentId);
	if (actor.role === "OWNER") return true;
	return canReadScope(
		normalizeTranscriptScope(transcript.scope),
		scopedEntityId,
		actor,
	);
}

function canAccessTranscriptRow(
	row: Memory,
	transcript: Pick<Transcript, "scope">,
	accessContext: AccessContext | undefined,
	agentId: UUID,
): boolean {
	const metadata = row.metadata as Record<string, unknown> | undefined;
	const scopedTo = metadata?.scopedToEntityId;
	const scopedEntityId =
		typeof scopedTo === "string" ? (scopedTo as UUID) : row.entityId;
	return canAccessTranscriptRecord(
		transcript,
		scopedEntityId,
		accessContext,
		agentId,
	);
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

	/** List recent transcripts (newest first) as compact summaries. */
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
			if (
				t &&
				canAccessTranscriptRow(row, t, accessContext, this.runtime.agentId)
			) {
				summaries.push(summarizeTranscript(t));
			}
		}
		return summaries;
	}

	/** Load one full transcript record by id. */
	async get(
		id: UUID,
		accessContext?: AccessContext,
	): Promise<Transcript | null> {
		const row = await this.runtime.getMemoryById(id);
		if (!row) return null;
		const transcript = rowToTranscript(row);
		if (!transcript) return null;
		return canAccessTranscriptRow(
			row,
			transcript,
			accessContext,
			this.runtime.agentId,
		)
			? transcript
			: null;
	}

	/**
	 * Overwrite an existing transcript record in place (same id/row) — used when
	 * the user edits the transcript text. Re-derives the preview text body and
	 * the timing/speaker metadata from the updated record so generic memory
	 * consumers and the list stay consistent. Returns the record as stored.
	 */
	async update(transcript: Transcript): Promise<Transcript> {
		const existing = await this.runtime.getMemoryById(transcript.id as UUID);
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
