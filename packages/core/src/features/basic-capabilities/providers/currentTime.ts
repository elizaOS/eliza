/**
 * The CURRENT_TIME provider: injects the current date and time into the prompt
 * with the USER's local wall-clock as the primary rendering.
 *
 * Timezone resolution for the rendered user time, in priority order:
 *   1. the sender's stored profile timezone (Entity.metadata.userProfile —
 *      explicit operator-set values and values learned from conversation by
 *      the fact extractor; see advanced-capabilities/user-profile.ts)
 *   2. the sending client's device timezone hint (content.metadata.uiTimeZone)
 *   3. the agent's TIMEZONE setting
 *   4. none — the timezone is rendered as honestly UNKNOWN, with the server
 *      clock clearly labeled as the server's. The runtime host's timezone is
 *      NEVER presented as the user's wall-clock: on a UTC host that turned
 *      "what time is it" into UTC-as-local plus model-side timezone
 *      arithmetic ("8:35pm in brooklyn" when it was 4:35pm EDT).
 *
 * `resolveMessageTimeZone` keeps its original device→setting→host precedence:
 * it feeds trigger/schedule humanization where the host zone is a safe final
 * fallback for formatting, and scheduling math itself runs on instants.
 */
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import {
	getSenderUserProfile,
	type UserProfileContext,
} from "../../advanced-capabilities/user-profile.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("CURRENT_TIME");

function clientTimeZone(message: Memory): string | null {
	const metadata = message.content?.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}
	const candidate = (metadata as Record<string, unknown>).uiTimeZone;
	if (typeof candidate !== "string" || candidate.trim().length === 0) {
		return null;
	}
	const timeZone = candidate.trim();
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
		return timeZone;
	} catch {
		// error-policy:J3 message metadata is untrusted; an invalid timezone is
		// explicitly rejected so the configured runtime timezone remains authoritative.
		return null;
	}
}

function validTimeZone(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const timeZone = value.trim();
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
		return timeZone;
	} catch {
		// error-policy:J3 runtime settings cross a configuration boundary; an
		// unknown IANA zone is explicitly rejected before prompt composition.
		return null;
	}
}

function hostTimeZone(): string {
	return (
		validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC"
	);
}

/**
 * Resolve the timezone for turn-local dates and clock times. The sender's
 * device is authoritative for the active turn; runtime configuration covers
 * non-interactive callers, and the host is the final local deployment fallback.
 */
export function resolveMessageTimeZone(
	runtime: IAgentRuntime,
	message: Memory,
): string {
	return (
		clientTimeZone(message) ??
		validTimeZone(runtime.getSetting("TIMEZONE")) ??
		hostTimeZone()
	);
}

/** How the user's timezone was resolved for this turn. */
export type UserTimeZoneOrigin =
	| "profile"
	| "device"
	| "agent-setting"
	| "unknown";

/**
 * Resolve the USER's timezone for prompt rendering. Unlike
 * `resolveMessageTimeZone`, this never silently falls back to the host zone:
 * an unknown user timezone is returned as null so the prompt can say so.
 */
export async function resolveUserTimeZone(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<{
	timeZone: string | null;
	origin: UserTimeZoneOrigin;
	profile: UserProfileContext | null;
}> {
	const profile = await getSenderUserProfile(runtime, message);
	if (profile?.timezone) {
		return { timeZone: profile.timezone, origin: "profile", profile };
	}
	const device = clientTimeZone(message);
	if (device) {
		return { timeZone: device, origin: "device", profile };
	}
	const configured = validTimeZone(runtime.getSetting("TIMEZONE"));
	if (configured) {
		return { timeZone: configured, origin: "agent-setting", profile };
	}
	return { timeZone: null, origin: "unknown", profile };
}

function formatInZone(now: Date, timeZone: string) {
	const humanReadable = new Intl.DateTimeFormat("en-US", {
		timeZone,
		dateStyle: "full",
		timeStyle: "long",
	}).format(now);
	const dateOnly = now.toLocaleDateString("en-CA", { timeZone });
	const timeOnly = now.toLocaleTimeString("en-GB", {
		timeZone,
		hour12: false,
	});
	const dayOfWeek = new Intl.DateTimeFormat("en-US", {
		weekday: "long",
		timeZone,
	}).format(now);
	return { humanReadable, dateOnly, timeOnly, dayOfWeek };
}

/**
 * Current time provider function that retrieves the current date and time
 * in various formats for use in time-based operations or responses.
 *
 * @param _runtime - The runtime environment of the bot agent.
 * @param _message - The memory object containing message data.
 * @returns An object containing the current date and time data in various formats.
 */
export const currentTimeProvider: Provider = {
	name: spec.name,
	description: spec.description,
	dynamic: spec.dynamic ?? true,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "GUEST" },

	get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
		const now = new Date();
		const isoTimestamp = now.toISOString();
		const unixTimestamp = Math.floor(now.getTime() / 1000);

		const userResolution = await resolveUserTimeZone(_runtime, _message);
		const userTimeZone = userResolution.timeZone;
		const userLocation = userResolution.profile?.location ?? null;

		// The zone the date/time fields below are computed in. When the user's
		// zone is known it IS the user zone; otherwise fields fall back to the
		// message-resolution zone (device→setting→host) for value consumers,
		// while the rendered text labels that clock as the server's, not the
		// user's.
		const timeZone =
			userTimeZone ?? resolveMessageTimeZone(_runtime, _message);
		const { humanReadable, dateOnly, timeOnly, dayOfWeek } = formatInZone(
			now,
			timeZone,
		);

		let contextText: string;
		if (userTimeZone) {
			const originLabel =
				userResolution.origin === "profile"
					? "from user profile"
					: userResolution.origin === "device"
						? "from user's device"
						: "from agent settings";
			contextText = `# Current Time
- User's local time: ${humanReadable}
- Date: ${dateOnly}
- Time: ${timeOnly} ${userTimeZone}
- Day: ${dayOfWeek}
- User timezone: ${userTimeZone} (${originLabel})${userLocation ? `\n- User location: ${userLocation}` : ""}
- ISO (UTC): ${isoTimestamp}
The local time above is ALREADY the user's wall-clock time. When mentioning the time to the user, state it as-is. Never perform timezone conversion or arithmetic in your reply.`;
		} else {
			contextText = `# Current Time
- User timezone: unknown (do not guess; if local time matters, ask the user where they are)
- Server time: ${humanReadable} (${timeZone} — the SERVER's clock, not the user's)
- ISO (UTC): ${isoTimestamp}
Do not present the server time as the user's local time, and never attempt timezone arithmetic in your reply.`;
		}

		return {
			text: contextText,
			values: {
				currentTime: isoTimestamp,
				currentDate: dateOnly,
				dayOfWeek: dayOfWeek,
				unixTimestamp: unixTimestamp,
				timeZone,
				userTimeZone: userTimeZone ?? undefined,
				userTimeZoneOrigin: userResolution.origin,
				userLocation: userLocation ?? undefined,
			},
			data: {
				iso: isoTimestamp,
				date: dateOnly,
				time: timeOnly,
				dayOfWeek: dayOfWeek,
				humanReadable: humanReadable,
				unixTimestamp: unixTimestamp,
				timeZone,
				userTimeZone,
				userTimeZoneOrigin: userResolution.origin,
				userLocation,
			},
		};
	},
};
