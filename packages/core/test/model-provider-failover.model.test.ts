/**
 * Replays the provider-failover scenarios that quint/ModelProviderFailover.qnt
 * generates (quint/check-model-provider-failover.mjs) through
 * AgentRuntime.useModel on a real SQLite runtime. Each model type has three
 * registrations in dispatch order: alpha at priority 30 and 20, beta at 10.
 * A handler answers or throws the error its model outcome names, so the real
 * dispatch loop and isModelProviderFallbackError decide which registration
 * runs next and which failure the caller receives.
 */
import { readFileSync } from "node:fs";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED } from "../src/security/model-failure.ts";
import { PROCESSING_POLICY_DENIED } from "../src/security/processing-policy.ts";
import { getModelFallbackChain, ModelType } from "../src/types/model.ts";

type ModelCase = {
	modelType: number;
	outcomes: number[];
	attempts: number[];
	phase: number;
	answeredBy: number;
	rejectedWith: number;
};

// Model encoding: modelType 0..1, registrations 0..2, outcomes 0..8 and
// phase 1 answered / 2 rejected, as documented in the model.
const MODEL_TYPES = [ModelType.TEXT_SMALL, ModelType.TEXT_TO_SPEECH] as const;
const REGISTRATIONS = [
	{ provider: "alpha", priority: 30 },
	{ provider: "alpha", priority: 20 },
	{ provider: "beta", priority: 10 },
] as const;
const ANSWERED = 1;
const CALLER_CANCELS = 7;

function refusedSocket(code: string): Error {
	return Object.assign(new Error(`connect ${code} 127.0.0.1:9`), { code });
}

/** The AI SDK's refused-connection error: the socket error stays on `.cause`. */
function cannotConnect(code = "ECONNREFUSED"): Error {
	return Object.assign(
		new Error(`Cannot connect to API: connect ${code} 127.0.0.1:9`, {
			cause: refusedSocket(code),
		}),
		{ name: "AI_APICallError" },
	);
}

function failure(outcome: number): Error {
	switch (outcome) {
		case 1:
			return cannotConnect();
		case 2: {
			const lastError = cannotConnect("ConnectionRefused");
			return Object.assign(
				new Error("Failed after 3 attempts. Last error: Cannot connect to API"),
				{
					name: "AI_RetryError",
					reason: "maxRetriesExceeded",
					lastError,
					errors: [lastError],
				},
			);
		}
		case 3:
			return Object.assign(new Error("Invalid value for 'messages'."), {
				name: "AI_APICallError",
				statusCode: 400,
			});
		case 4:
			return Object.assign(
				new Error("funding authority denied", { cause: cannotConnect() }),
				{ code: "MODEL_FUNDING_AUTHORITY_FAILED" },
			);
		case 5:
			return Object.assign(
				new Error("processing policy denied", { cause: cannotConnect() }),
				{ code: PROCESSING_POLICY_DENIED },
			);
		case 6:
			return Object.assign(
				new Error("request aborted", { cause: cannotConnect() }),
				{ name: "AbortError" },
			);
		case CALLER_CANCELS:
			return cannotConnect();
		case 8:
			return Object.assign(new Error("provider retry budget exhausted"), {
				code: MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED,
			});
		default:
			throw new Error(`Unknown model outcome ${outcome}`);
	}
}

// Without the generated file: [modelType, outcomes, attempts, answeredBy,
// rejectedWith] for one dispatch per property.
const DEFAULT_CASES: Array<[number, number[], number[], number, number]> = [
	[0, [1, 0, 0], [0, 1], 1, -1], // refused on the SDK cause, then an answer
	[0, [2, 1, 0], [0, 1, 2], 2, -1], // retry envelope, refused, answer
	[0, [1, 2, 1], [0, 1, 2], -1, 1], // every provider refuses
	[0, [8, 0, 0], [0, 2], 2, -1], // alpha's budget is spent: skip its 2nd
	[0, [4, 0, 0], [0], -1, 4], // funding denial over a refused cause
	[0, [1, 5, 0], [0, 1], -1, 5], // policy denial over a refused cause
	[0, [6, 0, 0], [0], -1, 6], // AbortError over a refused cause
	[0, [7, 0, 0], [0], -1, 7], // the caller aborts
	[0, [3, 0, 0], [0], -1, 3], // HTTP 400
	[1, [1, 0, 0], [0], -1, 1], // TEXT_TO_SPEECH never fails over
];

const modelCases: ModelCase[] = process.env
	.ELIZA_MODEL_PROVIDER_FAILOVER_MODEL_CASES
	? JSON.parse(
			readFileSync(
				process.env.ELIZA_MODEL_PROVIDER_FAILOVER_MODEL_CASES,
				"utf8",
			),
		)
	: DEFAULT_CASES.map(
			([modelType, outcomes, attempts, answeredBy, rejectedWith]) => ({
				modelType,
				outcomes,
				attempts,
				phase: answeredBy >= 0 ? ANSWERED : 2,
				answeredBy,
				rejectedWith,
			}),
		);

let runtime: ReturnType<typeof createSQLiteTestRuntime>;
let scenario: { outcomes: number[]; caller: AbortController; calls: number[] };

beforeAll(async () => {
	runtime = createSQLiteTestRuntime({
		character: { name: "ProviderFailoverModel", bio: ["test"], settings: {} },
		logLevel: "fatal",
	});
	await runtime.initialize({ skipMigrations: true });
	for (const modelType of MODEL_TYPES) {
		for (const [index, registration] of REGISTRATIONS.entries()) {
			runtime.registerModel(
				modelType,
				async () => {
					scenario.calls.push(index);
					const outcome = scenario.outcomes[index];
					if (outcome === 0) return `answer from registration ${index}`;
					if (outcome === CALLER_CANCELS) {
						scenario.caller.abort(
							new DOMException("caller cancelled the turn", "AbortError"),
						);
					}
					throw Object.assign(failure(outcome), {
						modelRegistration: index,
						modelOutcome: outcome,
					});
				},
				registration.provider,
				registration.priority,
			);
		}
	}
}, 60_000);

afterAll(async () => {
	await runtime?.stop();
	await runtime?.close();
});

describe("useModel provider failover model cases", () => {
	it("dispatches only the three model registrations", () => {
		for (const modelType of MODEL_TYPES) {
			const chain = new Set(getModelFallbackChain(modelType));
			expect(
				runtime
					.getModelRegistrations()
					.filter((registration) => chain.has(registration.modelType))
					.map(({ provider, priority }) => ({ provider, priority })),
			).toEqual(REGISTRATIONS);
		}
	});

	it.each(modelCases)(
		"matches the generated failover outcome (model $modelType, outcomes $outcomes)",
		async ({
			modelType,
			outcomes,
			attempts,
			phase,
			answeredBy,
			rejectedWith,
		}) => {
			scenario = { outcomes, caller: new AbortController(), calls: [] };
			const result = runtime.useModel(MODEL_TYPES[modelType], {
				prompt: "Reply briefly.",
				text: "Reply briefly.",
				signal: scenario.caller.signal,
			});
			if (phase === ANSWERED) {
				await expect(result).resolves.toBe(
					`answer from registration ${answeredBy}`,
				);
			} else if (rejectedWith === CALLER_CANCELS) {
				await expect(result).rejects.toMatchObject({
					name: "AbortError",
					message: "caller cancelled the turn",
				});
			} else {
				await expect(result).rejects.toMatchObject({
					modelRegistration: attempts.at(-1),
					modelOutcome: rejectedWith,
				});
			}
			expect(scenario.calls).toEqual(attempts);
		},
	);
});
