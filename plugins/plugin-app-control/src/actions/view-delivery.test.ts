/**
 * Unit tests for view-delivery: validates client id validation and realtime voice turn detection.
 */

import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	isRealtimeVoiceTurn,
	readViewInteractionClientId,
} from "./view-delivery.ts";

describe("view-delivery", () => {
	const baseMemory: Memory = {
		id: "m1" as any,
		roomId: "r1" as any,
		entityId: "e1" as any,
		agentId: "a1" as any,
		content: { text: "msg" },
		createdAt: Date.now(),
	};

	it("extracts valid viewClientId from metadata", () => {
		const memory: Memory = {
			...baseMemory,
			content: {
				text: "msg",
				metadata: { viewClientId: "client_123.abc" },
			},
		};
		expect(readViewInteractionClientId(memory)).toBe("client_123.abc");
	});

	it("returns undefined for invalid or missing viewClientId", () => {
		expect(readViewInteractionClientId(baseMemory)).toBeUndefined();

		const invalidMemory: Memory = {
			...baseMemory,
			content: {
				text: "msg",
				metadata: { viewClientId: "invalid space in id" },
			},
		};
		expect(readViewInteractionClientId(invalidMemory)).toBeUndefined();
	});

	it("detects realtime voice turns", () => {
		expect(isRealtimeVoiceTurn(baseMemory)).toBe(false);

		const voiceMemory: Memory = {
			...baseMemory,
			content: {
				text: "msg",
				metadata: { clientTransport: "realtime_voice" },
			},
		};
		expect(isRealtimeVoiceTurn(voiceMemory)).toBe(true);
	});
});
