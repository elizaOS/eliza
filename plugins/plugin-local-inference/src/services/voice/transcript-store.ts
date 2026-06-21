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

import type { Memory, MemoryMetadata, UUID } from "@elizaos/core";
import type {
	Transcript,
	TranscriptSummary,
} from "@elizaos/shared/transcripts";
import {
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

/** CRUD for transcript records over the runtime memory partition. */
export class TranscriptStore {
	constructor(private readonly runtime: TranscriptStoreRuntime) {}

	/** Persist a transcript record; returns it unchanged. */
	async create(input: CreateTranscriptInput): Promise<Transcript> {
		const { roomId, entityId, transcript } = input;
		const metadata: MemoryMetadata = {
			type: "custom",
			source: TRANSCRIPT_METADATA_TYPE,
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
	async list(roomId?: UUID, limit = 100): Promise<TranscriptSummary[]> {
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
			if (t) summaries.push(summarizeTranscript(t));
		}
		return summaries;
	}

	/** Load one full transcript record by id. */
	async get(id: UUID): Promise<Transcript | null> {
		const row = await this.runtime.getMemoryById(id);
		return row ? rowToTranscript(row) : null;
	}

	/** Delete a transcript record (the knowledge mirror is removed separately). */
	async delete(id: UUID): Promise<void> {
		await this.runtime.deleteMemory(id);
	}
}
