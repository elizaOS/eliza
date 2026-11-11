import { describe, expect, it } from "vitest";
import {
	buildContextObjectTrajectoryExport,
	serializeContextObjectTrajectoryExport,
} from "../src/trajectory-utils.ts";

describe("trajectory export non-finite numbers", () => {
	it("sanitizes Infinity and -Infinity to null like NaN", () => {
		const exported = buildContextObjectTrajectoryExport({
			trajectory: {
				trajectoryId: "t1",
				metadata: { score: Infinity, neg: -Infinity, nan: NaN, ok: 1 },
			},
		} as never);

		expect(exported.metadata).toEqual({
			score: null,
			neg: null,
			nan: null,
			ok: 1,
		});
	});

	it("sanitizes non-finite numbers inside nested objects and arrays", () => {
		const exported = buildContextObjectTrajectoryExport({
			trajectory: {
				trajectoryId: "t1",
				metadata: { deep: { value: Infinity }, list: [Infinity, 2] },
			},
		} as never);

		expect(exported.metadata).toEqual({
			deep: { value: null },
			list: [null, 2],
		});
	});

	it("keeps the in-memory export equal to its JSON serialization", () => {
		const exported = buildContextObjectTrajectoryExport({
			trajectory: {
				trajectoryId: "t1",
				metadata: { score: Infinity, ok: 1 },
			},
		} as never);

		const serialized = serializeContextObjectTrajectoryExport(exported);
		const parsed = JSON.parse(serialized) as typeof exported;
		expect(parsed.metadata).toEqual(exported.metadata);
	});
});
