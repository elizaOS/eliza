/**
 * START_TRANSCRIPTION / STOP_TRANSCRIPTION agent actions (#8789).
 *
 * The agent can turn long-form voice transcription on/off on the user's device.
 * Transcription CAPTURE is client-side (the mic lives in the renderer shell), so
 * the action can't toggle it directly — it emits a one-way `voice-control`
 * command on the AgentEventService bus. That stream is forwarded to every
 * connected client as an `agent_event`; the renderer re-dispatches it to the
 * shell's capture toggle (the same server→client pattern as `shell:navigate`).
 * Best-effort + non-blocking: if no client is connected the event is simply
 * dropped, and the action reports intent, not capture success.
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Memory,
	type Service,
	ServiceType,
} from "@elizaos/core";

/** Bus stream the renderer subscribes to for mic/transcription control. */
export const VOICE_CONTROL_STREAM = "voice-control";

export type VoiceControlCommand = "start" | "stop";

/** The payload shape the client matches on. */
export interface VoiceControlEvent {
	type: "voice-control";
	command: VoiceControlCommand;
}

/** The slice of AgentEventService the actions use (real service satisfies it). */
interface AgentEventBus extends Service {
	emit(event: {
		runId: string;
		stream: string;
		data: unknown;
		agentId?: string;
	}): void;
}

/**
 * Emit a transcription control command to connected clients. Returns false when
 * no event bus is available (e.g. headless) so callers can report honestly.
 */
export function emitVoiceControl(
	runtime: IAgentRuntime,
	command: VoiceControlCommand,
): boolean {
	const bus = runtime.getService<AgentEventBus>(ServiceType.AGENT_EVENT);
	if (!bus) return false;
	const data: VoiceControlEvent = { type: "voice-control", command };
	bus.emit({
		runId: crypto.randomUUID(),
		stream: VOICE_CONTROL_STREAM,
		data,
		agentId: runtime.agentId,
	});
	return true;
}

async function validate(runtime: IAgentRuntime): Promise<boolean> {
	return runtime.getService(ServiceType.AGENT_EVENT) != null;
}

function makeHandler(
	command: VoiceControlCommand,
	okText: string,
	failText: string,
	actionName: string,
) {
	return async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: unknown,
		_options?: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const delivered = emitVoiceControl(runtime, command);
		const text = delivered ? okText : failText;
		if (!delivered) {
			logger.warn(
				{ command },
				"[transcription-control] no event bus — command not delivered",
			);
		}
		await callback?.({ text, actions: [actionName] });
		return { success: delivered, text };
	};
}

export const startTranscriptionAction: Action = {
	name: "START_TRANSCRIPTION",
	similes: ["BEGIN_TRANSCRIPTION", "START_RECORDING", "RECORD_TRANSCRIPT"],
	description:
		"Start long-form voice transcription (record-only) on the user's device. Use when the user asks to start transcribing/recording a conversation or meeting.",
	routingHint:
		"user asks to start transcribing/recording -> START_TRANSCRIPTION; not for a one-off dictation or a normal voice reply",
	validate,
	handler: makeHandler(
		"start",
		"Starting transcription.",
		"I couldn't reach the voice client to start transcription.",
		"START_TRANSCRIPTION",
	),
	examples: [],
};

export const stopTranscriptionAction: Action = {
	name: "STOP_TRANSCRIPTION",
	similes: ["END_TRANSCRIPTION", "STOP_RECORDING", "FINISH_TRANSCRIPT"],
	description:
		"Stop the long-form voice transcription currently running on the user's device.",
	routingHint: "user asks to stop transcribing/recording -> STOP_TRANSCRIPTION",
	validate,
	handler: makeHandler(
		"stop",
		"Stopping transcription.",
		"I couldn't reach the voice client to stop transcription.",
		"STOP_TRANSCRIPTION",
	),
	examples: [],
};
