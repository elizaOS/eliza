/** Verifies configured-secret taint mapping without exposing secret values. */

import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime.js";
import type { Character } from "../types/index.js";
import {
	locateConfiguredSecretFragmentTaint,
	type SecretFragment,
} from "./fragment-redaction.js";

const SECRET = ["mari", "gold9"].join("");
const SECRETS = { SERVICE_TOKEN: SECRET };

describe("locateConfiguredSecretFragmentTaint", () => {
	it("maps an exact same-fragment match to absolute source offsets", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[{ source: "stdout", startOffset: 40, text: `ok ${SECRET} end` }],
				SECRETS,
			),
		).toEqual({
			status: "complete",
			ranges: [{ source: "stdout", startOffset: 43, endOffset: 52 }],
			maxSecretLength: 9,
		});
	});

	it("maps a configured secret split across chunks of one source", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[
					{ source: "stdout", startOffset: 0, text: "mari" },
					{ source: "stdout", startOffset: 4, text: "gold9" },
				],
				SECRETS,
			).ranges,
		).toEqual([{ source: "stdout", startOffset: 0, endOffset: 9 }]);
	});

	it("maps only contributing prefixes across stdout and stderr", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[
					{ source: "stdout", startOffset: 10, text: "mariX" },
					{ source: "stderr", startOffset: 3, text: "gold9" },
				],
				SECRETS,
			).ranges,
		).toEqual([
			{ source: "stderr", startOffset: 3, endOffset: 8 },
			{ source: "stdout", startOffset: 10, endOffset: 14 },
		]);
	});

	it("tracks a secret split across more than two ordered fragments", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[
					{ source: "stdout", startOffset: 0, text: "ma!" },
					{ source: "stderr", startOffset: 20, text: "ri?" },
					{ source: "stdout", startOffset: 3, text: "gold9" },
				],
				SECRETS,
			).ranges,
		).toEqual([
			{ source: "stderr", startOffset: 20, endOffset: 22 },
			{ source: "stdout", startOffset: 0, endOffset: 2 },
			{ source: "stdout", startOffset: 3, endOffset: 8 },
		]);
	});

	it("does not skip an unrelated fragment or taint later safe output", () => {
		const fragments: SecretFragment[] = [
			{ source: "stdout", startOffset: 0, text: "mari" },
			{ source: "stderr", startOffset: 0, text: "zzzzzz" },
			{ source: "stdout", startOffset: 4, text: "gold9" },
			{ source: "stderr", startOffset: 8, text: "later-safe" },
		];
		expect(
			locateConfiguredSecretFragmentTaint(fragments, SECRETS).ranges,
		).toEqual([]);
	});

	it("is order-sensitive", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[
					{ source: "stderr", startOffset: 0, text: "gold9" },
					{ source: "stdout", startOffset: 0, text: "mari" },
				],
				SECRETS,
			).ranges,
		).toEqual([]);
	});

	it("fails closed for invalid fragments", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[
					{ source: "", startOffset: 0, text: SECRET },
					{ source: "stdout", startOffset: -1, text: SECRET },
					{ source: "stdout", startOffset: 0, text: "short" },
				],
				SECRETS,
			),
		).toEqual({
			status: "incomplete",
			reason: "invalid-input",
			ranges: [],
			maxSecretLength: 9,
		});
	});

	it("fails closed without reconnecting sparse or null fragments", () => {
		const sparse = new Array<SecretFragment>(3);
		sparse[0] = { source: "stdout", startOffset: 0, text: "mari" };
		sparse[2] = { source: "stderr", startOffset: 0, text: "gold9" };

		for (const fragments of [sparse, [null] as unknown as SecretFragment[]]) {
			expect(locateConfiguredSecretFragmentTaint(fragments, SECRETS)).toEqual({
				status: "incomplete",
				reason: "invalid-input",
				ranges: [],
				maxSecretLength: 9,
			});
		}
	});

	it("fails closed when absolute source ranges cannot remain safe integers", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[
					{
						source: "stdout",
						startOffset: Number.MAX_SAFE_INTEGER - 2,
						text: SECRET,
					},
				],
				SECRETS,
			),
		).toMatchObject({
			status: "incomplete",
			reason: "invalid-input",
			ranges: [],
		});
	});

	it("ignores configured values below the core floor", () => {
		expect(
			locateConfiguredSecretFragmentTaint(
				[{ source: "stdout", startOffset: 0, text: "short" }],
				{ SHORT: "short" },
			),
		).toEqual({ status: "complete", ranges: [], maxSecretLength: 0 });
	});

	it("bounds repeated-substring work without recursive expansion", () => {
		const fragments = Array.from({ length: 32 }, (_, index) => ({
			source: index % 2 === 0 ? "stdout" : "stderr",
			startOffset: index * 64,
			text: "a".repeat(64),
		}));
		const startedAt = performance.now();
		const result = locateConfiguredSecretFragmentTaint(fragments, {
			TOKEN: "a".repeat(16),
		});

		expect(result.status).toBe("complete");
		expect(result.ranges.length).toBeGreaterThan(0);
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});

	it("reports resource exhaustion explicitly", () => {
		const fragments = Array.from({ length: 257 }, (_, index) => ({
			source: "stdout",
			startOffset: index,
			text: "a",
		}));
		expect(
			locateConfiguredSecretFragmentTaint(fragments, SECRETS),
		).toMatchObject({
			status: "incomplete",
			reason: "resource-limit",
			ranges: [],
			maxSecretLength: 9,
		});
	});

	it("short-circuits an empty eligible profile before fragment limits", () => {
		const fragments = Array.from({ length: 257 }, (_, index) => ({
			source: "stdout",
			startOffset: index,
			text: "x",
		}));
		expect(
			locateConfiguredSecretFragmentTaint(fragments, { SHORT: "short" }),
		).toEqual({ status: "complete", ranges: [], maxSecretLength: 0 });
	});

	it("returns an opaque revision that changes with the eligible profile", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "fragment-redaction-runtime",
				settings: { secrets: { SERVICE_TOKEN: SECRET } },
			} as Character,
		});
		const exhausted = runtime.locateConfiguredSecretFragmentTaint(
			Array.from({ length: 257 }, (_, index) => ({
				source: "stdout",
				startOffset: index,
				text: "x",
			})),
		);
		expect(exhausted).toMatchObject({
			status: "incomplete",
			reason: "resource-limit",
			maxSecretLength: SECRET.length,
		});
		expect(JSON.stringify(exhausted)).not.toContain(SECRET);

		const firstRevision = exhausted.profileRevision;
		runtime.character.settings = {
			secrets: { SERVICE_TOKEN: "violet73x" },
		};
		const rotated = runtime.locateConfiguredSecretFragmentTaint([]);
		expect(rotated.profileRevision).toBeGreaterThan(firstRevision);
		expect(JSON.stringify(rotated)).not.toContain("violet73x");
	});

	it("does not mutate inputs or return configured secret values", () => {
		const fragments = [
			{ source: "stdout", startOffset: 0, text: "mariX" },
			{ source: "stderr", startOffset: 0, text: "gold9" },
		] as const;
		const snapshot = structuredClone(fragments);
		const result = locateConfiguredSecretFragmentTaint(fragments, SECRETS);

		expect(fragments).toEqual(snapshot);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});
