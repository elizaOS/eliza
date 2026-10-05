/**
 * Host processing admission: per-attempt model admission before any payload
 * preparation, terminal denial without failover, fail-closed evaluation, and
 * action-effect admission at the shared settlement boundary. Also covers the
 * unified action gate on mode hooks. Real AgentRuntime, spy handlers only.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../runtime";
import {
	isProcessingPolicyDenial,
	type ProcessingPolicy,
	ProcessingPolicyDeniedError,
	type ProcessingRequest,
} from "../../security/processing-policy";
import type { Character } from "../../types/agent.js";
import type { Action } from "../../types/components";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model.js";
import type { UUID } from "../../types/primitives";
import { settleActionHandler } from "../action-handler-settlement";

function makeRuntime(processingPolicy?: ProcessingPolicy): AgentRuntime {
	return createSQLiteTestRuntime({
		character: { name: "PolicyAgent", bio: "test", settings: {} } as Character,
		logLevel: "fatal",
		...(processingPolicy ? { processingPolicy } : {}),
	});
}

function statusError(statusCode: number, message: string): Error {
	return Object.assign(new Error(message), { statusCode });
}

function allowProviders(
	allowed: readonly string[],
	requests: ProcessingRequest[] = [],
): ProcessingPolicy {
	return {
		decide(request) {
			requests.push(request);
			if (
				request.kind === "model_attempt" &&
				allowed.includes(request.model.provider)
			) {
				return { allow: true, receiptId: "r-1", policyRevision: "rev-1" };
			}
			if (request.kind === "action_effect") {
				return request.action.egress.every((d) => allowed.includes(d))
					? { allow: true, receiptId: "r-2", policyRevision: "rev-1" }
					: { allow: false, code: "DESTINATION", policyRevision: "rev-1" };
			}
			return { allow: false, code: "PROCESSOR", policyRevision: "rev-1" };
		},
	};
}

describe("processing policy: model dispatch", () => {
	it("changes nothing without a policy", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "ok");
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "any", 10);
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" }),
		).resolves.toBe("ok");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("admits an approved provider and records the attempt", async () => {
		const requests: ProcessingRequest[] = [];
		const runtime = makeRuntime(allowProviders(["approved"], requests));
		const handler = vi.fn(async () => "ok");
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "approved", 10);
		await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			kind: "model_attempt",
			model: {
				modelType: ModelType.TEXT_LARGE,
				modality: "text",
				provider: "approved",
				attempt: 1,
				reason: "primary",
			},
		});
	});

	it.each([
		[ModelType.TEXT_LARGE, { prompt: "hi" }],
		[ModelType.TEXT_EMBEDDING, { text: "hi" }],
		[ModelType.TEXT_EMBEDDING_BATCH, { texts: ["hi"] }],
		[ModelType.TRANSCRIPTION, "https://example.test/a.wav"],
		[ModelType.TEXT_TO_SPEECH, { text: "hi" }],
		[ModelType.IMAGE, { prompt: "hi" }],
	] as const)(
		"denies %s before hooks or the handler run",
		async (modelType, params) => {
			const runtime = makeRuntime(allowProviders([]));
			const handler = vi.fn(async () => "never");
			const hook = vi.fn();
			runtime.registerPipelineHook({
				id: "spy-pre-model",
				phase: "pre_model",
				handler: hook,
			});
			runtime.registerModel(modelType, handler, "unapproved", 10);
			const failure = await runtime
				.useModel(modelType, params as never)
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(ProcessingPolicyDeniedError);
			expect((failure as ProcessingPolicyDeniedError).reason).toBe(
				"policy_denied",
			);
			expect(handler).not.toHaveBeenCalled();
			expect(hook).not.toHaveBeenCalled();
		},
	);

	it("never fails over to an unapproved provider after a rate limit", async () => {
		const runtime = makeRuntime(allowProviders(["primary"]));
		const rateLimited = statusError(429, "rate limited");
		const primary = vi.fn(async () => {
			throw rateLimited;
		});
		const fallback = vi.fn(async () => "fallback");
		runtime.registerModel(ModelType.TEXT_LARGE, primary, "primary", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, fallback, "fallback", 10);
		const failure = await runtime
			.useModel(ModelType.TEXT_LARGE, { prompt: "hi" })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ProcessingPolicyDeniedError);
		expect((failure as Error).cause).toBe(rateLimited);
		expect(primary).toHaveBeenCalledTimes(1);
		expect(fallback).not.toHaveBeenCalled();
	});

	it("allows failover to an approved provider and labels it", async () => {
		const requests: ProcessingRequest[] = [];
		const runtime = makeRuntime(
			allowProviders(["primary", "fallback"], requests),
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => {
				throw statusError(429, "rate limited");
			},
			"primary",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => "fallback",
			"fallback",
			10,
		);
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" }),
		).resolves.toBe("fallback");
		expect(
			requests.map((r) => r.kind === "model_attempt" && r.model.reason),
		).toEqual(["primary", "failover"]);
	});

	it("re-reads the policy on every call so revocation applies mid-turn", async () => {
		let revoked = false;
		const runtime = makeRuntime({
			decide: () =>
				revoked
					? { allow: false, code: "REVOKED", policyRevision: "rev-2" }
					: { allow: true, receiptId: "r", policyRevision: "rev-1" },
		});
		const handler = vi.fn(async () => "ok");
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "p", 10);
		await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "one" });
		revoked = true;
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "two" }),
		).rejects.toBeInstanceOf(ProcessingPolicyDeniedError);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"a throwing policy",
			() => {
				throw new Error("policy store down");
			},
			"policy_unavailable",
		],
		["a malformed decision", () => ({ allow: true }), "decision_malformed"],
	] as const)("fails closed on %s", async (_label, decide, reason) => {
		const runtime = makeRuntime({
			decide: decide as ProcessingPolicy["decide"],
		});
		const handler = vi.fn(async () => "ok");
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "p", 10);
		const failure = await runtime
			.useModel(ModelType.TEXT_LARGE, { prompt: "hi" })
			.catch((error: unknown) => error);
		expect((failure as ProcessingPolicyDeniedError).reason).toBe(reason);
		expect(handler).not.toHaveBeenCalled();
	});

	it("denies a custom model slot whose modality is unknown", async () => {
		const decide = vi.fn(() => ({
			allow: true as const,
			receiptId: "r",
			policyRevision: "rev",
		}));
		const runtime = makeRuntime({ decide });
		const handler = vi.fn(async () => "ok");
		runtime.registerModel("CUSTOM_SLOT", handler, "p", 10);
		const failure = await runtime
			.useModel("CUSTOM_SLOT" as never, {} as never)
			.catch((error: unknown) => error);
		expect((failure as ProcessingPolicyDeniedError).reason).toBe(
			"modality_unknown",
		);
		expect(decide).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
	});

	it("cannot be replaced after construction", async () => {
		const { bindProcessingPolicy } = await import(
			"../../security/processing-policy"
		);
		const runtime = makeRuntime(allowProviders([]));
		expect(() =>
			bindProcessingPolicy(runtime, {
				decide: () => ({ allow: true, receiptId: "r", policyRevision: "x" }),
			}),
		).toThrow(/already bound/);
	});
});

function makeAction(overrides: Partial<Action> = {}): Action & {
	handler: ReturnType<typeof vi.fn>;
} {
	return {
		name: "SEND_NOTE",
		description: "test action",
		validate: vi.fn(async () => true),
		handler: vi.fn(async () => ({ success: true, text: "sent" })),
		...overrides,
	} as Action & { handler: ReturnType<typeof vi.fn> };
}

describe("processing policy: action effects", () => {
	it("changes nothing without a policy, even for undeclared egress", async () => {
		const runtime = makeRuntime();
		const action = makeAction();
		const result = await settleActionHandler({
			runtime,
			action,
			invoke: () => action.handler(),
		});
		expect(result.success).toBe(true);
		expect(action.handler).toHaveBeenCalledTimes(1);
	});

	it("denies an action with undeclared egress before its handler runs", async () => {
		const runtime = makeRuntime(allowProviders(["mail"]));
		const action = makeAction();
		const result = await settleActionHandler({
			runtime,
			action,
			invoke: () => action.handler(),
		});
		expect(result.success).toBe(false);
		expect(result.failureProvenance).toMatchObject({
			code: "PROCESSING_POLICY_DENIED",
			retryable: false,
		});
		expect(action.handler).not.toHaveBeenCalled();
	});

	it("admits declared approved destinations and denies unapproved ones", async () => {
		const runtime = makeRuntime(allowProviders(["mail"]));
		const approved = makeAction({ egress: ["mail"] });
		const unapproved = makeAction({ egress: ["mail", "sms"] });
		await expect(
			settleActionHandler({
				runtime,
				action: approved,
				invoke: () => approved.handler(),
			}),
		).resolves.toMatchObject({ success: true });
		const failure = await settleActionHandler({
			runtime,
			action: unapproved,
			handlerError: "rethrow",
			invoke: () => unapproved.handler(),
		}).catch((error: unknown) => error);
		expect(isProcessingPolicyDenial(failure)).toBe(true);
		expect(unapproved.handler).not.toHaveBeenCalled();
	});

	it("settles a model denial inside the handler as terminal, not retryable", async () => {
		// The action is admitted; the model call it makes is not ("anthropic" is
		// not an approved provider), so the denial surfaces from the handler.
		const runtime = makeRuntime(allowProviders(["mail"]));
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			vi.fn(async () => "never"),
			"anthropic",
			10,
		);
		const action = makeAction({ egress: ["mail"] });
		const result = await settleActionHandler({
			runtime,
			action,
			invoke: async () => {
				await runtime.useModel(ModelType.TEXT_SMALL, { prompt: "hi" });
				return { success: true };
			},
		});
		expect(result.success).toBe(false);
		expect(result.failureProvenance).toMatchObject({
			code: "PROCESSING_POLICY_DENIED",
			retryable: false,
		});
		expect(result.data).toMatchObject({
			retryable: false,
			processingDenied: true,
		});
	});
});

describe("unified action gate on mode hooks", () => {
	it("does not run a private hook on a user turn", async () => {
		const runtime = makeRuntime();
		const action = makeAction({
			name: "PRIVATE_HOOK",
			mode: "ALWAYS_AFTER",
			private: true,
		});
		runtime.registerAction(action);
		const message = {
			id: "00000000-0000-4000-8000-000000000001" as UUID,
			entityId: "00000000-0000-4000-8000-000000000002" as UUID,
			roomId: "00000000-0000-4000-8000-000000000003" as UUID,
			content: { text: "hello" },
		} as Memory;
		const ran = await runtime.runActionsByMode("ALWAYS_AFTER", message, {
			values: {},
			data: {},
			text: "",
		});
		expect(ran).toEqual([]);
		expect(action.validate).not.toHaveBeenCalled();
		expect(action.handler).not.toHaveBeenCalled();
	});
});
