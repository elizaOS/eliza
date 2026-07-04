/**
 * Structured runtime errors carry stable machine-readable codes without
 * discarding the original cause chain. Sweep work uses this as the common
 * fast-fail shape while boundary handlers remain responsible for translating
 * failures into user-facing responses.
 */

export type ElizaErrorSeverity = "ephemeral" | "fatal";

export interface ElizaErrorOptions {
	code: string;
	context?: Record<string, unknown>;
	cause?: unknown;
	severity?: ElizaErrorSeverity;
}

export class ElizaError extends Error {
	readonly code: string;
	readonly context?: Record<string, unknown>;
	readonly severity?: ElizaErrorSeverity;

	constructor(message: string, options: ElizaErrorOptions);
	constructor(
		code: string,
		message: string,
		options?: Omit<ElizaErrorOptions, "code">,
	);
	constructor(
		codeOrMessage: string,
		messageOrOptions: string | ElizaErrorOptions,
		options: Omit<ElizaErrorOptions, "code"> = {},
	) {
		const code =
			typeof messageOrOptions === "string"
				? codeOrMessage
				: messageOrOptions.code;
		const message =
			typeof messageOrOptions === "string" ? messageOrOptions : codeOrMessage;
		const resolvedOptions =
			typeof messageOrOptions === "string" ? options : messageOrOptions;

		super(message, { cause: resolvedOptions.cause });
		this.name = "ElizaError";
		this.code = code;
		this.context = resolvedOptions.context;
		this.severity = resolvedOptions.severity;
	}
}

export function isElizaError(error: unknown): error is ElizaError {
	return error instanceof ElizaError;
}
