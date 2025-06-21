import type { IAgentRuntime, Memory, Provider } from '@elizaos/core';

/**
 * Time provider function that retrieves the current date and time in UTC
 * for use in time-based operations or responses.
 *
 * @param _runtime - The runtime environment of the bot agent.
 * @param _message - The memory object containing message data.
 * @returns An object containing the current date and time data, human-readable date and time string,
 * and a text response with the current date and time information.
 */
/**
 * Represents a time provider for retrieving current date and time information.
 * @type {Provider}
 */
export const timeProvider: Provider = {
  name: 'TIME',
  get: async (_runtime: IAgentRuntime, _message: Memory) => {
    const currentDate = new Date();

    // Get UTC time since bots will be communicating with users around the global
    const options = {
      timeZone: 'UTC',
      dateStyle: 'full' as const,
      timeStyle: 'long' as const,
    };
    const humanReadable = new Intl.DateTimeFormat('en-US', options).format(currentDate);
    return {
      data: {
        time: currentDate,
      },
      values: {
        time: humanReadable,
      },
      text: `The current date and time is ${humanReadable}. Please use this as your reference for any time-based operations or responses.`,
    };
  },
};
