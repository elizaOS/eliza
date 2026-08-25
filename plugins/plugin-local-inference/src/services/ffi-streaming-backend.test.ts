/** Verifies the FFI boundary reconstructs guided sampled tails into complete logical responses for every downstream consumer. */
import type { ResponseSkeleton } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	type FfiBackendSession,
	FfiStreamingBackend,
} from "./ffi-streaming-backend";
import type { FfiStreamingGenerateArgs } from "./ffi-streaming-runner";
import { elizaHarnessSchemaFromSkeleton } from "./structured-output";

const skeleton: ResponseSkeleton = {
	id: "ffi-prefix-proof",
	spans: [
		{ kind: "literal", value: '{"shouldRespond":"' },
		{
			kind: "enum",
			key: "shouldRespond",
			enumValues: ["RESPOND", "IGNORE"],
		},
		{ kind: "literal", value: '","replyText":"' },
		{ kind: "free-string", key: "replyText" },
		{ kind: "literal", value: '"}' },
	],
};

describe("FfiStreamingBackend guided output reconstruction", () => {
	it("prepends the omitted deterministic run to streamed chunks and final text exactly once", async () => {
		const sampledChunks = ["RESP", 'OND","replyText":"Hel', 'lo"}'];
		const sampledTail = sampledChunks.join("");
		let nativeArgs: FfiStreamingGenerateArgs | undefined;
		const backend = new FfiStreamingBackend({
			supported: () => true,
			acquire: async () => {
				throw new Error("test injects the acquired session");
			},
			release: async () => {},
		});
		const session = {
			binding: {},
			ctx: 1n,
			runner: {
				generateWithUsage: async (args: FfiStreamingGenerateArgs) => {
					nativeArgs = args;
					for (const chunk of sampledChunks) await args.onTextChunk?.(chunk);
					return {
						text: sampledTail,
						slotId: 7,
						firstTokenMs: 1,
						drafted: 0,
						accepted: 5,
					};
				},
			},
			tokenize: () => new Int32Array([1, 2, 3]),
			mtp: null,
			draftModelPath: null,
			mmprojPath: null,
			loadConfig: null,
		} as unknown as FfiBackendSession;
		(
			backend as unknown as {
				session: FfiBackendSession;
			}
		).session = session;

		const streamed: string[] = [];
		const result = await backend.generateWithUsage({
			prompt: "reply",
			maxTokens: 64,
			responseSkeleton: skeleton,
			elizaSchema: elizaHarnessSchemaFromSkeleton({ skeleton }),
			onTextChunk: (chunk) => streamed.push(chunk),
		});

		const expected = `{"shouldRespond":"${sampledTail}`;
		expect(streamed.join("")).toBe(expected);
		expect(streamed[0]).toBe('{"shouldRespond":"');
		expect(result.text).toBe(expected);
		expect(nativeArgs?.gbnfGrammar?.split("\n")[0]).not.toContain(
			'"{\\"shouldRespond\\":\\""',
		);
	});

	it("leaves ordinary unprefilled generations byte-identical", async () => {
		const backend = new FfiStreamingBackend({
			supported: () => true,
			acquire: async () => {
				throw new Error("test injects the acquired session");
			},
			release: async () => {},
		});
		(
			backend as unknown as {
				session: FfiBackendSession;
			}
		).session = {
			runner: {
				generateWithUsage: async () => ({
					text: "plain reply",
					slotId: 2,
					firstTokenMs: 1,
					drafted: 0,
					accepted: 2,
				}),
			},
			tokenize: () => new Int32Array([1]),
			mtp: null,
			draftModelPath: null,
			mmprojPath: null,
			loadConfig: null,
		} as unknown as FfiBackendSession;

		await expect(
			backend.generate({ prompt: "reply", maxTokens: 64 }),
		).resolves.toBe("plain reply");
	});

	it("rejects output that reaches the native decode boundary", async () => {
		const backend = new FfiStreamingBackend({
			supported: () => true,
			acquire: async () => {
				throw new Error("test injects the acquired session");
			},
			release: async () => {},
		});
		(backend as unknown as { session: FfiBackendSession }).session = {
			runner: {
				generateWithUsage: async () => ({
					text: "partial",
					slotId: 2,
					firstTokenMs: 1,
					drafted: 0,
					accepted: 8,
				}),
			},
			tokenize: () => new Int32Array([1]),
			mtp: null,
			draftModelPath: null,
			mmprojPath: null,
			loadConfig: { contextSize: 9 },
		} as unknown as FfiBackendSession;

		await expect(backend.generate({ prompt: "reply" })).rejects.toMatchObject({
			code: "MODEL_OUTPUT_INCOMPLETE",
		});
	});
});
