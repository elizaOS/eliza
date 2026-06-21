/**
 * TranscriptService (#8789) — orchestrates a finished recording into both homes:
 * the rich {@link TranscriptStore} record (source of truth: audio + word-timed
 * diarized segments) AND a searchable knowledge/documents mirror, linked by
 * `knowledgeDocumentId`. Create mirrors first (best-effort — a search-index
 * failure must not lose the recording), then persists the record carrying the
 * link. Delete removes the mirror too.
 */

import { logger, type UUID } from "@elizaos/core";
import type {
	Transcript,
	TranscriptScope,
	TranscriptSummary,
} from "@elizaos/shared/transcripts";
import { transcriptKnowledgePayload } from "./transcript-knowledge";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "./transcript-store";

/** The documents/knowledge service surface the mirror needs (structural). */
interface DocumentsLike {
	addDocument(options: {
		worldId: UUID;
		roomId: UUID;
		entityId: UUID;
		clientDocumentId: UUID;
		contentType: string;
		originalFilename: string;
		content: string;
		scope?: TranscriptScope;
		addedFrom?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ storedDocumentMemoryId: UUID }>;
}

/** Store runtime + service resolution (the real IAgentRuntime satisfies it). */
export interface TranscriptServiceRuntime extends TranscriptStoreRuntime {
	getService<T>(name: string): T | null;
}

export interface CreateTranscriptInput {
	worldId: UUID;
	roomId: UUID;
	/** The owner/speaker entity the recording is attributed to. */
	entityId: UUID;
	transcript: Transcript;
}

export class TranscriptService {
	private readonly store: TranscriptStore;

	constructor(private readonly runtime: TranscriptServiceRuntime) {
		this.store = new TranscriptStore(runtime);
	}

	/** Mirror the transcript text into knowledge, then persist the record. */
	async create(input: CreateTranscriptInput): Promise<Transcript> {
		const { worldId, roomId, entityId, transcript } = input;
		const knowledgeDocumentId = await this.mirrorToKnowledge(
			worldId,
			roomId,
			entityId,
			transcript,
		);
		const record = knowledgeDocumentId
			? { ...transcript, knowledgeDocumentId }
			: transcript;
		return this.store.create({ roomId, entityId, transcript: record });
	}

	list(roomId?: UUID, limit?: number): Promise<TranscriptSummary[]> {
		return this.store.list(roomId, limit);
	}

	get(id: UUID): Promise<Transcript | null> {
		return this.store.get(id);
	}

	/** Delete the record + its knowledge mirror (mirror removal best-effort). */
	async delete(id: UUID): Promise<void> {
		const existing = await this.store.get(id);
		if (existing?.knowledgeDocumentId) {
			try {
				await this.runtime.deleteMemory(existing.knowledgeDocumentId as UUID);
			} catch (err) {
				logger.warn(
					{
						transcriptId: id,
						knowledgeDocumentId: existing.knowledgeDocumentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"[TranscriptService] failed to remove knowledge mirror",
				);
			}
		}
		await this.store.delete(id);
	}

	/**
	 * Best-effort mirror into the documents store. Returns the stored document id
	 * to link, or undefined when no documents service is loaded or the mirror
	 * fails — the recording still persists either way (the link is a secondary
	 * search index, never the source of truth).
	 */
	private async mirrorToKnowledge(
		worldId: UUID,
		roomId: UUID,
		entityId: UUID,
		transcript: Transcript,
	): Promise<string | undefined> {
		const documents = this.runtime.getService<DocumentsLike>("documents");
		if (!documents) return undefined;
		try {
			const payload = transcriptKnowledgePayload(transcript);
			const res = await documents.addDocument({
				worldId,
				roomId,
				entityId,
				clientDocumentId: transcript.id as UUID,
				contentType: payload.contentType,
				originalFilename: payload.filename,
				content: payload.content,
				scope: payload.scope,
				addedFrom: "runtime-internal",
				metadata: payload.metadata,
			});
			return res.storedDocumentMemoryId;
		} catch (err) {
			logger.warn(
				{
					transcriptId: transcript.id,
					error: err instanceof Error ? err.message : String(err),
				},
				"[TranscriptService] knowledge mirror failed",
			);
			return undefined;
		}
	}
}
