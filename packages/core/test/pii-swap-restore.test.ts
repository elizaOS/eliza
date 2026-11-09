/**
 * PII swap must hand actions the user's real values back. These cases use the
 * real RegexEntityRecognizer and, for dispatch, a real AgentRuntime with a
 * registered handler that records exactly what a provider would receive.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { RegexEntityRecognizer } from "../src/security/entity-recognizer.ts";
import { PseudonymSession } from "../src/security/pii-pseudonymizer.ts";
import {
	runWithTrajectoryContext,
	type TrajectoryContext,
} from "../src/trajectory-context.ts";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

const ADDRESS = "12 Main Street";
const PROMPT = `Navigate to ${ADDRESS} after lunch.`;

function newSession() {
	return new PseudonymSession({ recognizer: new RegexEntityRecognizer() });
}

describe("PseudonymSession restore", () => {
	it("restores the real address across two learn passes", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const swapped = session.substituteText(PROMPT);
		expect(swapped).not.toContain(ADDRESS);
		await session.learn(swapped);
		expect(session.size).toBe(1);
		const again = session.substituteText(swapped);
		expect(again).toBe(swapped);
		expect(session.restoreText(again)).toBe(PROMPT);
	});

	it("skips a surrogate followed only by punctuation", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const surrogate = session.entries[0].surrogate;
		await session.learn(`Is it ${surrogate}.`);
		expect(session.size).toBe(1);
		expect(session.restoreText(session.substituteText(PROMPT))).toBe(PROMPT);
	});

	it("still masks real text around an echoed surrogate", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const surrogate = session.entries[0].surrogate;
		const echoed = `Ship to ${surrogate} Apt 4`;
		await session.learn(echoed);
		const swapped = session.substituteText(echoed);
		expect(swapped).not.toContain("Apt 4");
		expect(session.restoreText(swapped)).toBe(`Ship to ${ADDRESS} Apt 4`);
	});

	it("restores a surrogate echoed twice to the real address", async () => {
		const session = newSession();
		await session.learn(PROMPT);
		const first = session.substituteText(`Ship to ${ADDRESS} Apt 4`);
		await session.learn(first);
		const second = `Leave at ${session.substituteText(first).slice(8)} Unit 9`;
		await session.learn(second);
		const swapped = session.substituteText(second);
		expect(swapped).not.toContain("Unit 9");
		expect(session.restoreText(swapped)).toBe(
			`Leave at ${ADDRESS} Apt 4 Unit 9`,
		);
	});
});

describe("model dispatch with PII swap", () => {
	const saved = process.env.ELIZA_PII_SWAP_ENABLED;
	afterEach(() => {
		if (saved === undefined) delete process.env.ELIZA_PII_SWAP_ENABLED;
		else process.env.ELIZA_PII_SWAP_ENABLED = saved;
	});

	function makeRuntime() {
		const runtime = createSQLiteTestRuntime({
			character: {
				name: "PiiRestore",
				bio: "test",
				settings: { ELIZA_PII_SWAP_ENABLED: "true" },
			} as Character,
			logLevel: "fatal",
		});
		const received: Record<string, unknown>[] = [];
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				received.push(params as Record<string, unknown>);
				return "ok";
			},
			"pii-restore-provider",
		);
		return { runtime, received };
	}

	it("restores the real address after one model call", async () => {
		const { runtime, received } = makeRuntime();
		const ctx: TrajectoryContext = {};
		await runWithTrajectoryContext(ctx, () =>
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: PROMPT }),
		);
		const wire = String(received[0].prompt);
		expect(wire).not.toContain(ADDRESS);
		expect(ctx.piiSwapSession?.restoreText(wire)).toBe(PROMPT);
	});

	it("masks an address a pre_model hook adds and restores both", async () => {
		const { runtime, received } = makeRuntime();
		const added = " Then stop at 88 Oak Avenue.";
		runtime.registerPipelineHook({
			id: "add-address",
			phase: "pre_model",
			handler: (_runtime, hookCtx) => {
				if (hookCtx.phase !== "pre_model") return;
				const params = hookCtx.params as { prompt: string };
				params.prompt += added;
			},
		});
		const ctx: TrajectoryContext = {};
		await runWithTrajectoryContext(ctx, () =>
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: PROMPT }),
		);
		const wire = String(received[0].prompt);
		expect(wire).not.toContain(ADDRESS);
		expect(wire).not.toContain("88 Oak Avenue");
		expect(ctx.piiSwapSession?.restoreText(wire)).toBe(`${PROMPT}${added}`);
	});

	it("restores the real address when a second call echoes the first surrogate", async () => {
		const { runtime, received } = makeRuntime();
		const ctx: TrajectoryContext = {};
		await runWithTrajectoryContext(ctx, async () => {
			await runtime.useModel(ModelType.TEXT_LARGE, { prompt: PROMPT });
			await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: `Earlier reply: ${String(received[0].prompt)}`,
			});
		});
		const session = ctx.piiSwapSession;
		expect(session?.restoreText(String(received[0].prompt))).toBe(PROMPT);
		expect(session?.restoreText(String(received[1].prompt))).toBe(
			`Earlier reply: ${PROMPT}`,
		);
	});
});

describe("model dispatch secret swap for IMAGE", () => {
	it("swaps a secret in the prompt and leaves input image fields intact", async () => {
		const secret = "fixture-credential-7731-zeta";
		const runtime = createSQLiteTestRuntime({
			character: {
				name: "ImageSwap",
				bio: "test",
				settings: { ELIZA_SECRET_SWAP_ENABLED: "true" },
				secrets: { FIXTURE_TOKEN: secret },
			} as Character,
			logLevel: "fatal",
		});
		let received: Record<string, unknown> | undefined;
		runtime.registerModel(
			ModelType.IMAGE,
			async (_runtime, params) => {
				received = params as Record<string, unknown>;
				return [];
			},
			"image-swap-provider",
		);
		const inputImage = `data:image/png;base64,${Buffer.from(secret).toString("base64")}#${secret}`;
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await runWithTrajectoryContext({}, () =>
			runtime.useModel(ModelType.IMAGE, {
				prompt: `Draw a badge with ${secret} on it`,
				inputImage,
				imageUrl: `https://example.com/${secret}.png`,
				bytes,
			} as never),
		);
		if (!received) throw new Error("image handler was not invoked");
		expect(String(received.prompt)).not.toContain(secret);
		expect(received.inputImage).toBe(inputImage);
		expect(received.imageUrl).toBe(`https://example.com/${secret}.png`);
		expect(received.bytes).toBe(bytes);
		expect([...(received.bytes as Uint8Array)]).toEqual([1, 2, 3, 4]);
	});
});

describe("ELIZA_BRAIN_PROVIDER pin", () => {
	it("names the stale pinned provider instead of a generic handler error", async () => {
		const runtime = createSQLiteTestRuntime({
			character: {
				name: "PinnedBrain",
				bio: "test",
				settings: { ELIZA_BRAIN_PROVIDER: "removed-provider" },
			} as Character,
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => "must not fall back",
			"present-provider",
		);
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" }),
		).rejects.toMatchObject({
			code: "MODEL_PROVIDER_PIN_UNAVAILABLE",
			message: expect.stringContaining("removed-provider"),
		});
	});
});
