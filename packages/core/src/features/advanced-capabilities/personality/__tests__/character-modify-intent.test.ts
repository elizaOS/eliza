/**
 * Covers CHARACTER.modify intent classification against the in-memory
 * FakeRuntime with scripted model stubs (no live model): the deterministic rule
 * fast path — including the exact live-miss shapes from tj-4c9e654fec50ea — the
 * tolerant-parse + single-reroll model path, and the actionable failure surface
 * when classification stays inconclusive. Role access runs the real
 * hasRoleAccess against an owner-seeded runtime.
 */
import { describe, expect, test } from "vitest";
import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	UUID,
} from "../../../../types/index.ts";
import {
	characterAction,
	detectModificationIntentByRules,
} from "../actions/character.ts";
import { PersonalityServiceType } from "../types.ts";
import { makeFakeRuntime, makeMessage } from "./test-helpers.ts";

const SENDER = "00000000-0000-4000-8000-0000000000aa" as UUID;

/** The exact planner-authored request that killed the live action. */
const LIVE_PARAMETER_REQUEST =
	"add a strict rule to my personality: never say 'bet' under any circumstances.";
/** The exact raw owner message from the live turn. */
const LIVE_RAW_MESSAGE = "change your personality to never say bet";

const INTENT_PROMPT_MARKER = "character modification intent";
const PARSE_PROMPT_MARKER = "structured global character update";
const SAFETY_PROMPT_MARKER = "safety and appropriateness";

type ScriptedRuntime = {
	fake: ReturnType<typeof makeFakeRuntime>;
	prompts: string[];
	intentPrompts: string[];
};

/**
 * Owner-seeded runtime with a scripted `useModel`: `intentResponses` are served
 * in order to intent-classifier prompts; parse/safety prompts get canned valid
 * output so the modify pipeline can complete after a fast-path or model-path
 * classification.
 */
function scriptedRuntime(intentResponses: readonly string[]): ScriptedRuntime {
	const fake = makeFakeRuntime({ owner: SENDER });
	const prompts: string[] = [];
	const intentPrompts: string[] = [];
	let intentCall = 0;
	const runtimeMutable = fake.runtime as unknown as {
		useModel: (
			modelType: string,
			params: { prompt: string },
		) => Promise<string>;
		reportError: () => void;
	};
	runtimeMutable.reportError = () => {};
	runtimeMutable.useModel = async (_modelType, params) => {
		prompts.push(params.prompt);
		if (params.prompt.includes(INTENT_PROMPT_MARKER)) {
			intentPrompts.push(params.prompt);
			const response = intentResponses[intentCall] ?? intentResponses.at(-1);
			intentCall += 1;
			if (response === undefined) {
				throw new Error("no scripted intent response left");
			}
			return response;
		}
		if (params.prompt.includes(PARSE_PROMPT_MARKER)) {
			return '{"apply": true, "style_all": ["never say bet under any circumstances"]}';
		}
		if (params.prompt.includes(SAFETY_PROMPT_MARKER)) {
			return '{"isAppropriate": true, "concerns": [], "reasoning": "style-only change"}';
		}
		throw new Error(`unexpected model prompt: ${params.prompt.slice(0, 80)}`);
	};
	fake.runtime.registerService(PersonalityServiceType.CHARACTER_MANAGEMENT, {
		validateModification: () => ({ valid: true, errors: [] }),
		applyModification: async () => ({ success: true }),
	});
	return { fake, prompts, intentPrompts };
}

async function runModify(
	scripted: ScriptedRuntime,
	messageText: string,
	request?: string,
): Promise<ActionResult> {
	const message = makeMessage({
		entityId: SENDER,
		agentId: scripted.fake.runtime.agentId,
		text: messageText,
	});
	return (await characterAction.handler?.(
		scripted.fake.runtime as IAgentRuntime,
		message,
		undefined,
		{
			parameters: {
				action: "modify",
				...(request !== undefined ? { request } : {}),
			},
		} as Record<string, unknown>,
		(async () => []) as HandlerCallback,
	)) as ActionResult;
}

describe("detectModificationIntentByRules — fast-path shapes", () => {
	const explicitShapes = [
		LIVE_RAW_MESSAGE,
		LIVE_PARAMETER_REQUEST,
		// the live raw message shape as delivered, mention prefix and all
		"agent name (@1234567890123456789) change your personality to never say bet",
		"never say bet",
		"stop saying bet",
		"don't say bro anymore",
		"never ever say bet again",
		"be more skeptical",
		"be less verbose",
		"act more formal",
	];
	for (const shape of explicitShapes) {
		test(`classifies "${shape}" as definitive explicit`, () => {
			const result = detectModificationIntentByRules(shape);
			expect(result.definitive).toBe(true);
			expect(result.intent.isModificationRequest).toBe(true);
			expect(result.intent.requestType).toBe("explicit");
		});
	}

	test("unrelated text is definitively not a modification request", () => {
		const result = detectModificationIntentByRules("what's the weather today");
		expect(result.definitive).toBe(true);
		expect(result.intent.isModificationRequest).toBe(false);
	});

	test("ambiguous character talk stays inconclusive for the model path", () => {
		const result = detectModificationIntentByRules(
			"hmm your personality could probably improve somehow",
		);
		expect(result.definitive).toBe(false);
		expect(result.potentialRequest).toBe(true);
	});
});

describe("CHARACTER.modify — rule fast path skips the intent model call", () => {
	test("the exact live planner request applies without an intent round-trip", async () => {
		const scripted = scriptedRuntime([]);
		const result = await runModify(
			scripted,
			LIVE_RAW_MESSAGE,
			LIVE_PARAMETER_REQUEST,
		);
		expect(result.success).toBe(true);
		expect(result.values?.modificationsApplied).toBe(true);
		expect(scripted.intentPrompts).toHaveLength(0);
		// parse + safety only
		expect(scripted.prompts).toHaveLength(2);
	});

	test("the exact raw owner message applies without an intent round-trip", async () => {
		const scripted = scriptedRuntime([]);
		const result = await runModify(scripted, LIVE_RAW_MESSAGE);
		expect(result.success).toBe(true);
		expect(scripted.intentPrompts).toHaveLength(0);
	});
});

describe("CHARACTER.modify — model path retry and tolerant parsing", () => {
	const AMBIGUOUS = "hmm your personality could probably improve somehow";

	test("a flaky first response is retried once and the valid retry is used", async () => {
		const scripted = scriptedRuntime([
			"I think this is asking about personality but I cannot answer in JSON",
			'{"isModificationRequest": false, "requestType": "none", "confidence": 0.9}',
		]);
		const result = await runModify(scripted, AMBIGUOUS);
		expect(scripted.intentPrompts).toHaveLength(2);
		// intent=none with no pending evolution suggestion → honest no-op result
		expect(result.success).toBe(false);
		expect(result.values?.error).toBe("no_modification_found");
	});

	test("fenced JSON is accepted on the first attempt", async () => {
		const scripted = scriptedRuntime([
			'```json\n{"isModificationRequest": false, "requestType": "none", "confidence": 0.95}\n```',
		]);
		const result = await runModify(scripted, AMBIGUOUS);
		expect(scripted.intentPrompts).toHaveLength(1);
		expect(result.values?.error).toBe("no_modification_found");
	});

	test("still-invalid after the reroll fails with actionable guidance", async () => {
		const scripted = scriptedRuntime([
			"no json here at all",
			"still no json here",
		]);
		const result = await runModify(scripted, AMBIGUOUS);
		expect(scripted.intentPrompts).toHaveLength(2);
		expect(result.success).toBe(false);
		expect(result.data?.errorType).toBe("intent_classification_failed");
		expect(result.text).toContain('"change your personality to ..."');
	});
});
