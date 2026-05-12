import type { TextChannel } from "discord.js";

export interface TypingController {
	start: () => void;
	stop: () => void;
}

const HEARTBEAT_MS = 9_000;
const DEFAULT_MAX_DURATION_MS = 20 * 60 * 1000;

export function createTypingController(
	channel: TextChannel,
	maxDurationMs: number = DEFAULT_MAX_DURATION_MS,
): TypingController {
	let interval: ReturnType<typeof setInterval> | null = null;
	let ttlTimeout: ReturnType<typeof setTimeout> | null = null;
	let started = false;
	let stopped = false;

	const sendTyping = () => {
		if (stopped || typeof channel.sendTyping !== "function") {
			return;
		}
		try {
			const result = channel.sendTyping();
			if (result && typeof result.catch === "function") {
				result.catch(() => {
					// Typing failures are non-critical.
				});
			}
		} catch {
			// Typing failures are non-critical.
		}
	};

	const stop = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (interval) {
			clearInterval(interval);
			interval = null;
		}
		if (ttlTimeout) {
			clearTimeout(ttlTimeout);
			ttlTimeout = null;
		}
	};

	const start = () => {
		if (started || stopped) {
			return;
		}
		started = true;
		sendTyping();
		interval = setInterval(sendTyping, HEARTBEAT_MS);
		ttlTimeout = setTimeout(stop, maxDurationMs);
	};

	return { start, stop };
}
