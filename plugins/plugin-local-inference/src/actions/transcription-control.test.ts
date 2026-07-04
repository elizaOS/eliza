/**
 * Unit tests for the START/STOP_TRANSCRIPTION actions and `emitVoiceControl`.
 * A fake runtime with a stubbed agent-event bus stands in for the real service;
 * asserts the one-way voice-control command is emitted, and reported as
 * undeliverable when no bus is connected.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	emitVoiceControl,
	startTranscriptionAction,
	stopTranscriptionAction,
	VOICE_CONTROL_STREAM,
	type VoiceControlEvent,
} from "./transcription-control";

function fakeRuntime(opts: { withBus: boolean }): {
	runtime: IAgentRuntime;
	emit: ReturnType<typeof vi.fn>;
} {
	const emit = vi.fn();
	const bus = { emit };
	const runtime = {
		agentId: "agent-1",
		getService: (name: string) =>
			name === "agent_event" && opts.withBus ? bus : null,
	} as unknown as IAgentRuntime;
	return { runtime, emit };
}

describe("emitVoiceControl", () => {
	it("emits a voice-control command on the agent-event bus", () => {
		const { runtime, emit } = fakeRuntime({ withBus: true });
		expect(emitVoiceControl(runtime, "start")).toBe(true);
		expect(emit).toHaveBeenCalledTimes(1);
		const event = emit.mock.calls[0][0];
		expect(event.stream).toBe(VOICE_CONTROL_STREAM);
		expect(event.agentId).toBe("agent-1");
		expect(event.data as VoiceControlEvent).toEqual({
			type: "voice-control",
			command: "start",
		});
		expect(typeof event.runId).toBe("string");
	});

	it("returns false when no event bus is available", () => {
		const { runtime, emit } = fakeRuntime({ withBus: false });
		expect(emitVoiceControl(runtime, "stop")).toBe(false);
		expect(emit).not.toHaveBeenCalled();
	});
});

describe("START_/STOP_TRANSCRIPTION actions", () => {
	it("validate only when the event bus is present", async () => {
		const withBus = fakeRuntime({ withBus: true });
		const without = fakeRuntime({ withBus: false });
		expect(
			await startTranscriptionAction.validate(withBus.runtime, {} as Memory),
		).toBe(true);
		expect(
			await stopTranscriptionAction.validate(without.runtime, {} as Memory),
		).toBe(false);
	});

	it("START emits 'start' and confirms via the callback", async () => {
		const { runtime, emit } = fakeRuntime({ withBus: true });
		const callback = vi.fn();
		const result = await startTranscriptionAction.handler(
			runtime,
			{} as Memory,
			undefined,
			undefined,
			callback,
		);
		expect(emit.mock.calls[0][0].data.command).toBe("start");
		expect(result).toMatchObject({
			success: true,
			text: "Starting transcription.",
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ actions: ["START_TRANSCRIPTION"] }),
		);
	});

	it("STOP emits 'stop'; reports failure honestly with no bus", async () => {
		const ok = fakeRuntime({ withBus: true });
		await stopTranscriptionAction.handler(
			ok.runtime,
			{} as Memory,
			undefined,
			undefined,
			vi.fn(),
		);
		expect(ok.emit.mock.calls[0][0].data.command).toBe("stop");

		const none = fakeRuntime({ withBus: false });
		const result = await stopTranscriptionAction.handler(
			none.runtime,
			{} as Memory,
			undefined,
			undefined,
			vi.fn(),
		);
		expect(result).toMatchObject({ success: false });
	});
});
