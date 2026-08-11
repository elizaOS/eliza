/**
 * Owns transcript artifact-visibility changes and source-audio deletion.
 * HTTP routes and semantic actions delegate here so retention transitions,
 * grant requirements, and content-addressed byte deletion stay identical.
 */

import {
	ElizaError,
	type IFileStorageService,
	ServiceType,
	type UUID,
} from "@elizaos/core";
import type {
	Transcript,
	TranscriptCaptureSharingState,
} from "@elizaos/shared/transcripts";
import { transcriptCapturePrivacyState } from "@elizaos/shared/transcripts";
import type { TranscriptServiceRuntime } from "./transcript-service.js";
import { TranscriptStore } from "./transcript-store.js";

const STORED_AUDIO_URL = /^\/api\/media\/([a-f0-9]{64}\.[a-z0-9]+)$/i;

function sourceAudioFileName(transcript: Transcript): string | null {
	const direct = transcript.audioUrl?.match(STORED_AUDIO_URL)?.[1];
	if (direct) return direct;
	const retention = transcript.metadata?.retention;
	if (!retention || typeof retention !== "object") return null;
	const pending = (retention as { sourceAudioFileName?: unknown })
		.sourceAudioFileName;
	return typeof pending === "string" &&
		STORED_AUDIO_URL.test(`/api/media/${pending}`)
		? pending
		: null;
}

export class TranscriptPrivacyService {
	private readonly store: TranscriptStore;

	constructor(private readonly runtime: TranscriptServiceRuntime) {
		this.store = new TranscriptStore(runtime);
	}

	/** Persist per-artifact visibility, requiring real grants for wider transcript access. */
	async updateArtifactSharing(
		transcriptId: UUID,
		sharing: Partial<TranscriptCaptureSharingState>,
	): Promise<Transcript> {
		const row = await this.runtime.getMemoryById(transcriptId);
		if (!row) {
			throw new ElizaError(`transcript ${transcriptId} not found`, {
				code: "TRANSCRIPT_NOT_FOUND",
			});
		}
		const transcriptState = sharing.transcript;
		if (transcriptState === "owner_private" || transcriptState === "disabled") {
			await this.store.clearShares(transcriptId);
		} else if (
			transcriptState === "restricted" ||
			transcriptState === "shared"
		) {
			const grants = (
				(row.metadata as Record<string, unknown> | undefined)?.share as
					| { grants?: Array<{ mode?: unknown }> }
					| undefined
			)?.grants;
			const requiredMode =
				transcriptState === "restricted" ? "redacted" : "full";
			if (!grants?.some((grant) => grant.mode === requiredMode)) {
				throw new ElizaError(
					`${transcriptState} visibility requires an existing ${requiredMode} grant`,
					{
						code: "TRANSCRIPT_GRANT_REQUIRED",
						context: { transcriptId, transcriptState, requiredMode },
					},
				);
			}
		}
		return this.store.updateArtifactSharing({ transcriptId, sharing });
	}

	/** Delete source bytes after durably withholding the transcript capability. */
	async deleteSourceAudio(transcriptId: UUID): Promise<Transcript> {
		const transcript = await this.store.get(transcriptId);
		if (!transcript) {
			throw new ElizaError(`transcript ${transcriptId} not found`, {
				code: "TRANSCRIPT_NOT_FOUND",
			});
		}
		const fileName = sourceAudioFileName(transcript);
		if (!fileName) {
			if (transcriptCapturePrivacyState(transcript).sourceAudioDeleted) {
				return transcript;
			}
			throw new ElizaError(
				"source audio is not a content-addressed media handle",
				{ code: "TRANSCRIPT_SOURCE_AUDIO_NOT_STORED" },
			);
		}
		const storage = this.runtime.getService<IFileStorageService>(
			ServiceType.REMOTE_FILES,
		);
		if (!storage) {
			throw new ElizaError("file storage unavailable", {
				code: "TRANSCRIPT_FILE_STORAGE_UNAVAILABLE",
			});
		}
		await this.store.markSourceAudioDeletePending({ transcriptId, fileName });
		const deleted = await storage.delete(fileName);
		if (!deleted && (await storage.exists(fileName))) {
			throw new ElizaError(`source audio ${fileName} could not be deleted`, {
				code: "TRANSCRIPT_SOURCE_AUDIO_DELETE_FAILED",
				context: { transcriptId, fileName },
			});
		}
		return this.store.markSourceAudioDeleted(transcriptId);
	}
}
