import { logger } from '@elizaos/core';
import { getAgentRuntimeUrl } from '../commands/agent';
import { OptionValues } from 'commander';
import { getAuthHeaders } from '../commands/shared';
/**
 * Handles the error by logging it and exiting the process.
 * If the error is a string, it logs the error message and exits.
 * If the error is an instance of Error, it logs the error message and exits.
 * If the error is not a string or an instance of Error,
 * it logs a default error message and exits.
 * @param {unknown} error - The error to be handled.
 */
export function handleError(error: unknown) {
  // Check for ENOSPC / "no space left on device" and print in red
  const isNoSpace =
    (error instanceof Error &&
      (error.message.includes('no space left on device') || error.message.includes('ENOSPC'))) ||
    (typeof error === 'string' &&
      (error.includes('no space left on device') || error.includes('ENOSPC')));

  if (isNoSpace) {
    logger.error({ src: 'cli', util: 'error-handler' }, 'No space left on device');
    if (error instanceof Error) {
      logger.error(
        { src: 'cli', util: 'error-handler', error: error.message, stack: error.stack },
        'Error details'
      );
    } else {
      logger.error({ src: 'cli', util: 'error-handler', error: String(error) }, 'Error details');
    }
  } else {
    if (error instanceof Error) {
      logger.error(
        { src: 'cli', util: 'error-handler', error: error.message, stack: error.stack },
        'Error occurred'
      );
    } else {
      logger.error(
        { src: 'cli', util: 'error-handler', errorType: typeof error, error: String(error) },
        'Unknown error'
      );
    }
  }
  process.exit(1);
}

export async function checkServer(opts: OptionValues) {
  try {
    const authHeaders = getAuthHeaders(opts);
    const response = await fetch(`${getAgentRuntimeUrl(opts)}/api/agents`, {
      headers: authHeaders,
    });
    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
    }
    logger.success({ src: 'cli', util: 'server-check' }, 'ElizaOS server is running');
  } catch (error) {
    logger.error({ src: 'cli', util: 'server-check' }, 'Unable to connect to ElizaOS server');
    process.exit(1);
  }
}
