/**
 * Verifies that the packed-tarball consumer verification sanitizes the
 * workspace `eliza-source` export condition out of `NODE_OPTIONS`.
 *
 * Workspace e2e lanes (packages/app/scripts/run-ui-playwright.mjs) export
 * `--conditions=eliza-source` and prebuild the workspace from inside that env.
 * The packed tarball ships no `src/`, so a consumer inheriting the condition
 * resolves `@elizaos/core/client-public` to a nonexistent `src/*.ts` and the
 * core build dies — taking `packages/app audit:app` down with it before any
 * screenshot is captured. Pure function; no compiler or process is run here.
 */
import { describe, expect, it } from "vitest";
import { packedConsumerNodeOptions } from "../build";

describe("packedConsumerNodeOptions", () => {
	it("passes through an unset value", () => {
		expect(packedConsumerNodeOptions(undefined)).toBeUndefined();
		expect(packedConsumerNodeOptions("")).toBe("");
	});

	it("drops the sole eliza-source condition entirely", () => {
		expect(
			packedConsumerNodeOptions("--conditions=eliza-source"),
		).toBeUndefined();
		expect(
			packedConsumerNodeOptions("--conditions eliza-source"),
		).toBeUndefined();
		expect(packedConsumerNodeOptions("-C eliza-source")).toBeUndefined();
	});

	it("keeps unrelated options and other conditions", () => {
		expect(
			packedConsumerNodeOptions(
				"--max-old-space-size=8192 --conditions=eliza-source --enable-source-maps",
			),
		).toBe("--max-old-space-size=8192 --enable-source-maps");
		expect(packedConsumerNodeOptions("--conditions=development")).toBe(
			"--conditions=development",
		);
	});

	it("strips repeated eliza-source conditions", () => {
		expect(
			packedConsumerNodeOptions(
				"--conditions=eliza-source --import tsx --conditions=eliza-source",
			),
		).toBe("--import tsx");
	});

	it("does not strip a condition that merely starts with eliza-source", () => {
		expect(packedConsumerNodeOptions("--conditions=eliza-source-extra")).toBe(
			"--conditions=eliza-source-extra",
		);
	});
});
