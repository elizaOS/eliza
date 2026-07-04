/**
 * Exercises the connector-setup contract — the `SetupState` lifecycle union,
 * `SETUP_ERROR_CODES`, `buildSetupError`, `setupPath`, and `SetupStatusResponse`
 * that connector plugins and the app-core API host share. Deterministic
 * assertions with no model or database in the loop.
 */
import { describe, expect, it } from "vitest";
import {
	buildSetupError,
	SETUP_ERROR_CODES,
	type SetupErrorResponse,
	type SetupState,
	type SetupStatusResponse,
	setupPath,
} from "./connector-setup";

// Canonical connector-setup contract (#10201). Connector plugins and the
// app-core API host all import these from `@elizaos/core`; this test pins the
// runtime behaviour and the closed set of states so a drift is caught here.

describe("connector-setup contract", () => {
	it("SetupState is the closed four-state lifecycle union", () => {
		// Compile-time: each literal must be assignable to SetupState. A typo or a
		// removed member would fail `tsc`; the runtime array documents the set.
		const states: SetupState[] = ["idle", "configuring", "paired", "error"];
		expect([...states].sort()).toEqual([
			"configuring",
			"error",
			"idle",
			"paired",
		]);
	});

	it("SETUP_ERROR_CODES are stable machine-readable identifiers", () => {
		expect(SETUP_ERROR_CODES).toEqual({
			BAD_REQUEST: "bad_request",
			SERVICE_UNAVAILABLE: "service_unavailable",
			INTERNAL_ERROR: "internal_error",
			TOO_MANY_SESSIONS: "too_many_sessions",
		});
	});

	it("buildSetupError wraps code + message in the structured envelope", () => {
		const err: SetupErrorResponse = buildSetupError(
			SETUP_ERROR_CODES.BAD_REQUEST,
			"serverUrl is required",
		);
		expect(err).toEqual({
			error: { code: "bad_request", message: "serverUrl is required" },
		});
	});

	it("buildSetupError accepts a connector-specific code string", () => {
		expect(buildSetupError("unauthorized", "nope")).toEqual({
			error: { code: "unauthorized", message: "nope" },
		});
	});

	it("setupPath composes the canonical /api/setup/<connector>/<action> path", () => {
		expect(setupPath("signal", "start")).toBe("/api/setup/signal/start");
		expect(setupPath("bluebubbles", "status")).toBe(
			"/api/setup/bluebubbles/status",
		);
		expect(setupPath("imessage", "cancel")).toBe("/api/setup/imessage/cancel");
	});

	it("SetupStatusResponse carries connector + state + typed detail", () => {
		const response: SetupStatusResponse<{ webhookPath: string }> = {
			connector: "bluebubbles",
			state: "paired",
			detail: { webhookPath: "/webhooks/bluebubbles" },
		};
		expect(response.state).toBe("paired");
		expect(response.detail?.webhookPath).toBe("/webhooks/bluebubbles");
	});
});
