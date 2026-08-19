/**
 * The CURRENT_TIME provider renders an active sender device's wall clock when
 * its IANA timezone is available. Agent configuration and the runtime host are
 * retained as reference-clock fallbacks, but are never represented as the
 * sender's local time. Text comes from the centralized provider specification.
 */
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";

const spec = requireProviderSpec("CURRENT_TIME");

function validTimeZone(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const timeZone = value.trim();
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
		return timeZone;
	} catch {
		// error-policy:J3 timezone strings cross message or configuration trust
		// boundaries and must be validated before prompt composition.
		return null;
	}
}

function clientTimeZone(message: Memory): string | null {
	const metadata = message.content?.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}
	return validTimeZone((metadata as Record<string, unknown>).uiTimeZone);
}

function hostTimeZone(): string {
	return (
		validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC"
	);
}

/**
 * Resolve the timezone used by legacy structured CURRENT_TIME fields. The
 * active device wins, followed by agent configuration and the runtime host.
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

export type CurrentTimeZoneOrigin = "device" | "agent-setting" | "host";

function resolveCurrentTimeZone(
	runtime: IAgentRuntime,
	message: Memory,
): { timeZone: string; origin: CurrentTimeZoneOrigin } {
	const device = clientTimeZone(message);
	if (device) return { timeZone: device, origin: "device" };
	const configured = validTimeZone(runtime.getSetting("TIMEZONE"));
	if (configured) return { timeZone: configured, origin: "agent-setting" };
	return { timeZone: hostTimeZone(), origin: "host" };
}

function formatInZone(now: Date, timeZone: string) {
	return {
		humanReadable: new Intl.DateTimeFormat("en-US", {
			timeZone,
			dateStyle: "full",
			timeStyle: "long",
		}).format(now),
		dateOnly: now.toLocaleDateString("en-CA", { timeZone }),
		timeOnly: now.toLocaleTimeString("en-GB", {
			timeZone,
			hour12: false,
		}),
		dayOfWeek: new Intl.DateTimeFormat("en-US", {
			weekday: "long",
			timeZone,
		}).format(now),
	};
}

/** Provides the current instant plus an honestly labeled wall-clock view. */
export const currentTimeProvider: Provider = {
	name: spec.name,
	description: spec.description,
	dynamic: spec.dynamic ?? true,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "GUEST" },

	get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
		const now = new Date();
		const isoTimestamp = now.toISOString();
		const unixTimestamp = Math.floor(now.getTime() / 1000);
		const { timeZone, origin } = resolveCurrentTimeZone(runtime, message);
		const { humanReadable, dateOnly, timeOnly, dayOfWeek } = formatInZone(
			now,
			timeZone,
		);

		const contextText =
			origin === "device"
				? `# Current Time
- User local time: ${humanReadable}
- Date: ${dateOnly}
- Time: ${timeOnly} ${timeZone}
- Day: ${dayOfWeek}
- User timezone: ${timeZone} (from the active device)
- ISO (UTC): ${isoTimestamp}
The local time above is already the user's wall-clock time. State it as-is; do not perform timezone arithmetic.`
				: `# Current Time
- User timezone: unknown (do not guess; ask when the user's local time matters)
- ${origin === "agent-setting" ? "Agent reference" : "Server"} time: ${humanReadable}
- ${origin === "agent-setting" ? "Agent" : "Server"} timezone: ${timeZone}
- ISO (UTC): ${isoTimestamp}
The reference clock above is not the user's local time. Do not present it as user-local or perform timezone arithmetic.`;

		return {
			text: contextText,
			values: {
				currentTime: isoTimestamp,
				currentDate: dateOnly,
				dayOfWeek,
				unixTimestamp,
				timeZone,
				userTimeZone: origin === "device" ? timeZone : undefined,
				timeZoneOrigin: origin,
			},
			data: {
				iso: isoTimestamp,
				date: dateOnly,
				time: timeOnly,
				dayOfWeek,
				humanReadable,
				unixTimestamp,
				timeZone,
				userTimeZone: origin === "device" ? timeZone : null,
				timeZoneOrigin: origin,
			},
		};
	},
};
