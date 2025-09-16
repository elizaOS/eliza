/**
 * Extract clean error message from Drizzle wrapped errors
 * Drizzle wraps PostgreSQL errors and only shows the SQL query in the error message,
 * hiding the actual error in the cause property.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && 'cause' in error && error.cause) {
    return (error.cause as Error).message;
  } else if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

/**
 * Extract detailed error information including stack trace for logging
 * Returns both the clean message and stack trace for comprehensive debugging
 */
export function extractErrorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error && 'cause' in error && error.cause) {
    const cause = error.cause as Error;
    return {
      message: cause.message,
      stack: cause.stack || error.stack,
    };
  } else if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: 'Unknown error' };
}
