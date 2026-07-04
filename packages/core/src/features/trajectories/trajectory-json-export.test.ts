/**
 * Unit coverage for the v5 context-object trajectory export
 * (`buildContextObjectTrajectoryExport` / `serializeContextObjectTrajectoryExport`):
 * v5 context events serialize straight to JSON with no legacy conversion, and
 * undefined metadata values are dropped. Deterministic — plain in-memory objects,
 * no runtime or database.
 */
import { describe, expect, it } from "vitest";
import {
	buildContextObjectTrajectoryExport,
	serializeContextObjectTrajectoryExport,
} from "../../trajectory-utils";
import type { ContextEvent, ContextObject } from "../../types/context-object";

describe("context object trajectory JSON export", () => {
	it("serializes v5 context events as JSON without legacy conversion", () => {
		const event: ContextEvent = {
			id: "evt-1",
			type: "message",
			createdAt: 123,
			message: {
				role: "user",
				content: "hello",
			},
		};
		const contextObject: ContextObject = {
			id: "ctx-1",
			version: "v5",
			createdAt: 123,
			events: [event],
		};

		const exported = buildContextObjectTrajectoryExport({
			contextObject,
			trajectoryId: "traj-1",
			agentId: "agent-1",
			metadata: { source: "chat", unsafeUndefined: undefined },
		});

		expect(exported).toMatchObject({
			contextObjectVersion: 5,
			trajectoryId: "traj-1",
			agentId: "agent-1",
			contextObjectId: "ctx-1",
			events: [event],
			metadata: { source: "chat" },
		});

		const serialized = serializeContextObjectTrajectoryExport({
			contextObject,
			trajectoryId: "traj-1",
		});
		expect(JSON.parse(serialized)).toEqual(
			expect.objectContaining({
				contextObjectVersion: 5,
				events: [event],
			}),
		);
		expect(serialized).not.toContain("legacy structured output");
	});
});
