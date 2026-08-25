/**
 * Unit tests for private-action gate.
 * Consolidated from colocated and __tests__/private-action-gate suites.
 * Preserves all unique assertions: undefined, missing metadata, non-object
 * metadata, isAutonomous true/false/type checks, and private-allowed logic.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import {
	isAutonomousTurn,
	privateActionAllowedOnTurn,
} from "./private-action-gate.js";

function makeMessage(metadata?: Record<string, unknown>): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "hello", ...(metadata ? { metadata } : {}) },
	} as Memory;
}

describe("isAutonomousTurn", () => {
	it("false for undefined", () => {
		expect(isAutonomousTurn(undefined)).toBe(false);
	});

	it("false for missing metadata", () => {
		expect(isAutonomousTurn({ content: {} } as never)).toBe(false);
		expect(isAutonomousTurn({ content: { metadata: null } } as never)).toBe(
			false,
		);
	});

	it("true only when isAutonomous === true", () => {
		expect(
			isAutonomousTurn({
				content: { metadata: { isAutonomous: true } },
			} as never),
		).toBe(true);
		expect(
			isAutonomousTurn({
				content: { metadata: { isAutonomous: false } },
			} as never),
		).toBe(false);
		expect(
			isAutonomousTurn({ content: { metadata: { isAutonomous: 1 } } } as never),
		).toBe(false);
	});

	it("false for non-object metadata", () => {
		expect(isAutonomousTurn({ content: { metadata: "yes" } } as never)).toBe(
			false,
		);
	});

	it("returns true only when metadata.isAutonomous === true (merged)", () => {
		expect(isAutonomousTurn(makeMessage({ isAutonomous: true }))).toBe(true);
	});

	it("returns false for a plain user message (merged)", () => {
		expect(isAutonomousTurn(makeMessage())).toBe(false);
	});

	it("returns false for non-true isAutonomous values and undefined messages (merged)", () => {
		expect(isAutonomousTurn(makeMessage({ isAutonomous: "true" }))).toBe(false);
		expect(isAutonomousTurn(makeMessage({ isAutonomous: 1 }))).toBe(false);
		expect(isAutonomousTurn(undefined)).toBe(false);
	});
});

describe("privateActionAllowedOnTurn", () => {
	it("allows non-private always", () => {
		expect(privateActionAllowedOnTurn({ private: false }, undefined)).toBe(
			true,
		);
		expect(
			privateActionAllowedOnTurn({ private: undefined } as never, undefined),
		).toBe(true);
	});

	it("allows private only on autonomous", () => {
		const auto = { content: { metadata: { isAutonomous: true } } } as never;
		const user = { content: { metadata: { isAutonomous: false } } } as never;
		expect(privateActionAllowedOnTurn({ private: true }, auto)).toBe(true);
		expect(privateActionAllowedOnTurn({ private: true }, user)).toBe(false);
		expect(privateActionAllowedOnTurn({ private: true }, undefined)).toBe(
			false,
		);
	});

	it("always allows non-private actions (merged)", () => {
		expect(privateActionAllowedOnTurn({}, makeMessage())).toBe(true);
		expect(privateActionAllowedOnTurn({ private: false }, makeMessage())).toBe(
			true,
		);
	});

	it("allows private actions only on autonomous turns (merged)", () => {
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
