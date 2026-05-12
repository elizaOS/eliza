import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("CURRENT_TIME");

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
		const setting = _runtime.getSetting("TIMEZONE");
		const timeZone = (typeof setting === "string" ? setting : "UTC") || "UTC";

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
			},
			data: {
				iso: isoTimestamp,
				date: dateOnly,
				time: timeOnly,
				dayOfWeek: dayOfWeek,
				humanReadable: humanReadable,
				unixTimestamp: unixTimestamp,
			},
		};
	},
};
