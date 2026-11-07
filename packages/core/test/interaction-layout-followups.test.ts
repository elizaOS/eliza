import { describe, expect, it } from "vitest";
import { toNeutralLayout } from "../src/messaging/interaction-layout";

/** A followup whose reply payload exceeds the default 64-byte callback budget. */
const LONG_PAYLOAD = "x".repeat(100);

describe("toNeutralLayout followups", () => {
	it("flags fallback when every followup button is dropped for exceeding the callback budget", () => {
		const layout = toNeutralLayout({
			kind: "followups",
			id: "f1",
			options: [{ kind: "reply", payload: LONG_PAYLOAD, label: "Long" }],
		});
		expect(layout.rows).toEqual([]);
		expect(layout.needsFallback).toBe(true);
	});

	it("flags fallback when only one followup button is dropped", () => {
		const layout = toNeutralLayout({
			kind: "followups",
			id: "f1",
			options: [
				{ kind: "reply", payload: "hi", label: "Hi" },
				{ kind: "reply", payload: LONG_PAYLOAD, label: "Long" },
			],
		});
		expect(layout.rows).toHaveLength(1);
		expect(layout.needsFallback).toBe(true);
	});

	it("does not flag fallback when every followup fits the callback budget", () => {
		const layout = toNeutralLayout({
			kind: "followups",
			id: "f1",
			options: [{ kind: "reply", payload: "hi", label: "Hi" }],
		});
		expect(layout.rows).toHaveLength(1);
		expect(layout.needsFallback).not.toBe(true);
	});

	it("matches the choice layout, which already flags a dropped option", () => {
		const layout = toNeutralLayout({
			kind: "choice",
			id: "c1",
			scope: "s",
			options: [{ value: LONG_PAYLOAD, label: "Long" }],
		});
		expect(layout.rows).toEqual([]);
		expect(layout.needsFallback).toBe(true);
	});
});
