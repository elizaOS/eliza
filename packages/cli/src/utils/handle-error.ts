import { logger } from "@/src/utils/logger";

/**
 * Handles the error by logging it and exiting the process.
 * If the error is a string, it logs the error message and exits.
 * If the error is an instance of Error, it logs the error message and exits.
 * If the error is not a string or an instance of Error,
 * it logs a default error message and exits.
 * @param {unknown} error - The error to be handled.
 */
export function handleError(error: unknown) {
	if (typeof error === "string") {
		logger.error(error);
		process.exit(1);
	}

	if (error instanceof Error) {
		logger.error(error.message);
		process.exit(1);
	}

	logger.error("Something went wrong. Please try again.");
	process.exit(1);
}
