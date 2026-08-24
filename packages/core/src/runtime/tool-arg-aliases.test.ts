/**
 * Tests for tool-arg-aliases — statePresentsEntityAlias.
 */
import { describe, expect, it } from "vitest";
import { statePresentsEntityAlias } from "./tool-arg-aliases.ts";

describe("tool-arg-aliases", () => {
	it("detects alias in text", () => {
		const state = {
			text: "hello [REDACTED:ELIZA_ADMIN_ENTITY_ID] world",
			values: {},
			data: {},
		} as never;
		expect(statePresentsEntityAlias(state, "ELIZA_ADMIN_ENTITY_ID")).toBe(true);
	});

	it("returns false when alias not present", () => {
		const state = { text: "hello world", values: {}, data: {} } as never;
		expect(statePresentsEntityAlias(state, "ELIZA_ADMIN_ENTITY_ID")).toBe(
			false,
		);
	});

	it("returns false for undefined state", () => {
		expect(statePresentsEntityAlias(undefined, "ELIZA_ADMIN_ENTITY_ID")).toBe(
			false,
		);
	});

	it("detects alias in values", () => {
		const state = {
			text: "",
			values: { foo: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]" },
			data: {},
		} as never;
		expect(statePresentsEntityAlias(state, "ELIZA_ADMIN_ENTITY_ID")).toBe(true);
	});

	it("detects alias nested in values", () => {
		const state = {
			text: "",
			values: { a: { b: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]" } },
			data: {},
		} as never;
		expect(statePresentsEntityAlias(state, "ELIZA_ADMIN_ENTITY_ID")).toBe(true);
	});

	it("returns false for wrong alias name", () => {
		const state = {
			text: "[REDACTED:OTHER_ENTITY_ID]",
			values: {},
			data: {},
		} as never;
		expect(statePresentsEntityAlias(state, "ELIZA_ADMIN_ENTITY_ID")).toBe(
			false,
		);
	});
});
