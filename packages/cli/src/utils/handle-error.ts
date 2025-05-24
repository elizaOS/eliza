import { logger } from '@elizaos/core';
import { getAgentRuntimeUrl } from '../commands/agent';
import { OptionValues } from 'commander';
import colors from 'yoctocolors';
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
    logger.error(
      colors.red('ERROR: No space left on device! Please free up disk space and try again.')
    );
    if (error instanceof Error) {
      logger.error(colors.red(error.message));
      logger.error(colors.red(error.stack || ''));
    } else {
      logger.error(colors.red(String(error)));
    }
  } else {
    logger.error('An error occurred:', error);
    if (error instanceof Error) {
      logger.error('Error details:', error.message);
      logger.error('Stack trace:', error.stack);
    } else {
      logger.error('Unknown error type:', typeof error);
      logger.error('Error value:', error);
    }
  }
  process.exit(1);
}

export async function checkServer(opts: OptionValues) {
  try {
    const response = await fetch(`${getAgentRuntimeUrl(opts)}/api/agents`);
    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
    }
    logger.success('ElizaOS server is running');
  } catch (error) {
    logger.error('Unable to connect to ElizaOS server, likely not running or not accessible!');
    process.exit(1);
  }
}
