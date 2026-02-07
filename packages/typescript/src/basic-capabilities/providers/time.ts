import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("TIME");

/**
 * Time provider function that retrieves the current date and time in UTC
 * for use in time-based operations or responses.
 *
 * @param _runtime - The runtime environment of the bot agent.
 * @param _message - The memory object containing message data.
 * @returns An object containing the current date and time data, human-readable date and time string,
 * and a text response with the current date and time information.
 */
export const timeProvider: Provider = {
  name: spec.name,
  description: spec.description,
  get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const currentDate = new Date();

    // Get UTC time since bots will be communicating with users around the global
    const options = {
      timeZone: "UTC",
      dateStyle: "full" as const,
      timeStyle: "long" as const,
    };
    const humanReadable = new Intl.DateTimeFormat("en-US", options).format(
      currentDate,
    );
    return {
      data: {
        timestamp: currentDate.getTime(),
        isoString: currentDate.toISOString(),
      },
      values: {
        time: humanReadable,
      },
      text: `The current date and time is ${humanReadable}. Please use this as your reference for any time-based operations or responses.`,
    };
  },
};
