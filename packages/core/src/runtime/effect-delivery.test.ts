/**
 * Verifies that visible effect proof survives ordinary content transforms but
 * cannot be synthesized by an outgoing hook that discovers the private symbol.
 */

import { describe, expect, it } from "vitest";
import type { Content } from "../types/primitives";
import {
	bindEffectDelivery,
	effectDeliveryBindingProvesApplication,
	getEffectDeliveryBinding,
} from "./effect-delivery";

describe("effect delivery binding authenticity", () => {
	it("survives an object spread while rejecting a forged replacement", () => {
		const bound = bindEffectDelivery(
			{
				text: "Done — the reminder is set.",
				effectReceiptIds: ["receipt-1"],
			},
			"Done — the reminder is set.",
			["receipt-1"],
			true,
		);
		const spread = { ...bound };

		expect(effectDeliveryBindingProvesApplication(spread)).toBe(true);

		const [bindingSymbol] = Object.getOwnPropertySymbols(spread);
		expect(bindingSymbol).toBeDefined();
		const forged = {
			...spread,
			[bindingSymbol]: {
				text: spread.text,
				receiptIds: ["receipt-1"],
				applied: true,
			},
		} as Content;

		expect(getEffectDeliveryBinding(forged)).toBeUndefined();
		expect(effectDeliveryBindingProvesApplication(forged)).toBe(false);
	});
});
