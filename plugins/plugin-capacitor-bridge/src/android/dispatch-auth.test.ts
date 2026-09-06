import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import {
	dispatchBufferedRequest,
	dispatchStreamingRequest,
} from "./dispatch.ts";

it("requires the native bearer for buffered and streaming socket requests", async () => {
	const oldRequired = process.env.ELIZA_REQUIRE_LOCAL_AUTH;
	const oldToken = process.env.ELIZA_API_TOKEN;
	process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
	process.env.ELIZA_API_TOKEN = "native-test-token";
	let calls = 0;
	const dispatch = async () => {
		calls++;
		return { status: 200, body: { ok: true } };
	};
	const runtime = {} as IAgentRuntime;
	try {
		for (const headers of [{}, { authorization: "Bearer wrong" }]) {
			const response = await dispatchBufferedRequest(runtime, dispatch, {
				path: "/api/health",
				headers,
			});
			expect(response.status).toBe(401);
			const heads: number[] = [];
			await dispatchStreamingRequest(
				runtime,
				dispatch,
				{ path: "/api/health", headers },
				{
					emitResponse(response) {
						heads.push(response.status);
					},
					emitChunk() {},
				},
			);
			expect(heads).toEqual([401]);
		}
		expect(calls).toBe(0);
		const response = await dispatchBufferedRequest(runtime, dispatch, {
			path: "/v1/chat/completions",
			method: "POST",
			headers: { Authorization: "Bearer native-test-token" },
		});
		expect(response.status).toBe(200);
		expect(calls).toBe(1);
		delete process.env.ELIZA_API_TOKEN;
		expect(
			(
				await dispatchBufferedRequest(runtime, dispatch, {
					path: "/api/health",
				})
			).status,
		).toBe(401);
	} finally {
		if (oldRequired === undefined) delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
		else process.env.ELIZA_REQUIRE_LOCAL_AUTH = oldRequired;
		if (oldToken === undefined) delete process.env.ELIZA_API_TOKEN;
		else process.env.ELIZA_API_TOKEN = oldToken;
	}
});
