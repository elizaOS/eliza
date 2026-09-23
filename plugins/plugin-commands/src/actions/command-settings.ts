/**
 * Per-conversation command settings.
 *
 * The option commands (`/think`, `/verbose`, `/reasoning`, `/queue`,
 * `/elevated`, `/model`, `/tts`) persist their value here, keyed by room, via
 * the runtime cache. This is real, queryable state: setting `/think high` then
 * reading it back returns `high`. Each setter validates its argument against an
 * allowed set so a bad value is rejected deterministically rather than guessed.
 */

import type { IAgentRuntime } from "@elizaos/core";

export interface CommandSettings {
	thinking?: string;
	verbose?: string;
	reasoning?: string;
	queue?: string;
	elevated?: string;
	model?: string;
	tts?: string;
}

/** Allowed values per option command (lowercased). `null` = free-form. */
export const COMMAND_SETTING_CHOICES: Record<
	keyof CommandSettings,
	readonly string[] | null
> = {
	thinking: ["off", "minimal", "low", "medium", "high", "xhigh"],
	verbose: ["off", "on", "full"],
	reasoning: ["off", "on", "stream"],
	queue: ["steer", "followup", "collect", "interrupt"],
	elevated: ["off", "on", "ask", "full"],
	model: null,
	tts: ["on", "off"],
};

function cacheKey(roomId: string): string {
	return `command-settings:${roomId}`;
}

/** Clear the persisted command settings for a room. */
export async function clearCommandSettings(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<boolean> {
	return runtime.deleteCache(cacheKey(roomId));
}

/** Read the persisted command settings for a room (empty object if none). */
export async function getCommandSettings(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<CommandSettings> {
	const stored = await runtime.getCache<CommandSettings>(cacheKey(roomId));
	return stored ?? {};
}

/**
 * Validate and persist a single command setting. Returns the normalized value
 * on success, or `{ error }` when the value is not an allowed choice.
 */
export async function setCommandSetting(
	runtime: IAgentRuntime,
	roomId: string,
	key: keyof CommandSettings,
	rawValue: string,
): Promise<{ value: string } | { error: string }> {
	const value = rawValue.trim().toLowerCase();
	const choices = COMMAND_SETTING_CHOICES[key];
	if (choices && !choices.includes(value)) {
		return {
			error: `Invalid ${key} value "${rawValue}". Choose one of: ${choices.join(", ")}.`,
		};
	}
	// `model` is free-form — keep the original casing (e.g. provider/Model-Name).
	const normalized = choices ? value : rawValue.trim();
	const current = await getCommandSettings(runtime, roomId);
	await runtime.setCache<CommandSettings>(cacheKey(roomId), {
		...current,
		[key]: normalized,
	});
	return { value: normalized };
}
