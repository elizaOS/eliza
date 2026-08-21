/** Regression tests for computer-use isoTimestamp: invalid dates and out-of-range ISO strings must fail closed without throwing RangeError. */
import { describe, expect, test } from "vitest";
import {
	INTERACTION_CONTRACT_VERSION,
	type InteractionObservation,
	normalizeInteractionObservation,
} from "./computer-use.ts";

const validObservation: InteractionObservation = {
	contractVersion: INTERACTION_CONTRACT_VERSION,
	observationId: "observation-1",
	sessionId: "session-1",
	adapterId: "deterministic-computer-use",
	surface: {
		sessionId: "session-1",
		adapterId: "deterministic-computer-use",
		surfaceId: "surface-1",
		kind: "browser_tab",
		generation: 3,
		parentSurfaceId: null,
	},
	sequence: 7,
	observedAt: "2026-01-01T00:00:00.000Z",
	channels: ["dom", "screenshot"],
	artifacts: [],
	viewport: { x: 0, y: 0, width: 1440, height: 900 },
	cursor: { x: 20, y: 30 },
	redactions: [],
	traceEvents: [],
};

describe("computer-use isoTimestamp range and validity guard", () => {
	test("valid ISO timestamp normalizes to canonical ISO", () => {
		const result = normalizeInteractionObservation({
			...validObservation,
			observedAt: "2026-08-21T18:00:00Z",
		});
		expect(result.observedAt).toBe("2026-08-21T18:00:00.000Z");
	});

	test("invalid timestamp string fails closed with validation error", () => {
		expect(() =>
			normalizeInteractionObservation({
				...validObservation,
				observedAt: "not-a-timestamp",
			}),
		).toThrow("must be an ISO timestamp with a timezone");
	});

	test("out-of-range timestamp fails closed without unhandled RangeError", () => {
		expect(() =>
			normalizeInteractionObservation({
				...validObservation,
				observedAt: "9999-12-31T23:59:59+99:99",
			}),
		).toThrow("must be a valid ISO timestamp");
	});
});
