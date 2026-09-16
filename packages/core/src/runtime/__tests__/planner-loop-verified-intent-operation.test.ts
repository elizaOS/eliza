/**
 * The verified-intent gate's operation check: an intent verb must agree with
 * the family of an applied receipt before a self-verified tool sentence can
 * close the turn without the evaluator. Pure helper, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
	intentFulfilledByResultText,
	intentStatesOnlyOperationAndDomain,
	verifiedIntentOperationAgrees,
} from "../planner-loop";

const applied = (operation: string) => ({ operation, outcome: "applied" });

describe("verifiedIntentOperationAgrees", () => {
	it("rejects a receipt whose operation contradicts the intent verb even when every other word matches", () => {
		expect(
			verifiedIntentOperationAgrees("delete notary appointment friday 4pm", [
				applied("calendar.event.update"),
			]),
		).toBe(false);
		expect(
			verifiedIntentOperationAgrees("forget my favorite tea", [
				applied("memory.create"),
			]),
		).toBe(false);
	});

	it("accepts a receipt from the intent verb's family", () => {
		expect(
			verifiedIntentOperationAgrees(
				"move my notary appointment to friday at 4pm",
				[applied("calendar.event.update")],
			),
		).toBe(true);
		expect(
			verifiedIntentOperationAgrees("forget my favorite tea", [
				applied("memory.delete"),
			]),
		).toBe(true);
		expect(
			verifiedIntentOperationAgrees("remember favorite tea is matcha", [
				applied("memory.create"),
			]),
		).toBe(true);
		expect(
			verifiedIntentOperationAgrees("add a dentist appointment friday", [
				applied("calendar.travel_buffer.prepare"),
				applied("calendar.event.create"),
			]),
		).toBe(true);
	});

	it("defers to the text coverage check when the intent names no operation verb", () => {
		expect(
			verifiedIntentOperationAgrees("notary appointment friday 4pm", [
				applied("calendar.event.update"),
			]),
		).toBe(true);
	});

	it("keeps the evaluator when no applied receipt has a recognizable operation", () => {
		expect(
			verifiedIntentOperationAgrees("add a dentist appointment friday", [
				applied("calendar.travel_buffer.prepare"),
			]),
		).toBe(false);
		expect(
			verifiedIntentOperationAgrees("add a dentist appointment friday", [
				{ operation: "calendar.event.create", outcome: "rolled_back" },
			]),
		).toBe(false);
	});
});

describe("intentStatesOnlyOperationAndDomain", () => {
	it("treats an operation-plus-domain intent as covered by any agreeing verified receipt", () => {
		expect(intentStatesOnlyOperationAndDomain("create calendar event")).toBe(
			true,
		);
		expect(
			intentStatesOnlyOperationAndDomain("update calendar appointment time"),
		).toBe(true);
		expect(
			intentFulfilledByResultText(
				"create calendar event",
				"Created “Optometrist appointment” for Friday, Sep 18 at 3pm EDT.",
			),
		).toBe(true);
	});

	it("keeps the coverage rule for intents that carry specifics", () => {
		expect(
			intentStatesOnlyOperationAndDomain(
				"delete notary appointment friday 4pm",
			),
		).toBe(false);
		expect(
			intentFulfilledByResultText(
				"forget my favorite tea",
				"Forgot: your dog is named Rex.",
			),
		).toBe(false);
	});
});
