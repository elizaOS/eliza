/**
 * Exercises PlanningService plan creation and execution, including retry-local
 * callback buffering and effect-receipt settlement. Deterministic stub actions
 * and runtime keep the tests independent of model and persistence providers.
 */
import { describe, expect, it, vi } from "vitest";

import { ElizaError } from "../../../errors.ts";
import { effectDeliveryBindingProvesApplication } from "../../../runtime/effect-delivery.ts";
import type { EffectReceipt } from "../../../types/effects.ts";
import type {
	Action,
	Content,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { PlanningService } from "./planning-service.ts";

/**
 * #10470: `createSimplePlan` must take its action selection from the model's
 * decision (`responseContent.actions`), not from hardcoded English-keyword
 * matching on the user's text. When the model chose no actions, the documented
 * `<response>` contract treats the turn as a plain REPLY.
 */
function msg(text: string): Memory {
	return { content: { text } } as Memory;
}
function planActions(
	plan: Awaited<ReturnType<PlanningService["createSimplePlan"]>>,
) {
	return plan?.steps.map((step) => step.actionName) ?? null;
}

function appliedEffectReceipt(
	receiptId = "receipt-plan-action-1",
): EffectReceipt {
	return {
		receiptId,
		operation: "test.plan-action.apply",
		resource: { kind: "test.plan-action", id: receiptId },
		artifacts: [],
		idempotency: { key: `request-${receiptId}`, replayed: false },
		observedAt: "2026-07-27T18:00:00.000Z",
		outcome: "applied",
		commit: {
			kind: "durable",
			id: `commit-${receiptId}`,
			committedAt: "2026-07-27T18:00:00.000Z",
		},
	};
}

function planningRuntime(
	action: Action,
	overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
	return {
		actions: [action],
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			fatal: vi.fn(),
			trace: vi.fn(),
			success: vi.fn(),
			progress: vi.fn(),
			clear: vi.fn(),
			child: vi.fn(),
		},
		reportError: vi.fn(),
		...overrides,
	} as unknown as IAgentRuntime;
}

async function singleStepPlan(
	service: PlanningService,
	runtime: IAgentRuntime,
	actionName: string,
	maxRetries = 0,
) {
	const plan = await service.createSimplePlan(
		runtime,
		msg("run the planned action"),
		{} as State,
		{ text: "run it", actions: [actionName] } as Content,
	);
	if (!plan) throw new Error("Expected a plan");
	plan.steps[0].retryPolicy = {
		maxRetries,
		backoffMs: 0,
		backoffMultiplier: 1,
		onError: "abort",
	};
	return plan;
}

describe("PlanningService.createSimplePlan — LLM-driven action selection (#10470)", () => {
	const svc = new PlanningService({} as IAgentRuntime);
	const rt = {} as IAgentRuntime;
	const state = {} as State;

	it("respects the model's chosen actions verbatim", async () => {
		const rc = { text: "on it", actions: ["SEARCH", "REPLY"] } as Content;
		const plan = await svc.createSimplePlan(
			rt,
			msg("research dogs and reply"),
			state,
			rc,
		);
		expect(planActions(plan)).toEqual(["SEARCH", "REPLY"]);
	});

	it("defaults to REPLY when the model chose no actions — not a keyword guess", async () => {
		const plan = await svc.createSimplePlan(rt, msg("hello there"), state, {
			text: "hi",
			actions: [],
		} as Content);
		expect(planActions(plan)).toEqual(["REPLY"]);
	});

	it("no longer keyword-routes 'email …' → SEND_EMAIL (now REPLY)", async () => {
		const plan = await svc.createSimplePlan(
			rt,
			msg("email Bob the quarterly report"),
			state,
			undefined,
		);
		expect(planActions(plan)).toEqual(["REPLY"]);
		expect(planActions(plan)).not.toContain("SEND_EMAIL");
	});

	it("no longer keyword-routes 'search/find/analyze' → SEARCH (now REPLY)", async () => {
		for (const text of [
			"search for cats",
			"find the file",
			"please analyze this",
		]) {
			const plan = await svc.createSimplePlan(rt, msg(text), state, undefined);
			expect(planActions(plan)).toEqual(["REPLY"]);
			expect(planActions(plan)).not.toContain("SEARCH");
		}
	});

	it("is i18n-safe: a non-English request with no model actions → REPLY", async () => {
		// "send Bob an email with the report" in Spanish — the old English-keyword
		// path would never have matched 'email'/'send'; the model decides instead.
		const plan = await svc.createSimplePlan(
			rt,
			msg("envíame un correo a Bob con el informe"),
			state,
			undefined,
		);
		expect(planActions(plan)).toEqual(["REPLY"]);
	});
});

describe("PlanningService model-output validation", () => {
	const replyAction = {
		name: "REPLY",
		description: "Reply to the user",
		validate: async () => true,
		handler: async () => ({ success: true }),
	} satisfies Action;

	it("rejects malformed comprehensive-plan JSON instead of fabricating an empty plan", async () => {
		const runtime = planningRuntime(replyAction, {
			useModel: vi.fn(async () => "not JSON"),
		});
		const service = new PlanningService(runtime);

		await expect(
			service.createComprehensivePlan(runtime, { goal: "Reply clearly" }),
		).rejects.toMatchObject({
			code: "ACTION_PLAN_BUILD_FAILED",
			cause: { code: "PLANNING_MODEL_OUTPUT_INVALID" },
		});
	});

	it("rejects unavailable model-selected actions instead of converting them to REPLY", async () => {
		const runtime = planningRuntime(replyAction, {
			useModel: vi.fn(async () =>
				JSON.stringify({
					goal: "Run a missing tool",
					execution_model: "sequential",
					steps: [{ id: "step_1", action: "MISSING_TOOL" }],
				}),
			),
		});
		const service = new PlanningService(runtime);

		await expect(
			service.createComprehensivePlan(runtime, {
				goal: "Run a missing tool",
			}),
		).rejects.toMatchObject({ code: "PLANNING_ACTION_UNAVAILABLE" });
	});

	it("rejects malformed adaptation output instead of reporting synthetic success", async () => {
		const runtime = planningRuntime(replyAction, {
			useModel: vi.fn(async () => JSON.stringify({ steps: [] })),
		});
		const service = new PlanningService(runtime);
		const plan = await service.createSimplePlan(
			runtime,
			msg("reply"),
			{} as State,
			{ text: "reply", actions: ["REPLY"] } as Content,
		);

		await expect(service.adaptPlan(runtime, plan, 0, [])).rejects.toEqual(
			expect.objectContaining({
				code: "PLAN_ADAPTATION_FAILED",
				cause: expect.any(ElizaError),
			}),
		);
	});
});

describe("PlanningService.executePlan action settlement", () => {
	it("omits planner observations from later plan-step context and results", async () => {
		const observation = "advanced-plan planner-only observation";
		const first = {
			name: "PLAN_FIRST",
			description: "First plan step",
			validate: async () => true,
			handler: async () => ({ success: true, plannerObservation: observation }),
		} satisfies Action;
		const secondHandler = vi.fn(async (_runtime, _message, _state, options) => {
			expect(options?.actionContext?.previousResults).toHaveLength(1);
			expect(
				JSON.stringify(options?.actionContext?.previousResults),
			).not.toContain(observation);
			return { success: true };
		});
		const second = {
			name: "PLAN_SECOND",
			description: "Second plan step",
			validate: async () => true,
			handler: secondHandler,
		} satisfies Action;
		const runtime = planningRuntime(first, { actions: [first, second] });
		const service = new PlanningService(runtime);
		const plan = await service.createSimplePlan(
			runtime,
			msg("run both steps"),
			{} as State,
			{ text: "run it", actions: [first.name, second.name] } as Content,
		);
		if (!plan) throw new Error("Expected a plan");

		const execution = await service.executePlan(runtime, plan, msg("run it"));

		expect(secondHandler).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(execution.results)).not.toContain(observation);
	});

	it("delivers exact canonical mutation text with applied receipt proof", async () => {
		const receipt = appliedEffectReceipt();
		const canonicalText = "The planned change is committed.";
		let deliveredContent: Content | undefined;
		const callback: HandlerCallback = vi.fn(async (content) => {
			deliveredContent = content;
			return [];
		});
		const action = {
			name: "PLAN_MUTATION",
			description: "Apply a planned mutation",
			tags: ["capability:write"],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: canonicalText });
				return {
					success: true,
					userFacingText: canonicalText,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
					data: { actionName: "FORGED_ACTION" },
				};
			},
		} satisfies Action;
		const runtime = planningRuntime(action);
		const service = new PlanningService(runtime);
		const plan = await singleStepPlan(service, runtime, action.name);

		const execution = await service.executePlan(
			runtime,
			plan,
			msg("run it"),
			callback,
		);

		expect(execution.success).toBe(true);
		expect(callback).toHaveBeenCalledOnce();
		expect(deliveredContent).toEqual(
			expect.objectContaining({
				text: canonicalText,
				effectReceiptIds: [receipt.receiptId],
			}),
		);
		expect(
			deliveredContent
				? effectDeliveryBindingProvesApplication(deliveredContent)
				: false,
		).toBe(true);
		expect(execution.results[0]).toMatchObject({
			success: true,
			data: {
				actionName: action.name,
				stepId: expect.any(String),
				executedAt: expect.any(Number),
			},
		});
	});

	it("suppresses a receipt-required mutation callback when the action returns no receipts", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const action = {
			name: "LEGACY_PLAN_MUTATION",
			description: "Legacy mutation without receipt proof",
			tags: ["capability:write", "effect:receipt-required"],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: "Done." });
				return { success: true, text: "Done." };
			},
		} satisfies Action;
		const runtime = planningRuntime(action);
		const service = new PlanningService(runtime);
		const plan = await singleStepPlan(service, runtime, action.name);

		const execution = await service.executePlan(
			runtime,
			plan,
			msg("run it"),
			callback,
		);

		expect(execution.success).toBe(true);
		expect(callback).not.toHaveBeenCalled();
	});

	it("discards a thrown attempt's callback before retrying", async () => {
		const receipt = appliedEffectReceipt("receipt-plan-retry");
		const callback: HandlerCallback = vi.fn(async () => []);
		let attempts = 0;
		const action = {
			name: "RETRY_PLAN_MUTATION",
			description: "Mutation retried by the plan",
			tags: ["capability:write", "effect:idempotent"],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				attempts += 1;
				if (attempts === 1) {
					await actionCallback?.({ text: "Stale completion." });
					throw new Error("first attempt failed");
				}
				const text = "The retried change is committed.";
				await actionCallback?.({ text });
				return {
					success: true,
					userFacingText: text,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
				};
			},
		} satisfies Action;
		const runtime = planningRuntime(action);
		const service = new PlanningService(runtime);
		const plan = await singleStepPlan(service, runtime, action.name, 1);

		const execution = await service.executePlan(
			runtime,
			plan,
			msg("run it"),
			callback,
		);

		expect(execution.success).toBe(true);
		expect(attempts).toBe(2);
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "The retried change is committed." }),
			action.name,
		);
		expect(JSON.stringify(callback.mock.calls)).not.toContain(
			"Stale completion",
		);
	});

	it("never retries an effectful action without an idempotent contract", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const handler = vi.fn(
			async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: "This attempt must not escape." });
				throw new Error("provider outcome is ambiguous");
			},
		);
		const action = {
			name: "NON_IDEMPOTENT_PLAN_MUTATION",
			description: "Mutation without a stable retry identity",
			tags: ["capability:write"],
			validate: async () => true,
			handler,
		} satisfies Action;
		const runtime = planningRuntime(action);
		const service = new PlanningService(runtime);
		const plan = await singleStepPlan(service, runtime, action.name, 2);

		const execution = await service.executePlan(
			runtime,
			plan,
			msg("run it"),
			callback,
		);

		expect(execution.success).toBe(false);
		expect(handler).toHaveBeenCalledOnce();
		expect(callback).not.toHaveBeenCalled();
		expect(execution.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ message: "provider outcome is ambiguous" }),
			]),
		);
	});

	it("never retries after a handler returns an invalid receipt", async () => {
		const receipt = appliedEffectReceipt("receipt-plan-valid");
		const callback: HandlerCallback = vi.fn(async () => []);
		let attempts = 0;
		const action = {
			name: "VALIDATE_PLAN_RECEIPT",
			description: "Return a receipt from a planned action",
			tags: ["capability:write"],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				attempts += 1;
				const text =
					attempts === 1
						? "Invalid receipt attempt."
						: "Valid receipt attempt.";
				await actionCallback?.({ text });
				if (attempts === 1) {
					return {
						success: true,
						userFacingText: text,
						verifiedUserFacing: true,
						effectReceipts: [{ ...receipt, commit: undefined }],
						userFacingEffectReceiptIds: [receipt.receiptId],
					};
				}
				return {
					success: true,
					userFacingText: text,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
				};
			},
		} satisfies Action;
		const runtime = planningRuntime(action);
		const service = new PlanningService(runtime);
		const plan = await singleStepPlan(service, runtime, action.name, 1);

		const execution = await service.executePlan(
			runtime,
			plan,
			msg("run it"),
			callback,
		);

		expect(execution.success).toBe(false);
		expect(attempts).toBe(1);
		expect(callback).not.toHaveBeenCalled();
		expect(execution.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "ACTION_RESULT_INVALID_AFTER_HANDLER",
				}),
			]),
		);
	});

	it("does not retry a committed action when callback delivery fails", async () => {
		const receipt = appliedEffectReceipt("receipt-plan-delivery");
		const callback: HandlerCallback = vi.fn(async () => {
			throw new Error("transport unavailable");
		});
		const handler = vi.fn(
			async (_runtime, _message, _state, _options, actionCallback) => {
				const text = "The change committed before delivery failed.";
				await actionCallback?.({ text });
				return {
					success: true,
					userFacingText: text,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
				};
			},
		);
		const action = {
			name: "DELIVERY_FAILURE_PLAN_MUTATION",
			description: "Commit independently of response delivery",
			tags: ["capability:write"],
			validate: async () => true,
			handler,
		} satisfies Action;
		const runtime = planningRuntime(action);
		const service = new PlanningService(runtime);
		const plan = await singleStepPlan(service, runtime, action.name, 2);

		const execution = await service.executePlan(
			runtime,
			plan,
			msg("run it"),
			callback,
		);

		expect(execution.success).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
		expect(execution.results[0]?.effectReceipts).toEqual([receipt]);
		expect(execution.results[0]?.data?.callbackDeliveryFailures).toEqual([
			"transport unavailable",
		]);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"ActionCallbackDelivery",
			expect.any(Error),
			expect.objectContaining({ actionName: action.name }),
		);
	});

	it("keeps read callbacks compatible while stripping forged receipt IDs", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const action = {
			name: "PLAN_READ",
			description: "Read without mutating",
			tags: ["capability:read"],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({
					text: "Read complete.",
					effectReceiptIds: ["forged"],
				});
				return { success: true, text: "Read complete." };
			},
		} satisfies Action;
		const runtime = planningRuntime(action);
		const service = new PlanningService(runtime);
		const plan = await singleStepPlan(service, runtime, action.name);

		await service.executePlan(runtime, plan, msg("run it"), callback);

		expect(callback).toHaveBeenCalledWith(
			{ text: "Read complete." },
			action.name,
		);
	});
});
