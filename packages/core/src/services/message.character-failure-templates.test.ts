/**
 * Proves the five `character.templates.*Reply` keys are genuinely wired: when
 * every model call fails, the connector delivery path must emit the
 * character's own string instead of the voice-neutral framework default, so a
 * persona does not visibly break at the worst possible moment.
 *
 * This is the runtime half of the contract. The preset half (which strings the
 * shipped `eliza` persona supplies) lives in
 * `packages/shared/src/character-presets.failure-templates.test.ts`, and the
 * preset -> Character wiring in
 * `packages/agent/src/runtime/build-character-config.failure-templates.test.ts`.
 * The three are bound at compile time by the `CharacterFailureTemplates`
 * interface, so a renamed key breaks the build rather than silently reverting
 * an agent to framework text.
 *
 * Harness mirrors message.credit-exhaustion-reply.test.ts: the real
 * `handleMessage` pipeline with only the runtime I/O surface mocked, asserting
 * what a connector would actually post to the channel.
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterFailureTemplates } from "../contracts/first-run-options";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import { createMockRuntime } from "../testing/mock-runtime";
import type { Room } from "../types/environment";
import type { Memory } from "../types/memory";
import {
	asUUID,
	ChannelType,
	type Content,
	type UUID,
} from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { DefaultMessageService, INSUFFICIENT_CREDITS_REPLY } from "./message";

const AGENT = "00000000-0000-0000-0000-00000000002a" as UUID;
const ENTITY = "00000000-0000-0000-0000-00000000002b" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000002c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000002d" as UUID;

/**
 * Distinctive sentinels — typed by the shared contract, so renaming a key in
 * `CharacterFailureTemplates` fails this file's compile instead of quietly
 * dropping a persona back to framework text.
 */
const TEMPLATES = {
	authFailedReply: "sentinel: my key isn't being accepted.",
	insufficientCreditsReply: "sentinel: my provider is out of credits.",
	noModelProviderReply: "sentinel: i have no model provider yet.",
	rateLimitedReply: "sentinel: my provider is throttling me.",
	transientFailureReply: "sentinel: something broke on my end.",
} satisfies Required<CharacterFailureTemplates>;

/** The error shape plugin-elizacloud throws when Eliza Cloud returns 402. */
function creditExhaustionError(): Error {
	return Object.assign(new Error("Insufficient credits."), {
		status: 402,
		error: { code: "insufficient_credits", message: "Insufficient credits." },
	});
}

function rateLimitError(): Error {
	return Object.assign(new Error("Rate limit exceeded. Try again shortly."), {
		status: 429,
		error: { code: "rate_limit_exceeded" },
	});
}

function authError(): Error {
	return Object.assign(new Error("Invalid API key"), { status: 401 });
}

function transientError(): Error {
	return new Error("socket hang up");
}

function makeMessage(overrides: Partial<Content> = {}): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text: "@Eliza what's the plan?",
			source: "discord",
			channelType: ChannelType.GROUP,
			mentionContext: { isMention: true },
			...overrides,
		},
		createdAt: Date.now(),
	};
}

function makeState(): State {
	return { values: {}, data: {}, text: "" };
}

function makeRoom(): Room {
	return { id: ROOM, source: "discord", type: ChannelType.GROUP } as Room;
}

/**
 * @param failure  rejection thrown by every model slot.
 * @param options.hasModelProvider  false => `getModel` resolves nothing, which
 *   is how the runtime detects "no LLM provider plugin is registered at all"
 *   and short-circuits to the no-provider reply before any model call.
 * @param options.templates  character overrides, omitted to assert defaults.
 */
function makeFailingRuntime(
	failure: Error,
	options: {
		hasModelProvider?: boolean;
		templates?: Partial<CharacterFailureTemplates>;
	} = {},
): IAgentRuntime {
	const { hasModelProvider = true, templates } = options;
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return createMockRuntime({
		agentId: AGENT,
		character: {
			name: "Eliza",
			bio: ["test agent"],
			...(templates ? { templates } : {}),
		} as IAgentRuntime["character"],
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		} as unknown as IAgentRuntime["logger"],
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		getModel: vi.fn(() =>
			hasModelProvider
				? async () => {
						throw failure;
					}
				: undefined,
		),
		useModel: vi.fn(async () => {
			throw failure;
		}),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		endRun: vi.fn(),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async () => asUUID(v4())),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		getRoom: vi.fn(async () => makeRoom()),
		getRoomsByIds: vi.fn(async () => [makeRoom()]),
		getMemories: vi.fn(async () => []),
		isCheckShouldRespondEnabled: vi.fn(() => true),
		turnControllers: new TurnControllerRegistry(),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
	});
}

async function runTurn(
	failure: Error,
	options: {
		hasModelProvider?: boolean;
		templates?: Partial<CharacterFailureTemplates>;
	} = {},
): Promise<string[]> {
	const runtime = makeFailingRuntime(failure, options);
	const deliveries: Content[] = [];
	await new DefaultMessageService().handleMessage(
		runtime,
		makeMessage(),
		async (content) => {
			deliveries.push(content);
			return [];
		},
	);
	return deliveries
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
}

/**
 * Each row is one failure classification, its triggering error, and the
 * template key the runtime must read for it. Driving all five off one table
 * makes an unwired key impossible to miss.
 */
const CASES = [
	{
		kind: "credit exhaustion (402)",
		key: "insufficientCreditsReply",
		error: creditExhaustionError,
		options: {},
	},
	{
		kind: "rate limit (bare 429)",
		key: "rateLimitedReply",
		error: rateLimitError,
		options: {},
	},
	{
		kind: "auth failure (401)",
		key: "authFailedReply",
		error: authError,
		options: {},
	},
	{
		kind: "other transient failure",
		key: "transientFailureReply",
		error: transientError,
		options: {},
	},
	{
		kind: "no model provider registered",
		key: "noModelProviderReply",
		error: transientError,
		options: { hasModelProvider: false },
	},
] as const satisfies ReadonlyArray<{
	kind: string;
	key: keyof CharacterFailureTemplates;
	error: () => Error;
	options: { hasModelProvider?: boolean };
}>;

describe("character failure templates on the connector delivery path", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const testCase of CASES) {
		it(`renders character.templates.${testCase.key} on ${testCase.kind}`, async () => {
			const visibleTexts = await runTurn(testCase.error(), {
				...testCase.options,
				templates: TEMPLATES,
			});

			expect(visibleTexts).toHaveLength(1);
			expect(visibleTexts[0]).toBe(TEMPLATES[testCase.key]);
		});

		it(`falls back to the framework default for ${testCase.kind} when the character sets no template`, async () => {
			const visibleTexts = await runTurn(testCase.error(), testCase.options);

			expect(visibleTexts).toHaveLength(1);
			// The default must still be the framework's, i.e. the override is a
			// real override and not the only code path.
			expect(visibleTexts[0]).not.toBe(TEMPLATES[testCase.key]);
			expect(visibleTexts[0].length).toBeGreaterThan(0);
		});

		it(`does not leak other template keys into ${testCase.kind}`, async () => {
			// Only the key matching this failure kind may be selected — a
			// mis-wired branch that reads e.g. transientFailureReply for every
			// kind would tell a rate-limited user to "try again" forever.
			const otherKeys = CASES.map((entry) => entry.key).filter(
				(key) => key !== testCase.key,
			);
			const visibleTexts = await runTurn(testCase.error(), {
				...testCase.options,
				templates: TEMPLATES,
			});

			for (const key of otherKeys) {
				expect(visibleTexts[0]).not.toBe(TEMPLATES[key]);
			}
		});
	}

	it("keeps the framework insufficient-credits default reachable", async () => {
		// Guards the fallback expression itself: if `|| INSUFFICIENT_CREDITS_REPLY`
		// were dropped, the no-template case above would still pass on any
		// non-empty string.
		const visibleTexts = await runTurn(creditExhaustionError());
		expect(visibleTexts[0]).toBe(INSUFFICIENT_CREDITS_REPLY);
	});

	it("accepts a ({ state }) => string callback template", async () => {
		// JSON characters can only carry strings, but in-process characters may
		// supply a callback; the runtime resolves both.
		const runtime = makeFailingRuntime(rateLimitError());
		runtime.character.templates = {
			rateLimitedReply: () => "sentinel: callback rate limit reply.",
		};
		const deliveries: Content[] = [];
		await new DefaultMessageService().handleMessage(
			runtime,
			makeMessage(),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);

		expect(deliveries.map((content) => content.text)).toContain(
			"sentinel: callback rate limit reply.",
		);
	});
});
