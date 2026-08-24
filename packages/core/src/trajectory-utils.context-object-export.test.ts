/**
 * Deterministic coverage for the context-object trajectory export family in
 * trajectory-utils: extraction of a context object/events from raw recorded
 * trajectories, the v5 export envelope builder (field precedence, optional-key
 * inclusion, JSON sanitization), and its serialization. These functions are the
 * consumer boundary for CONTEXT_OBJECT_TRAJECTORY_VERSION from
 * features/trajectories/types.
 */
import { describe, expect, it } from "vitest";
import { CONTEXT_OBJECT_TRAJECTORY_VERSION } from "./features/trajectories/types.ts";
import {
	buildContextObjectTrajectoryExport,
	extractContextEventsFromTrajectory,
	extractContextObjectFromTrajectory,
	serializeContextObjectTrajectoryExport,
} from "./trajectory-utils.ts";

const event = { seq: 1, kind: "message", text: "hello" } as const;

describe("extractContextObjectFromTrajectory", () => {
	it("returns null for non-object trajectories", () => {
		expect(extractContextObjectFromTrajectory(null)).toBeNull();
		expect(extractContextObjectFromTrajectory(undefined)).toBeNull();
		expect(extractContextObjectFromTrajectory("trajectory")).toBeNull();
		expect(extractContextObjectFromTrajectory(42)).toBeNull();
		expect(extractContextObjectFromTrajectory([1, 2])).toBeNull();
	});

	it("reads a direct contextObject carrying an events array", () => {
		const result = extractContextObjectFromTrajectory({
			contextObject: { id: "ctx-1", version: "v5", events: [event] },
		});
		expect(result).toEqual({
			id: "ctx-1",
			version: "v5",
			events: [event],
		});
	});

	it("falls back to metadata.contextObject when absent at the top level", () => {
		const result = extractContextObjectFromTrajectory({
			metadata: { contextObject: { id: "ctx-2", events: [event] } },
		});
		expect(result?.id).toBe("ctx-2");
		expect(result?.events).toEqual([event]);
	});

	it("defaults a blank id to context-object and a non-string version to v5", () => {
		expect(
			extractContextObjectFromTrajectory({
				contextObject: { id: "   ", version: 5, events: [event] },
			}),
		).toEqual({
			id: "context-object",
			version: "v5",
			events: [event],
		});
	});

	it("returns null when the context object carries no events array", () => {
		expect(
			extractContextObjectFromTrajectory({
				contextObject: { id: "ctx-3" },
			}),
		).toBeNull();
	});
});

describe("extractContextEventsFromTrajectory", () => {
	it("prefers the nested contextObject events over top-level events", () => {
		const nested = { seq: 0, kind: "nested" } as const;
		const events = extractContextEventsFromTrajectory({
			contextObject: { id: "ctx", events: [nested] },
			events: [event],
		});
		expect(events).toEqual([nested]);
	});

	it("falls back to top-level events and then metadata.contextEvents", () => {
		expect(extractContextEventsFromTrajectory({ events: [event] })).toEqual([
			event,
		]);
		expect(
			extractContextEventsFromTrajectory({
				metadata: { contextEvents: [event] },
			}),
		).toEqual([event]);
	});

	it("returns top-level events without consulting the envelope version stamp", () => {
		expect(
			extractContextEventsFromTrajectory({
				contextObjectVersion: CONTEXT_OBJECT_TRAJECTORY_VERSION,
				events: [event],
			}),
		).toEqual([event]);
		expect(
			extractContextEventsFromTrajectory({
				contextObjectVersion: CONTEXT_OBJECT_TRAJECTORY_VERSION - 1,
				events: [event],
			}),
		).toEqual([event]);
	});

	it("returns null when no event source exists", () => {
		expect(extractContextEventsFromTrajectory({})).toBeNull();
		expect(extractContextEventsFromTrajectory(null)).toBeNull();
	});
});

describe("buildContextObjectTrajectoryExport", () => {
	it("stamps every export with the canonical context-object trajectory version", () => {
		const built = buildContextObjectTrajectoryExport({});
		expect(built.contextObjectVersion).toBe(CONTEXT_OBJECT_TRAJECTORY_VERSION);
		expect(built.contextObjectVersion).toBe(5);
	});

	it("emits only version, events, and the always-present metadata for minimal input", () => {
		const built = buildContextObjectTrajectoryExport({});
		expect(Object.keys(built)).toEqual([
			"contextObjectVersion",
			"events",
			"metadata",
		]);
		expect(built.events).toEqual([]);
		expect(built.metadata).toEqual({});
	});

	it("gives explicit input fields precedence over trajectory- and metadata-derived values", () => {
		const built = buildContextObjectTrajectoryExport({
			trajectoryId: "explicit-trajectory",
			agentId: "explicit-agent",
			contextObjectId: "explicit-context",
			createdAt: 100,
			source: "explicit-source",
			trajectory: {
				trajectoryId: "derived-trajectory",
				agentId: "derived-agent",
				metadata: {
					source: "derived-source",
					createdAt: 200,
					contextObjectId: "derived-context",
				},
			},
			contextObject: { id: "derived-context", createdAt: 300, events: [] },
		});
		expect(built.trajectoryId).toBe("explicit-trajectory");
		expect(built.agentId).toBe("explicit-agent");
		expect(built.contextObjectId).toBe("explicit-context");
		expect(built.createdAt).toBe(100);
		expect(built.source).toBe("explicit-source");
	});

	it("never derives source from the trajectory's own source field, only from metadata", () => {
		const built = buildContextObjectTrajectoryExport({
			trajectory: { source: "telegram" },
		});
		expect(built.source).toBeUndefined();
		expect("source" in built).toBe(false);
	});

	it("derives identity fields from the trajectory and its metadata when not given", () => {
		const built = buildContextObjectTrajectoryExport({
			trajectory: {
				trajectoryId: "traj-1",
				agentId: "agent-1",
				source: "telegram",
				metadata: {
					contextObjectId: "ctx-from-metadata",
					createdAt: 555,
					source: "metadata-source",
				},
			},
		});
		expect(built.trajectoryId).toBe("traj-1");
		expect(built.agentId).toBe("agent-1");
		expect(built.source).toBe("metadata-source");
		expect(built.contextObjectId).toBe("ctx-from-metadata");
		expect(built.createdAt).toBe(555);
	});

	it("sanitizes metadata to JSON: dates become ISO strings, bigints become strings, non-JSON values drop", () => {
		const built = buildContextObjectTrajectoryExport({
			trajectory: {
				metadata: {
					at: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
					count: 3n,
					run: () => "side effect",
					note: "kept",
				},
			},
		});
		expect(built.metadata).toEqual({
			at: "2026-01-02T03:04:05.000Z",
			count: "3",
			note: "kept",
		});
	});

	it("sanitizes event payloads, mapping NaN to null and trimming cycles at the back-edge", () => {
		const cyclic: Record<string, unknown> = { label: "cycle" };
		cyclic.self = cyclic;
		const built = buildContextObjectTrajectoryExport({
			events: [{ ...event, ratio: Number.NaN, ref: cyclic }],
		});
		expect(built.events).toEqual([
			{
				seq: 1,
				kind: "message",
				text: "hello",
				ratio: null,
				ref: { label: "cycle" },
			},
		]);
	});

	it("normalizes a blank context-object id through extraction before building the export", () => {
		const built = buildContextObjectTrajectoryExport({
			trajectory: {
				contextObject: {
					id: "   ",
					version: 9,
					events: [event],
					createdAt: 42,
				},
			},
		});
		expect(built.contextObject).toBeDefined();
		expect(built.contextObject?.id).toBe("context-object");
		expect(built.contextObject?.version).toBe("v5");
		expect(built.contextObject?.createdAt).toBe(42);
		expect(built.contextObjectId).toBe("context-object");
		expect(built.createdAt).toBe(42);
	});

	it("takes metrics from input.metrics before trajectory.metrics and sanitizes them", () => {
		const fromInput = buildContextObjectTrajectoryExport({
			metrics: { tokens: 10 },
			trajectory: { metrics: { tokens: 999 } },
		});
		expect(fromInput.metrics).toEqual({ tokens: 10 });

		const fromTrajectory = buildContextObjectTrajectoryExport({
			trajectory: { metrics: { latencyMs: 12n } },
		});
		expect(fromTrajectory.metrics).toEqual({ latencyMs: "12" });
	});
});

describe("serializeContextObjectTrajectoryExport", () => {
	it("round-trips the built export through JSON with indentation", () => {
		const input = {
			trajectoryId: "traj-ser",
			events: [event],
			contextObject: { id: "ctx-ser", events: [event] },
		};
		const serialized = serializeContextObjectTrajectoryExport(input, 2);
		expect(serialized.split("\n")[0]).toBe("{");
		expect(JSON.parse(serialized)).toEqual(
			buildContextObjectTrajectoryExport(input),
		);
	});
});
