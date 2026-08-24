/**
 * Covers the triage contract's runtime surface in types.ts: the two adapter
 * registry lists that action parameter schemas enumerate and membership-check,
 * and the NotYetImplementedError that optional adapter hooks throw instead of
 * silently succeeding.
 */

import { describe, expect, it } from "vitest";
import {
	ALL_MESSAGE_SOURCES,
	MANAGE_OPERATION_KINDS,
	NotYetImplementedError,
} from "./types.ts";

const throwFeature = (feature: string): unknown => {
	try {
		throw new NotYetImplementedError(feature);
	} catch (error) {
		return error;
	}
};

describe("NotYetImplementedError", () => {
	it("carries the feature name in its message", () => {
		const error = new NotYetImplementedError("scheduleSend");

		expect(error.message).toBe("NotYetImplemented: scheduleSend");
	});

	it("sets its own name for logs and serialization", () => {
		const error = new NotYetImplementedError("readMessage");

		expect(error.name).toBe("NotYetImplementedError");
	});

	it("stays on the Error prototype chain", () => {
		const error = new NotYetImplementedError("searchMessages");

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(NotYetImplementedError);
	});

	it("is catchable as itself through a real throw site", () => {
		const caught = throwFeature("manageMessage");

		expect(caught).toBeInstanceOf(NotYetImplementedError);
		expect((caught as NotYetImplementedError).message).toBe(
			"NotYetImplemented: manageMessage",
		);
	});

	it("preserves unusual feature identifiers losslessly", () => {
		const error = new NotYetImplementedError(
			"plugin-x/schedule_send (beta v2)",
		);

		expect(error.message).toBe(
			"NotYetImplemented: plugin-x/schedule_send (beta v2)",
		);
	});

	it("renders an empty feature as the bare prefix", () => {
		const error = new NotYetImplementedError("");

		expect(error.message).toBe("NotYetImplemented: ");
	});
});

describe("ALL_MESSAGE_SOURCES", () => {
	it("registers at least one connector", () => {
		expect(ALL_MESSAGE_SOURCES.length).toBeGreaterThan(0);
	});

	it("has no duplicate sources, keeping action parameter enums valid", () => {
		const spread = [...ALL_MESSAGE_SOURCES];

		expect(spread.length).toBe(ALL_MESSAGE_SOURCES.length);
		expect(new Set(spread).size).toBe(spread.length);
	});

	it("stores every source in canonical lowercase form", () => {
		for (const source of ALL_MESSAGE_SOURCES) {
			expect(source).toBe(source.trim().toLowerCase());
		}
	});
});

describe("MANAGE_OPERATION_KINDS", () => {
	it("registers at least one manage operation", () => {
		expect(MANAGE_OPERATION_KINDS.length).toBeGreaterThan(0);
	});

	it("has no duplicate operation kinds", () => {
		const spread = [...MANAGE_OPERATION_KINDS];

		expect(spread.length).toBe(MANAGE_OPERATION_KINDS.length);
		expect(new Set(spread).size).toBe(spread.length);
	});

	it("uses snake_case tokens safe for action parameter enums", () => {
		for (const kind of MANAGE_OPERATION_KINDS) {
			expect(kind).toMatch(/^[a-z][a-z_]*$/);
		}
	});
});
