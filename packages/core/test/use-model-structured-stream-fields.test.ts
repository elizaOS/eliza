/** A structured useModel call streams only its declared user-visible field, behind its gate, one revision per attempt. */

import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import {
	ModelType,
	type ResponseSkeleton,
	type StructuredStreamGate,
	type TextStreamResult,
} from "../src/types/model";

/** Stage-1 shape: replyText is a free string, or a parts array (free JSON). */
const skeletonWith = (
	replyKind: "free-string" | "free-json",
): ResponseSkeleton => ({
	spans: [
		{ kind: "literal", value: '{"shouldRespond":' },
		{ kind: "enum", key: "shouldRespond", enumValues: ["RESPOND", "IGNORE"] },
		{ kind: "literal", value: ',"contexts":' },
		{ kind: "free-json", key: "contexts" },
		{ kind: "literal", value: ',"intents":' },
		{ kind: "free-json", key: "intents" },
		{ kind: "literal", value: ',"replyText":' },
		{ kind: replyKind, key: "replyText" },
		{ kind: "literal", value: ',"facts":' },
		{ kind: "free-json", key: "facts" },
		{ kind: "literal", value: "}" },
	],
});

const directReply: StructuredStreamGate = (preceding) =>
	preceding?.shouldRespond === "RESPOND" &&
	Array.isArray(preceding.intents) &&
	preceding.intents.length === 0;

let runtime: ReturnType<typeof createSQLiteTestRuntime> | undefined;
afterEach(async () => {
	await runtime?.stop();
	runtime = undefined;
});

/** Streams each envelope in 7-character pieces, as a provider would. */
function setup(envelopes: string[]) {
	runtime = createSQLiteTestRuntime({
		character: { name: "StructuredStream", bio: "stream field contract" },
		logLevel: "fatal",
	});
	const handlerParams: Record<string, unknown>[] = [];
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params): Promise<TextStreamResult> => {
			handlerParams.push({ ...(params as Record<string, unknown>) });
			const envelope = envelopes[handlerParams.length - 1] ?? "";
			return {
				text: Promise.resolve(envelope),
				textStream: (async function* () {
					for (let index = 0; index < envelope.length; index += 7) {
						yield envelope.slice(index, index + 7);
					}
				})(),
				finishReason: Promise.resolve("stop"),
				usage: Promise.resolve(undefined),
			};
		},
		"scripted-stream",
		100,
	);
	const chunks: { chunk: string; accumulated?: string; revision?: number }[] =
		[];
	const gateInputs: unknown[] = [];
	const call = (overrides: Record<string, unknown> = {}) =>
		runtime?.useModel(ModelType.TEXT_LARGE, {
			prompt: "reply",
			streamStructured: true,
			responseSkeleton: skeletonWith("free-string"),
			streamFields: [{ field: "replyText", partKinds: ["text"] }],
			streamFieldGate: (preceding) => {
				gateInputs.push(preceding);
				return directReply(preceding);
			},
			onStreamChunk: (chunk, _messageId, accumulated, revision) => {
				chunks.push({ chunk, accumulated, revision });
			},
			...overrides,
		});
	return { call, chunks, gateInputs, handlerParams };
}

const reply = "Paris is the capital of France. It sits on the Seine.";
const plainEnvelope = JSON.stringify({
	shouldRespond: "RESPOND",
	contexts: ["simple"],
	intents: [],
	replyText: reply,
	facts: ["the user asked about Paris"],
	// A later nested key with the stream field's name is not the reply.
	relationships: [{ subject: "user", replyText: "INTERNAL NOTE" }],
});

it("streams a direct plain reply incrementally and nothing else", async () => {
	const { call, chunks, gateInputs, handlerParams } = setup([plainEnvelope]);
	await call();

	expect(chunks.length).toBeGreaterThan(3);
	const accumulations = chunks.map((entry) => entry.accumulated ?? "");
	for (const [index, accumulated] of accumulations.entries()) {
		expect(reply.startsWith(accumulated)).toBe(true);
		if (index > 0) {
			expect(accumulated.length).toBeGreaterThan(
				accumulations[index - 1]?.length ?? 0,
			);
		}
	}
	expect(chunks.map((entry) => entry.chunk).join("")).toBe(reply);
	expect(accumulations.at(-1)).toBe(reply);
	expect(new Set(chunks.map((entry) => entry.revision)).size).toBe(1);
	// Routing fields reach only the gate, never the stream.
	expect(gateInputs).toEqual([
		{ shouldRespond: "RESPOND", contexts: ["simple"], intents: [] },
	]);
	for (const { chunk } of chunks) {
		expect(chunk).not.toMatch(
			/shouldRespond|contexts|intents|facts|INTERNAL|[{}"]/,
		);
	}
	// The stream contract is runtime-only.
	expect(handlerParams[0]).not.toHaveProperty("streamFields");
	expect(handlerParams[0]).not.toHaveProperty("streamFieldGate");
});

it("holds a reply whose preceding routing plans work", async () => {
	const { call, chunks } = setup([
		JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["calendar"],
			intents: ["create the meeting"],
			replyText: "On it.",
			facts: [],
		}),
	]);
	await call();
	expect(chunks).toEqual([]);
});

it("streams only text parts and stops at a source part", async () => {
	const { call, chunks } = setup([
		JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			intents: [],
			replyText: [
				{ kind: "text", value: "You wrote: " },
				{ kind: "source", id: "message-1" },
				{ kind: "text", value: "never streamed" },
			],
			facts: [],
		}),
	]);
	await call({ responseSkeleton: skeletonWith("free-json") });
	expect(chunks.map((entry) => entry.chunk).join("")).toBe("You wrote: ");
});

it("streams nothing without declared stream fields", async () => {
	const { call, chunks } = setup([plainEnvelope]);
	await call({ streamFields: undefined, streamFieldGate: undefined });
	expect(chunks).toEqual([]);
});

it("gives each attempt its own increasing stream revision", async () => {
	const retried = "Paris.";
	const { call, chunks } = setup([
		plainEnvelope,
		JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			intents: [],
			replyText: retried,
			facts: [],
		}),
	]);
	await call();
	await call();
	const revisions = [...new Set(chunks.map((entry) => entry.revision))];
	expect(revisions).toHaveLength(2);
	expect(revisions[1]).toBeGreaterThan(revisions[0] ?? Infinity);
	const second = chunks.filter((entry) => entry.revision === revisions[1]);
	expect(second.at(-1)?.accumulated).toBe(retried);
});
