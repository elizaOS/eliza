/**
 * The CURRENT_TIME provider: injects the current date and time into the prompt
 * in several formats (ISO, unix, date-only, time-only, day-of-week, and a human
 * readable full form), resolved against the sending client's IANA timezone
 * when available, then the agent's TIMEZONE setting, then the runtime host's
 * IANA timezone. Turn-local time keeps relative dates aligned with the device
 * the user is actively using while direct API callers remain local-time safe.
 * Text content comes from the centralized CURRENT_TIME provider spec.
 */
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
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
	roleGate: { minRole: "USER" },

	get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
		const now = new Date();
		const timeZone =
			clientTimeZone(_message) ??
			validTimeZone(_runtime.getSetting("TIMEZONE")) ??
			hostTimeZone();

		const isoTimestamp = now.toISOString();
		const unixTimestamp = Math.floor(now.getTime() / 1000);

		const options = {
			timeZone,
			dateStyle: "full" as const,
			timeStyle: "long" as const,
		};
		const humanReadable = new Intl.DateTimeFormat("en-US", options).format(now);

		const dateOnly = now.toLocaleDateString("en-CA", { timeZone });
		const timeOnly = now.toLocaleTimeString("en-GB", {
			timeZone,
			hour12: false,
		});
		const dayOfWeek = new Intl.DateTimeFormat("en-US", {
			weekday: "long",
			timeZone,
		}).format(now);

		const contextText = `# Current Time
- Date: ${dateOnly}
- Time: ${timeOnly} ${timeZone}
- Day: ${dayOfWeek}
- Full: ${humanReadable}
- ISO: ${isoTimestamp}`;

		return {
			text: contextText,
			values: {
				currentTime: isoTimestamp,
				currentDate: dateOnly,
				dayOfWeek: dayOfWeek,
				unixTimestamp: unixTimestamp,
				timeZone,
			},
			data: {
				iso: isoTimestamp,
				date: dateOnly,
				time: timeOnly,
				dayOfWeek: dayOfWeek,
				humanReadable: humanReadable,
				unixTimestamp: unixTimestamp,
				timeZone,
			},
		};
	},
};
