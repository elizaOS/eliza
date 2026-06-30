/**
 * Canonical contract for connector setup HTTP routes.
 *
 * This is the single source of truth for the connector-setup wire shapes.
 * It lives in `@elizaos/core` — the innermost package every connector plugin
 * and the API host (`@elizaos/app-core`) already depend on — so both the
 * server that mounts the routes and the plugins that implement them agree on
 * one definition instead of mirroring it locally (see #10201).
 *
 * Every connector plugin's setup-routes export MUST satisfy:
 *
 *   GET  /api/setup/<connector>/status   → SetupStatusResponse
 *   POST /api/setup/<connector>/start    → SetupStatusResponse (state: 'configuring')
 *   POST /api/setup/<connector>/cancel   → SetupStatusResponse (state: 'idle')
 *
 * Error responses follow `{ error: { code, message } }` — never bare strings.
 *
 * This contract is pinned by `plugins/__tests__/setup-routes-contract.test.ts`.
 * `docs/first-run-contracts.md` covers the connector setup surface.
 *
 * Distinct from `./setup` (the onboarding state machine for the first-run
 * wizard) — that models CLI/DM setup steps, this models connector HTTP routes.
 */

/** Setup lifecycle states a connector can be in. */
export type SetupState = "idle" | "configuring" | "paired" | "error";

/**
 * Canonical status response shape returned by every setup endpoint.
 *
 * `detail` is connector-specific (QR code data, pairing phone number,
 * subscription channel IDs, etc.). Callers narrow on `state` first and
 * then read the typed detail.
 */
export interface SetupStatusResponse<TDetail = unknown> {
	connector: string;
	state: SetupState;
	detail?: TDetail;
}

/**
 * Structured error envelope returned when a setup endpoint fails.
 *
 * `code` is a stable machine-readable identifier (e.g. `bad_request`,
 * `service_unavailable`, `internal_error`); `message` is human-readable.
 */
export interface SetupErrorResponse {
	error: {
		code: string;
		message: string;
	};
}

/** Common error codes used across connector setup routes. */
export const SETUP_ERROR_CODES = {
	BAD_REQUEST: "bad_request",
	SERVICE_UNAVAILABLE: "service_unavailable",
	INTERNAL_ERROR: "internal_error",
	TOO_MANY_SESSIONS: "too_many_sessions",
} as const;

export type SetupErrorCode =
	(typeof SETUP_ERROR_CODES)[keyof typeof SETUP_ERROR_CODES];

/**
 * Build a structured error envelope.
 *
 * Use this on every error path in connector setup handlers so the UI
 * layer can branch on `error.code` rather than substring-matching
 * `error.message`.
 */
export function buildSetupError(
	code: SetupErrorCode | string,
	message: string,
): SetupErrorResponse {
	return { error: { code, message } };
}

/**
 * Compose the canonical path for a connector setup endpoint.
 *
 * `setupPath("signal", "start")` → `/api/setup/signal/start`.
 */
export function setupPath(
	connector: string,
	action: "status" | "start" | "cancel",
): string {
	return `/api/setup/${connector}/${action}`;
}
