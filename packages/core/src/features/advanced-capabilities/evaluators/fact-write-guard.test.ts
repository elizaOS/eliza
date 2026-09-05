/**
 * Unit contract for the deferred fact write guard: baseline stamps, last-write
 * detection, and the stale-write skip. Fake runtime, no database.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import {
	factLastWriteMs,
	factWriteNowIso,
	factWriteNowMs,
	loadFactForWrite,
} from "./fact-write-guard.ts";

const FACT_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;
const BASELINE_MS = Date.parse("2026-09-05T18:00:00.000Z");

function fact(overrides: Partial<Memory> = {}): Memory {
	return {
		id: FACT_ID,
		entityId: "00000000-0000-0000-0000-0000000000e1" as UUID,
		agentId: "00000000-0000-0000-0000-0000000000a1" as UUID,
		roomId: "00000000-0000-0000-0000-0000000000c1" as UUID,
		content: { text: "prefers tea" },
		metadata: { type: "custom" },
		createdAt: Date.parse("2026-09-05T17:00:00.000Z"),
		...overrides,
	} as Memory;
}

function runtimeReturning(current: Memory | null) {
	const getMemoryById = vi.fn(async () => current);
	return {
		runtime: { getMemoryById } as unknown as IAgentRuntime,
		getMemoryById,
	};
}

describe("fact write guard", () => {
	it("reports the newest of creation, confirmation, and guarded update", () => {
		expect(factLastWriteMs(fact())).toBe(
			Date.parse("2026-09-05T17:00:00.000Z"),
		);
		expect(
			factLastWriteMs(
				fact({
					metadata: {
						type: "custom",
						lastConfirmedAt: "2026-09-05T17:30:00.000Z",
						updatedAt: "2026-09-05T17:45:00.000Z",
					},
				}),
			),
		).toBe(Date.parse("2026-09-05T17:45:00.000Z"));
		expect(
			factLastWriteMs(
				fact({ metadata: { type: "custom", updatedAt: "junk" } }),
			),
		).toBe(Date.parse("2026-09-05T17:00:00.000Z"));
	});

	it("stamps with the baseline when one is set and with now otherwise", () => {
		expect(factWriteNowMs({ baselineMs: BASELINE_MS })).toBe(BASELINE_MS);
		expect(factWriteNowIso({ baselineMs: BASELINE_MS })).toBe(
			"2026-09-05T18:00:00.000Z",
		);
		const before = Date.now();
		const now = factWriteNowMs(undefined);
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
	});

	it("returns the snapshot without a read when no baseline is set", async () => {
		const { runtime, getMemoryById } = runtimeReturning(null);
		const snapshot = fact();
		expect(await loadFactForWrite(runtime, snapshot, undefined, "t")).toBe(
			snapshot,
		);
		expect(await loadFactForWrite(runtime, snapshot, {}, "t")).toBe(snapshot);
		expect(getMemoryById).not.toHaveBeenCalled();
	});

	it("re-reads and returns the current fact when nothing newer was written", async () => {
		const current = fact({
			metadata: { type: "custom", lastConfirmedAt: "2026-09-05T17:30:00.000Z" },
		});
		const { runtime, getMemoryById } = runtimeReturning(current);
		expect(
			await loadFactForWrite(runtime, fact(), { baselineMs: BASELINE_MS }, "t"),
		).toBe(current);
		expect(getMemoryById).toHaveBeenCalledWith(FACT_ID);
	});

	it("skips a fact a later turn rewrote after the baseline", async () => {
		const newer = fact({
			metadata: { type: "custom", lastConfirmedAt: "2026-09-05T18:00:05.000Z" },
		});
		const { runtime } = runtimeReturning(newer);
		expect(
			await loadFactForWrite(runtime, fact(), { baselineMs: BASELINE_MS }, "t"),
		).toBeNull();
		const recreated = fact({ createdAt: BASELINE_MS + 1 });
		expect(
			await loadFactForWrite(
				runtimeReturning(recreated).runtime,
				fact(),
				{ baselineMs: BASELINE_MS },
				"t",
			),
		).toBeNull();
	});

	it("skips a fact that no longer exists", async () => {
		const { runtime } = runtimeReturning(null);
		expect(
			await loadFactForWrite(runtime, fact(), { baselineMs: BASELINE_MS }, "t"),
		).toBeNull();
		expect(
			await loadFactForWrite(
				runtime,
				fact({ id: undefined }),
				{ baselineMs: BASELINE_MS },
				"t",
			),
		).toBeNull();
	});
});
