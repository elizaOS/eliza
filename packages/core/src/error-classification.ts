/**
 * Error-formatting + classification utilities for global process handlers.
 *
 * Shared between the CLI (`run-main.ts`), the dev-server (`dev-server.ts`), the
 * agent serve path, and `installProcessCrashGuards` (`process-guards.ts`).
 * Intentionally dependency-free — only string/object inspection.
 */

import {
	formatDiagnosticError,
	readDiagnosticProperty,
} from "./utils/errors.js";

export function formatUncaughtError(error: unknown): string {
	return formatDiagnosticError(error);
}

function hasInsufficientCreditsSignal(input: string): boolean {
	return /\b(insufficient(?:[_\s]+(?:credits?|quota))|insufficient_quota|out of credits|payment required|statuscode:\s*402)\b/i.test(
		input,
	);
}

/**
 * Reads a provider HTTP status off an error node. Accepts `statusCode` and
 * `status`, as a number or a numeric string: the sibling classifier in
 * `utils/model-errors.ts` already reads both shapes, and providers and
 * gateways do not all spell a 402 the same way.
 */
function readProviderStatusCode(value: unknown): number | undefined {
	const raw =
		readDiagnosticProperty(value, "statusCode") ??
		readDiagnosticProperty(value, "status");
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

/**
 * Returns `true` when the rejection looks like an AI provider credit-exhaustion
 * error — these are noisy but not fatal, so callers should warn instead of crash.
 */
export function shouldIgnoreUnhandledRejection(reason: unknown): boolean {
	const seen = new Set<unknown>();
	const pending: unknown[] = [reason];
	while (pending.length > 0) {
		const current = pending.pop();
		const isObject = current !== null && typeof current === "object";
		if (isObject) {
			if (seen.has(current)) continue;
			seen.add(current);
		}

		const formatted = formatUncaughtError(current);
		const isProviderError =
			/AI_NoOutputGeneratedError|No output generated|AI_APICallError|AI_RetryError/i.test(
				formatted,
			);
		if (isProviderError) {
			if (hasInsufficientCreditsSignal(formatted)) return true;

			if (readProviderStatusCode(current) === 402) return true;

			const responseBody = readDiagnosticProperty(current, "responseBody");
			if (
				typeof responseBody === "string" &&
				hasInsufficientCreditsSignal(responseBody)
			) {
				return true;
			}
		}

		if (!isObject) continue;

		const errors = readDiagnosticProperty(current, "errors");
		if (Array.isArray(errors)) {
			pending.push(...errors);
		}

		// The AI SDK `RetryError` envelope carries the terminal failure on
		// `lastError` (with no `cause` pointing at it); the sibling
		// `modelErrorChain` in `utils/model-errors.ts` walks the same
		// `.cause` / `.lastError` / `.errors[]` graph.
		pending.push(readDiagnosticProperty(current, "lastError"));

		pending.push(readDiagnosticProperty(current, "cause"));
	}

	return false;
}
