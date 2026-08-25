import { beforeEach, describe, expect, it, vi } from "vitest";

const privacyStateMock = vi.hoisted(() => vi.fn());

const storeMock = vi.hoisted(() => ({
	get: vi.fn(),
	updateArtifactSharing: vi.fn(),
	clearShares: vi.fn(),
	markSourceAudioDeletePending: vi.fn(),
	markSourceAudioDeleted: vi.fn(),
}));

vi.mock("@elizaos/shared/transcripts", () => ({
	transcriptCapturePrivacyState: privacyStateMock,
}));

vi.mock("./transcript-store.js", () => ({
	TranscriptStore: vi.fn().mockImplementation(() => ({
		get: storeMock.get,
		updateArtifactSharing: storeMock.updateArtifactSharing,
		clearShares: storeMock.clearShares,
		markSourceAudioDeletePending: storeMock.markSourceAudioDeletePending,
		markSourceAudioDeleted: storeMock.markSourceAudioDeleted,
	})),
}));

import { TranscriptPrivacyService } from "./transcript-privacy";

const HEX64 = "a".repeat(64);

function makeRuntime(overrides: Record<string, unknown> = {}) {
	return {
		getMemoryById: vi.fn(async () => null),
		getService: vi.fn(() => null),
		...overrides,
	};
}

function makeStorage(overrides: Record<string, unknown> = {}) {
	return {
		delete: vi.fn(async () => true),
		exists: vi.fn(async () => false),
		...overrides,
	};
}

function makeTranscript(overrides: Record<string, unknown> = {}) {
	return {
		id: "t-1",
		audioUrl: `/api/media/${HEX64}.mp3`,
		metadata: {},
		...overrides,
	};
}

describe("TranscriptPrivacyService", () => {
	let service: TranscriptPrivacyService;
	let runtime: ReturnType<typeof makeRuntime>;

	beforeEach(() => {
		privacyStateMock.mockReset();
		privacyStateMock.mockReturnValue({ sourceAudioDeleted: false });
		for (const fn of Object.values(storeMock)) {
			fn.mockReset();
			fn.mockResolvedValue(undefined);
		}
		storeMock.get.mockResolvedValue(null);
		runtime = makeRuntime();
		service = new TranscriptPrivacyService(runtime as never);
	});

	describe("updateArtifactSharing", () => {
		it("fails closed when the transcript row is missing", async () => {
			runtime.getMemoryById.mockResolvedValue(null);
			await expect(
				service.updateArtifactSharing("t-1", { transcript: "shared" }),
			).rejects.toMatchObject({ code: "TRANSCRIPT_NOT_FOUND" });
			expect(storeMock.clearShares).not.toHaveBeenCalled();
		});

		it("clears every share when the owner pulls visibility back to owner_private", async () => {
			runtime.getMemoryById.mockResolvedValue({ metadata: {} });
			await service.updateArtifactSharing("t-1", {
				transcript: "owner_private",
			});
			expect(storeMock.clearShares).toHaveBeenCalledWith("t-1");
			expect(storeMock.updateArtifactSharing).toHaveBeenCalledWith({
				transcriptId: "t-1",
				sharing: { transcript: "owner_private" },
			});
		});

		it("clears every share when transcript capture is disabled", async () => {
			runtime.getMemoryById.mockResolvedValue({ metadata: {} });
			await service.updateArtifactSharing("t-1", { transcript: "disabled" });
			expect(storeMock.clearShares).toHaveBeenCalledWith("t-1");
		});

		it("requires an existing redacted grant for restricted visibility", async () => {
			runtime.getMemoryById.mockResolvedValue({
				metadata: { share: { grants: [{ mode: "full" }] } },
			});
			const err = await service
				.updateArtifactSharing("t-1", { transcript: "restricted" })
				.catch((e: { code?: string; context?: unknown }) => e);
			expect(err.code).toBe("TRANSCRIPT_GRANT_REQUIRED");
			expect(err.context).toMatchObject({
				transcriptId: "t-1",
				transcriptState: "restricted",
				requiredMode: "redacted",
			});
			expect(storeMock.clearShares).not.toHaveBeenCalled();
			expect(storeMock.updateArtifactSharing).not.toHaveBeenCalled();
		});

		it("grants restricted visibility when a redacted grant exists", async () => {
			runtime.getMemoryById.mockResolvedValue({
				metadata: { share: { grants: [{ mode: "redacted" }] } },
			});
			await service.updateArtifactSharing("t-1", { transcript: "restricted" });
			expect(storeMock.updateArtifactSharing).toHaveBeenCalledWith({
				transcriptId: "t-1",
				sharing: { transcript: "restricted" },
			});
		});

		it("requires an existing full grant for shared visibility", async () => {
			runtime.getMemoryById.mockResolvedValue({
				metadata: { share: { grants: [{ mode: "redacted" }] } },
			});
			const err = await service
				.updateArtifactSharing("t-1", { transcript: "shared" })
				.catch((e: { code?: string; context?: unknown }) => e);
			expect(err.code).toBe("TRANSCRIPT_GRANT_REQUIRED");
			expect(err.context).toMatchObject({ requiredMode: "full" });
		});

		it("fails closed when the share block carries no grants at all", async () => {
			runtime.getMemoryById.mockResolvedValue({
				metadata: { share: { grants: [] } },
			});
			await expect(
				service.updateArtifactSharing("t-1", { transcript: "shared" }),
			).rejects.toMatchObject({ code: "TRANSCRIPT_GRANT_REQUIRED" });
		});

		it("leaves unrelated sharing fields untouched", async () => {
			runtime.getMemoryById.mockResolvedValue({ metadata: {} });
			await service.updateArtifactSharing("t-1", { notes: "owner_private" });
			expect(storeMock.clearShares).not.toHaveBeenCalled();
			expect(storeMock.updateArtifactSharing).toHaveBeenCalledWith({
				transcriptId: "t-1",
				sharing: { notes: "owner_private" },
			});
		});
	});

	describe("deleteSourceAudio", () => {
		it("fails closed when the transcript is missing", async () => {
			storeMock.get.mockResolvedValue(null);
			await expect(service.deleteSourceAudio("t-1")).rejects.toMatchObject({
				code: "TRANSCRIPT_NOT_FOUND",
			});
		});

		it("deletes only content-addressed audio and marks the deletion", async () => {
			const storage = makeStorage();
			runtime.getService.mockReturnValue(storage);
			storeMock.get.mockResolvedValue(makeTranscript());
			await service.deleteSourceAudio("t-1");
			expect(storeMock.markSourceAudioDeletePending).toHaveBeenCalledWith({
				transcriptId: "t-1",
				fileName: `${HEX64}.mp3`,
			});
			expect(storage.delete).toHaveBeenCalledWith(`${HEX64}.mp3`);
			expect(storeMock.markSourceAudioDeleted).toHaveBeenCalledWith("t-1");
		});

		it("rejects audio URLs that are not content-addressed handles", async () => {
			storeMock.get.mockResolvedValue(
				makeTranscript({ audioUrl: "/api/media/not-a-64-hex.mp3" }),
			);
			await expect(service.deleteSourceAudio("t-1")).rejects.toMatchObject({
				code: "TRANSCRIPT_SOURCE_AUDIO_NOT_STORED",
			});
		});

		it("resolves the pending file name from retention metadata when valid", async () => {
			const storage = makeStorage();
			runtime.getService.mockReturnValue(storage);
			storeMock.get.mockResolvedValue(
				makeTranscript({
					audioUrl: null,
					metadata: {
						retention: { sourceAudioFileName: `${HEX64}.wav` },
					},
				}),
			);
			await service.deleteSourceAudio("t-1");
			expect(storage.delete).toHaveBeenCalledWith(`${HEX64}.wav`);
			expect(storeMock.markSourceAudioDeleted).toHaveBeenCalledWith("t-1");
		});

		it("rejects traversal-shaped retention file names via the handle guard", async () => {
			storeMock.get.mockResolvedValue(
				makeTranscript({
					audioUrl: null,
					metadata: {
						retention: { sourceAudioFileName: "../evil.mp3" },
					},
				}),
			);
			await expect(service.deleteSourceAudio("t-1")).rejects.toMatchObject({
				code: "TRANSCRIPT_SOURCE_AUDIO_NOT_STORED",
			});
			expect(storeMock.markSourceAudioDeletePending).not.toHaveBeenCalled();
		});

		it("is idempotent when the source audio is already reported deleted", async () => {
			privacyStateMock.mockReturnValue({ sourceAudioDeleted: true });
			storeMock.get.mockResolvedValue(
				makeTranscript({ audioUrl: "/api/media/nope.mp3" }),
			);
			await expect(service.deleteSourceAudio("t-1")).resolves.toEqual(
				makeTranscript({ audioUrl: "/api/media/nope.mp3" }),
			);
			expect(storeMock.markSourceAudioDeletePending).not.toHaveBeenCalled();
		});

		it("fails closed when the file storage service is unavailable", async () => {
			storeMock.get.mockResolvedValue(makeTranscript());
			runtime.getService.mockReturnValue(null);
			await expect(service.deleteSourceAudio("t-1")).rejects.toMatchObject({
				code: "TRANSCRIPT_FILE_STORAGE_UNAVAILABLE",
			});
		});

		it("surfaces a failed deletion instead of pretending the bytes are gone", async () => {
			const storage = makeStorage({
				delete: vi.fn(async () => false),
				exists: vi.fn(async () => true),
			});
			runtime.getService.mockReturnValue(storage);
			storeMock.get.mockResolvedValue(makeTranscript());
			const err = await service
				.deleteSourceAudio("t-1")
				.catch((e: { code?: string; context?: unknown }) => e);
			expect(err.code).toBe("TRANSCRIPT_SOURCE_AUDIO_DELETE_FAILED");
			expect(err.context).toMatchObject({
				transcriptId: "t-1",
				fileName: `${HEX64}.mp3`,
			});
			expect(storeMock.markSourceAudioDeleted).not.toHaveBeenCalled();
		});

		it("durably marks the deletion pending before touching the bytes", async () => {
			const storage = makeStorage();
			runtime.getService.mockReturnValue(storage);
			storeMock.get.mockResolvedValue(makeTranscript());
			await service.deleteSourceAudio("t-1");
			const pendingOrder =
				storeMock.markSourceAudioDeletePending.mock.invocationCallOrder[0];
			const deleteOrder = storage.delete.mock.invocationCallOrder[0];
			const deletedOrder =
				storeMock.markSourceAudioDeleted.mock.invocationCallOrder[0];
			expect(pendingOrder).toBeLessThan(deleteOrder);
			expect(deleteOrder).toBeLessThan(deletedOrder);
		});
	});
});
