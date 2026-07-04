/**
 * XR protocol tests verify binary frame encoding for audio, images, and pose
 * metadata exchanged with headset clients.
 */
import { describe, expect, it } from "vitest";
import { decodeBinaryFrame, encodeBinaryFrame } from "../protocol/xr.ts";

describe("binary frame codec", () => {
	it("round-trips an audio frame", () => {
		const header = {
			type: "audio" as const,
			ts: 1234567890,
			sampleRate: 48000,
			encoding: "webm-opus" as const,
		};
		const payload = Buffer.from([1, 2, 3, 4, 5]);
		const frame = encodeBinaryFrame(header, payload);
		const decoded = decodeBinaryFrame(frame);

		expect(decoded.header).toEqual(header);
		expect(decoded.payload).toEqual(payload);
	});

	it("round-trips a frame with pose data", () => {
		const header = {
			type: "frame" as const,
			ts: 999,
			width: 1280,
			height: 720,
			format: "jpeg" as const,
			pose: {
				position: { x: 1, y: 2, z: 3 },
				orientation: { x: 0, y: 0, z: 0, w: 1 },
			},
		};
		const payload = Buffer.alloc(100, 0xab);
		const { header: h, payload: p } = decodeBinaryFrame(
			encodeBinaryFrame(header, payload),
		);
		expect(h).toEqual(header);
		expect(p).toEqual(payload);
	});

	it("handles zero-length payload", () => {
		const header = {
			type: "tts_audio" as const,
			sampleRate: 24000,
			channels: 1,
			encoding: "mp3" as const,
		};
		const { header: h, payload } = decodeBinaryFrame(
			encodeBinaryFrame(header, Buffer.alloc(0)),
		);
		expect(h).toEqual(header);
		expect(payload.length).toBe(0);
	});
});
