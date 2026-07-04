/**
 * Unit coverage for the private-action turn gate — `isAutonomousTurn` and
 * `privateActionAllowedOnTurn` — asserting that actions marked `private` are
 * exposed only on autonomous turns and always-allowed otherwise. Pure
 * predicates over an in-memory `Memory`; no runtime or model.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import {
	isAutonomousTurn,
	privateActionAllowedOnTurn,
} from "../private-action-gate";

function makeMessage(metadata?: Record<string, unknown>): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "hello", ...(metadata ? { metadata } : {}) },
	} as Memory;
}

describe("isAutonomousTurn", () => {
	it("returns true only when metadata.isAutonomous === true", () => {
		expect(isAutonomousTurn(makeMessage({ isAutonomous: true }))).toBe(true);
	});

	it("returns false for a plain user message", () => {
		expect(isAutonomousTurn(makeMessage())).toBe(false);
	});

	it("returns false for non-true isAutonomous values and undefined messages", () => {
		expect(isAutonomousTurn(makeMessage({ isAutonomous: "true" }))).toBe(false);
		expect(isAutonomousTurn(makeMessage({ isAutonomous: 1 }))).toBe(false);
		expect(isAutonomousTurn(undefined)).toBe(false);
	});
});

describe("privateActionAllowedOnTurn", () => {
	it("always allows non-private actions", () => {
		expect(privateActionAllowedOnTurn({}, makeMessage())).toBe(true);
		expect(privateActionAllowedOnTurn({ private: false }, makeMessage())).toBe(
			true,
		);
	});

	it("allows private actions only on autonomous turns", () => {
		expect(privateActionAllowedOnTurn({ private: true }, makeMessage())).toBe(
			false,
		);
		expect(
			privateActionAllowedOnTurn(
				{ private: true },
				makeMessage({ isAutonomous: true }),
			),
		).toBe(true);
	});
});
