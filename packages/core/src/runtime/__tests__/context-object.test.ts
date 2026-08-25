import { describe, expect, it } from "vitest";
import { appendContextEvent, createContextObject } from "../context-object.ts";

describe("createContextObject", () => {
	it("seeds a v5 context with defaults", () => {
		const ctx = createContextObject({ id: "c1" });
		expect(ctx.id).toBe("c1");
		expect(ctx.version).toBe("v5");
		expect(ctx.events).toEqual([]);
	});

	it("passes through options", () => {
		const ctx = createContextObject({
			id: "c1",
			createdAt: 123,
			metadata: { source: "test" },
			staticPrefix: "static",
			trajectoryPrefix: "traj",
			plannedQueue: ["a"],
			metrics: { tokens: 10 },
			limits: { maxEvents: 5 },
			events: [{ id: "e1" } as never],
		});
		expect(ctx.createdAt).toBe(123);
		expect(ctx.metadata).toEqual({ source: "test" });
		expect(ctx.staticPrefix).toBe("static");
		expect(ctx.trajectoryPrefix).toBe("traj");
		expect(ctx.plannedQueue).toEqual(["a"]);
		expect(ctx.metrics).toEqual({ tokens: 10 });
		expect(ctx.events).toEqual([{ id: "e1" }]);
	});
});

describe("appendContextEvent", () => {
	it("returns a copy with the event appended", () => {
		const base = createContextObject({ id: "c1" });
		const event = { id: "e1" } as never;
		const next = appendContextEvent(base, event);
		expect(next.events).toEqual([event]);
		expect(base.events).toEqual([]); // original untouched
		expect(next).not.toBe(base); // immutable copy
	});

	it("appends to existing events", () => {
		const base = createContextObject({
			id: "c1",
			events: [{ id: "a" } as never],
		});
		const next = appendContextEvent(base, { id: "b" } as never);
		expect(next.events).toHaveLength(2);
	});
});
