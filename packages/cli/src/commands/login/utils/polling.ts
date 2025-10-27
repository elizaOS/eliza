import type { SessionStatusResponse } from '../types';

const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds
const MAX_RETRIES = 3;

/**
 * Poll the cloud API for authentication status
 * Implements exponential backoff on errors
 */
export async function pollAuthStatus(
  cloudUrl: string,
  sessionId: string,
  timeoutSeconds: number
): Promise<SessionStatusResponse> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  let retryCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${cloudUrl}/api/auth/cli-session/${sessionId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Don't throw on 404 - session might not be created yet
        if (response.status === 404) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        // For other errors, retry with exponential backoff
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          throw new Error(`Server error (${response.status}): ${response.statusText}`);
        }

        await sleep(POLL_INTERVAL_MS * Math.pow(2, retryCount - 1));
        continue;
      }

      const data: SessionStatusResponse = await response.json();

      // Reset retry count on successful response
      retryCount = 0;

      if (data.status === 'authenticated') {
        return data;
      }

      if (data.status === 'expired') {
        throw new Error('Authentication session expired. Please try again.');
      }

      // Status is 'pending', continue polling
      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      // Network errors or parsing errors
      if (error instanceof Error && error.message.includes('session expired')) {
        throw error;
      }

      retryCount++;
      if (retryCount >= MAX_RETRIES) {
        throw new Error(
          `Failed to connect to ElizaOS Cloud at ${cloudUrl}. Please check your network connection and try again.`
        );
      }

      await sleep(POLL_INTERVAL_MS * Math.pow(2, retryCount - 1));
    }
  }

  throw new Error('Authentication timed out. Please try again.');
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
