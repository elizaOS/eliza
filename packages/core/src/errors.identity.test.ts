/** ElizaError identity holds across independently loaded copies of the errors module, as happens when compiled entrypoints each inline their own copy. */
import { describe, expect, it } from "vitest";
import * as primary from "./errors";

async function loadSecondCopy(): Promise<typeof primary> {
	// A distinct module id gives a separate module instance with its own class.
	return (await import("./errors.ts?second-bundle-copy")) as typeof primary;
}

describe("ElizaError identity across bundled copies", () => {
	it("recognizes errors from another copy through instanceof and helpers", async () => {
		const second = await loadSecondCopy();
		expect(second.ElizaError).not.toBe(primary.ElizaError);

		const fromSecond = new second.ElizaError("boom", { code: "X_FAILED" });
		const fromPrimary = new primary.ElizaError("boom", { code: "Y_FAILED" });

		expect(fromSecond instanceof primary.ElizaError).toBe(true);
		expect(fromPrimary instanceof second.ElizaError).toBe(true);
		expect(primary.isElizaError(fromSecond)).toBe(true);
		expect(second.isElizaError(fromPrimary)).toBe(true);
		expect(primary.toElizaError(fromSecond)).toBe(fromSecond);
		expect(second.toElizaError(fromPrimary)).toBe(fromPrimary);
	});

	it("recognizes subclasses of another copy and keeps subclass instanceof strict", async () => {
		const second = await loadSecondCopy();
		class SecondSubError extends second.ElizaError {}
		class PrimarySubError extends primary.ElizaError {}
		const error = new SecondSubError("sub", { code: "SUB_FAILED" });

		expect(error instanceof primary.ElizaError).toBe(true);
		expect(error instanceof SecondSubError).toBe(true);
		expect(error instanceof PrimarySubError).toBe(false);
		expect(error instanceof Error).toBe(true);
	});

	it("rejects plain errors and look-alike objects", () => {
		expect(new Error("plain") instanceof primary.ElizaError).toBe(false);
		expect(
			{ name: "ElizaError", code: "X", message: "m" } instanceof
				primary.ElizaError,
		).toBe(false);
		expect(null instanceof primary.ElizaError).toBe(false);
		const wrapped = primary.toElizaError(new Error("plain"), "WRAPPED");
		expect(wrapped.code).toBe("WRAPPED");
	});
});
