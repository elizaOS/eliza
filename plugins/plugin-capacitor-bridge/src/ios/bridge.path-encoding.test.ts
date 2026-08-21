/**
 * Malformed percent-encoding in a path component must produce a 400, not an
 * exception escaping the request.
 *
 * `bridge.transcripts.encoding.test.ts` already pins this for
 * `/api/transcripts/:id`. Nothing wraps the bridge's route dispatch, so every
 * other path parameter needs the same guard: an unguarded
 * `decodeURIComponent` throws `URIError` straight out of the request.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	fetchBackendStream,
	handleDirectCoreRoute,
	type IosBridgeBackend,
	type StreamEmitFrame,
} from "./bridge.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

/** The tokens the transcripts encoding suite already treats as malformed. */
const MALFORMED = ["%", "%2", "%ZZ", "%E0%A4"] as const;

function makeBackend(): IosBridgeBackend {
	return {
		runtime: {
			agentId: AGENT_ID,
			character: { name: "TestAgent" },
			async getMemories() {
				return [];
			},
			async getMemoryById() {
				return null;
			},
			async createMemory() {
				return AGENT_ID;
			},
			async deleteMemory() {},
			async updateMemory() {
				return true;
			},
		} as unknown as IAgentRuntime,
		dispatchRoute: async () => null,
		conversations: new Map(),
		close: async () => {},
	};
}

describe("iOS bridge — malformed path-component encoding", () => {
	it.each(MALFORMED)(
		"browser-workspace tab id %s is rejected with 400",
		async (token) => {
			const res = await handleDirectCoreRoute(
				makeBackend(),
				"DELETE",
				`/api/browser-workspace/tabs/${token}`,
				{},
			);
			expect(res?.status).toBe(400);
			expect(JSON.parse(res?.body ?? "{}")).toMatchObject({
				error: expect.stringMatching(/malformed URL encoding/),
			});
		},
	);

	it.each(MALFORMED)(
		"conversation message id %s is rejected with 400",
		async (token) => {
			const res = await handleDirectCoreRoute(
				makeBackend(),
				"POST",
				`/api/conversations/${token}/messages`,
				{},
			);
			expect(res?.status).toBe(400);
		},
	);

	it.each(MALFORMED)(
		"buffered conversation stream id %s is rejected with 400",
		async (token) => {
			const res = await handleDirectCoreRoute(
				makeBackend(),
				"POST",
				`/api/conversations/${token}/messages/stream`,
				{},
			);
			expect(res?.status).toBe(400);
		},
	);

	it.each(MALFORMED)(
		"local-inference verify model id %s is rejected with 400",
		async (token) => {
			const res = await handleDirectCoreRoute(
				makeBackend(),
				"POST",
				`/api/local-inference/installed/${token}/verify`,
				{},
			);
			expect(res?.status).toBe(400);
		},
	);

	it.each(MALFORMED)(
		"streaming conversation id %s emits a 400 rather than throwing",
		async (token) => {
			const events: StreamEmitFrame[] = [];
			const result = await fetchBackendStream(
				makeBackend(),
				{ path: `/api/conversations/${token}/messages/stream`, method: "POST" },
				"stream-1",
				async (event: StreamEmitFrame) => {
					events.push(event);
				},
			);
			expect(result).toEqual({ streamId: "stream-1", done: true });
			const response = events.find((e) => e.kind === "response");
			expect(response).toMatchObject({ status: 400 });
			// The stream must still be closed out, not abandoned mid-flight.
			expect(events.some((e) => e.kind === "complete")).toBe(true);
		},
	);

	it("a canonical percent-encoded id still reaches its route", async () => {
		// %2D is a well-formed encoding of "-": it must decode, not 400.
		const res = await handleDirectCoreRoute(
			makeBackend(),
			"DELETE",
			"/api/browser-workspace/tabs/btab%2Dmissing",
			{},
		);
		expect(res?.status).toBe(404);
	});
});
