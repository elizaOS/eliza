/**
 * Coverage for private action gate.
 */
import { describe, expect, it } from "vitest";

import {
	isAutonomousTurn,
	privateActionAllowedOnTurn,
} from "./private-action-gate.js";

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
});
