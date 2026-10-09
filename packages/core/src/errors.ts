/** Structured errors carry a machine-readable code, contextual data, and the original cause. */
// Extension-explicit so plain `node --test` lanes can resolve it and the emit
// config's relative-extension rewrite applies (extensionless would survive emit).
import { formatError, readDiagnosticProperty } from "./utils/errors.ts";

/**
 * Severity hint for an {@link ElizaError}. `ephemeral` failures are expected to
 * be transient/recoverable (retry, reconfigure); `fatal` failures indicate a
 * broken invariant the current operation cannot proceed past.
 */
export type ElizaErrorSeverity = "ephemeral" | "fatal";

/** Options accepted by the {@link ElizaError} constructor. */
export interface ElizaErrorOptions {
	/** Earliest retry time in epoch milliseconds; schedulers may wait longer. */
	retryAt?: number;
	/**
	 * Stable, grep-able classification key (e.g. `DB_QUERY_FAILED`). Drives the
	 * per-code counter and escalation threshold in `runtime.reportError`.
	 */
	code: string;
	/** Underlying error being wrapped; preserved on `.cause` (context-adding rethrow). */
	cause?: unknown;
	/** Structured, serializable context for logs and the error event payload. */
	context?: Record<string, unknown>;
	/** Transient-vs-fatal hint. */
	severity?: ElizaErrorSeverity;
}

/** Process-wide branding preserves instanceof across separately bundled copies. */
const ELIZA_ERROR_BRAND: unique symbol = Symbol.for("elizaos.core.ElizaError");

/**
 * Structured error with a classification `code`, optional `context`, an
 * optional `severity`, and a preserved `cause` chain.
 *
 * `value instanceof ElizaError` recognizes an `ElizaError` (or subclass)
 * created by any bundled copy of this module through the shared brand.
 * Subclasses keep ordinary prototype-chain `instanceof` semantics.
 */
export class ElizaError extends Error {
	static override [Symbol.hasInstance](value: unknown): boolean {
		// biome-ignore lint/complexity/noThisInStatic: `this` is the class on the right of `instanceof`; subclasses keep prototype semantics.
		if (this !== ElizaError) {
			// biome-ignore lint/complexity/noThisInStatic: see above.
			return Function.prototype[Symbol.hasInstance].call(this, value);
		}
		return (
			(typeof value === "object" || typeof value === "function") &&
			value !== null &&
			readDiagnosticProperty(value, ELIZA_ERROR_BRAND) === true
		);
	}

	override readonly name: string = "ElizaError";
	readonly code: string;
	readonly retryAt?: number;
	readonly context?: Record<string, unknown>;
	readonly severity?: ElizaErrorSeverity;

	constructor(message: string, options: ElizaErrorOptions) {
		// Pass cause through to the native Error so `.cause` and the V8 cause
		// chain in stack traces are preserved.
		super(
			message,
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.code = options.code;
		this.retryAt = options.retryAt;
		this.context = options.context;
		this.severity = options.severity;
		// Restore the prototype chain for reliable `instanceof` across the
		// transpiled ES target boundary.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

Object.defineProperty(ElizaError.prototype, ELIZA_ERROR_BRAND, {
	value: true,
});

/**
 * A single entry in the runtime's in-memory reported-error ring, produced by
 * `runtime.reportError` and read by the RECENT_ERRORS provider and the
 * escalation threshold.
 */
export interface ReportedError {
	/** Reporting subsystem — the `[scope]` log prefix. */
	scope: string;
	/** Machine-classifiable key (from `ElizaError.code`, else `UNCLASSIFIED`). */
	code: string;
	/** Human-readable failure message. */
	message: string;
	/** Serializable diagnostic context, when supplied. */
	context?: Record<string, unknown>;
	/** Epoch-ms timestamp the error was reported. */
	at: number;
}

/** Narrowing helper: true when `value` is an {@link ElizaError}. */
export function isElizaError(value: unknown): value is ElizaError {
	return value instanceof ElizaError;
}

/**
 * Normalize any thrown value into an {@link ElizaError}. An existing
 * `ElizaError` passes through unchanged; anything else is wrapped with the
 * supplied `fallbackCode` (default `UNCLASSIFIED`) and the original preserved on
 * `.cause`. Never throws — it is used on diagnostic paths that must not fail.
 */
export function toElizaError(
	value: unknown,
	fallbackCode = "UNCLASSIFIED",
): ElizaError {
	if (value instanceof ElizaError) return value;
	return new ElizaError(formatError(value), {
		code: fallbackCode,
		cause: value,
	});
}
