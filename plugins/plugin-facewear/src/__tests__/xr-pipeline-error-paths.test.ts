/**
 * Failure-path tests for the XR vision + audio pipelines: a model failure must
 * surface observably (propagate / reportError) instead of being swallowed into a
 * misleading "no frame" / silent no-op.
 */
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AudioPipeline } from "../services/audio-pipeline.ts";
import { VisionPipeline } from "../services/vision-pipeline.ts";

describe("VisionPipeline.describeFrame failure path", () => {
	it("propagates a model failure instead of returning null", async () => {
		const pipeline = new VisionPipeline();
		pipeline.storeFrame(
			"conn-1",
			{ type: "frame", ts: Date.now(), width: 4, height: 4, format: "jpeg" },
			Buffer.from([1, 2, 3, 4]),
		);

		const modelError = new Error("vision model unavailable");
		const runtime = {
			useModel: vi.fn().mockRejectedValue(modelError),
		};

		await expect(
			pipeline.describeFrame(runtime as never, "conn-1"),
		).rejects.toBe(modelError);
		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.IMAGE_DESCRIPTION,
			expect.anything(),
		);
	});

	it("still returns null when there is no fresh frame (genuine empty)", async () => {
		const pipeline = new VisionPipeline();
		const runtime = { useModel: vi.fn() };
		await expect(
			pipeline.describeFrame(runtime as never, "missing"),
		).resolves.toBeNull();
		expect(runtime.useModel).not.toHaveBeenCalled();
	});
});

describe("AudioPipeline.flush failure path", () => {
	it("reports a transcription failure via runtime.reportError", async () => {
		const reportError = vi.fn();
		const onTranscript = vi.fn().mockResolvedValue(undefined);
		const runtime = {
			useModel: vi.fn().mockRejectedValue(new Error("transcription down")),
			reportError,
		};

		const pipeline = new AudioPipeline(runtime as never, onTranscript);
		pipeline.push(
			"conn-1",
			{
				type: "audio",
				ts: Date.now(),
				sampleRate: 16000,
				encoding: "webm-opus",
			},
			Buffer.alloc(1024),
		);

		await pipeline.flush("conn-1");

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.TRANSCRIPTION,
			expect.any(Buffer),
		);
		expect(reportError).toHaveBeenCalledWith(
			"AudioPipeline.flush",
			expect.any(Error),
			{ connectionId: "conn-1" },
		);
		expect(onTranscript).not.toHaveBeenCalled();
	});
});
