/**
 * Covers `deliverFirstSentenceVoice` (services/message) — the streaming
 * first-sentence cloud-TTS delivery. An envelope echo's first sentence IS the
 * security notice, and this path bypasses the text-only outbound guard
 * (callback text is "", the armor rides in attachment.text + audio), so it
 * must refuse to synthesize or attach envelope material. Mock runtime with
 * reportError/useModel spies.
 */
import { describe, expect, it, vi } from "vitest";
import { wrapExternalContent } from "../../security/external-content";
import type { HandlerCallback, IAgentRuntime } from "../../types";
import { ContentType } from "../../types/primitives";
import { deliverFirstSentenceVoice } from "../message";

// The sentence a model echoing the envelope streams first — exactly what
// extractFirstSentence hands this path in the leak scenario.
const ENVELOPE_FIRST_SENTENCE =
	"SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source (e.g., email, webhook).";

function makeRuntime(overrides: Record<string, unknown> = {}) {
	return {
		character: {
			name: "Example",
			settings: { voice: { model: "en_US-test", voiceId: "test-voice" } },
		},
		getModel: vi.fn(() => async () => Buffer.from("fake-audio")),
		useModel: vi.fn(async () => Buffer.from("fake-audio")),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		reportError: vi.fn(),
		...overrides,
	} as unknown as Pick<
		IAgentRuntime,
		"character" | "getModel" | "useModel" | "logger" | "reportError"
	> & {
		useModel: ReturnType<typeof vi.fn>;
		reportError: ReturnType<typeof vi.fn>;
	};
}

describe("deliverFirstSentenceVoice envelope gate", () => {
	it("refuses to synthesize or deliver an envelope-shaped first sentence and reports it", async () => {
		const runtime = makeRuntime();
		const callback: HandlerCallback = vi.fn(async () => []);

		await deliverFirstSentenceVoice(runtime, ENVELOPE_FIRST_SENTENCE, callback);

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
		expect(runtime.reportError).toHaveBeenCalledWith(
			"outbound-envelope-guard",
			expect.any(Error),
			expect.objectContaining({ seam: "stream-tts" }),
		);
	});

	it("also blocks a full wrapped envelope handed as the first sentence", async () => {
		const runtime = makeRuntime();
		const callback: HandlerCallback = vi.fn(async () => []);
		const leaked = wrapExternalContent("payload", {
			source: "api",
			includeWarning: true,
		});

		await deliverFirstSentenceVoice(runtime, leaked, callback);

		expect(callback).not.toHaveBeenCalled();
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
	});

	it("synthesizes and delivers a clean first sentence as an audio attachment", async () => {
		const runtime = makeRuntime();
		const callback: HandlerCallback = vi.fn(async () => []);

		await deliverFirstSentenceVoice(runtime, "Your site is live!", callback);

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(runtime.useModel.mock.calls[0][1]).toEqual(
			expect.objectContaining({ text: "Your site is live!" }),
		);
		expect(callback).toHaveBeenCalledTimes(1);
		const delivered = (callback as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(delivered.text).toBe("");
		expect(delivered.source).toBe("voice");
		expect(delivered.attachments).toHaveLength(1);
		expect(delivered.attachments[0]).toEqual(
			expect.objectContaining({
				contentType: ContentType.AUDIO,
				text: "Your site is live!",
			}),
		);
		expect(delivered.attachments[0].url).toMatch(/^data:audio\/wav;base64,/);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("delivers nothing when no TTS model is registered, without reporting", async () => {
		const runtime = makeRuntime({ getModel: vi.fn(() => undefined) });
		const callback: HandlerCallback = vi.fn(async () => []);

		await deliverFirstSentenceVoice(runtime, "Your site is live!", callback);

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
		expect(runtime.reportError).not.toHaveBeenCalled();
	});
});
