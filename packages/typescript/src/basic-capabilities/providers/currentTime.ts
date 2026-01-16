import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";

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
  get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const now = new Date();

    const isoTimestamp = now.toISOString();
    const unixTimestamp = Math.floor(now.getTime() / 1000);

    const options = {
      timeZone: "UTC",
      dateStyle: "full" as const,
      timeStyle: "long" as const,
    };
    const humanReadable = new Intl.DateTimeFormat("en-US", options).format(now);

    const dateOnly = now.toISOString().split("T")[0];
    const timeOnly = now.toISOString().split("T")[1].split(".")[0];
    const dayOfWeek = now.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

    const contextText = `# Current Time
- Date: ${dateOnly}
- Time: ${timeOnly} UTC
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
