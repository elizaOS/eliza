/**
 * Exercises failure-reply output classification and fallback rendering with a
 * queued deterministic model delegate; no provider or database is involved.
 */
import { describe, expect, it, vi } from "vitest";
import { DefaultMessageService } from "../services/message";
import type { Memory } from "../types/memory";
import type { Content, UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	trace: vi.fn(),
};

function makeRuntimeThrowing(errors: unknown[]): IAgentRuntime {
	const queue = [...errors];
	return {
		useModel: vi.fn(async () => {
			const error = queue.shift();
			if (!error) throw new Error("Unexpected useModel call");
			throw error;
		}),
		logger,
	} as unknown as IAgentRuntime;
}

function creditError(): Error & { statusCode: number } {
	return Object.assign(new Error("insufficient_credits"), { statusCode: 402 });
}

function makeRuntimeReturning(responses: unknown[]): IAgentRuntime {
	const queue = [...responses];
	return {
		useModel: vi.fn(async () => {
			if (queue.length === 0) throw new Error("Unexpected useModel call");
			const next = queue.shift();
			if (next instanceof Error) throw next;
			return next;
		}),
		getModel: vi.fn(() => vi.fn()),
		reportError: vi.fn(),
		character: { templates: {} },
		agentId: "00000000-0000-0000-0000-000000000001",
		logger,
	} as unknown as IAgentRuntime;
}

type FailureReplyService = {
	generateFailureReplyText(
		runtime: IAgentRuntime,
		prompt: string,
		stage: string,
	): Promise<{ kind: string; value?: string }>;
	buildStructuredFailureReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		stage: string,
	): Promise<{ responseContent: Content | null }>;
};

describe("DefaultMessageService structured failure replies", () => {
	it("preserves credit exhaustion when later fallback model slots fail generically", async () => {
		const service = new DefaultMessageService() as unknown as {
			generateFailureReplyText(
				runtime: IAgentRuntime,
				prompt: string,
				stage: string,
			): Promise<{ kind: string }>;
		};
		const runtime = makeRuntimeThrowing([
			creditError(),
			new Error("TEXT_LARGE fallback failed"),
			new Error("TEXT_SMALL fallback failed"),
			new Error("TEXT_NANO fallback failed"),
		]);

		await expect(
			service.generateFailureReplyText(runtime, "recent messages", "test"),
		).resolves.toEqual({ kind: "creditsExhausted" });
	});

	it("extracts the user-facing text from a structured envelope reply", async () => {
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const runtime = makeRuntimeReturning([
			'{"shouldRespond": true, "replyText": "sorry, that broke on my side"}',
		]);
		await expect(
			service.generateFailureReplyText(runtime, "recent messages", "test"),
		).resolves.toEqual({ kind: "text", value: "sorry, that broke on my side" });
	});

	it("never ships a raw JSON envelope as the failure reply", async () => {
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const runtime = makeRuntimeReturning([
			'{"action":"BROWSER","parameters":{"url":"https://example.com"},"thought":"retry the open","status":"retry"}',
			"something went sideways, mind trying that again?",
		]);
		await expect(
			service.generateFailureReplyText(runtime, "recent messages", "test"),
		).resolves.toEqual({
			kind: "text",
			value: "something went sideways, mind trying that again?",
		});
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
	});

	it("rejects a fenced action envelope hidden inside nested reply fields", async () => {
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const nestedEnvelope = JSON.stringify({
			response: JSON.stringify({
				messageToUser:
					'```json\n{"action":"BROWSER","parameters":{"url":"https://example.com"},"toolCallId":"call-1"}\n```',
			}),
		});
		const runtime = makeRuntimeReturning([
			nestedEnvelope,
			"That did not work. Please try again.",
		]);

		await expect(
			service.generateFailureReplyText(runtime, "recent messages", "test"),
		).resolves.toEqual({
			kind: "text",
			value: "That did not work. Please try again.",
		});
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed control JSON and advances to the next model slot", async () => {
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const runtime = makeRuntimeReturning([
			'{"action":"BROWSER","parameters":{"url":"https://example.com"},"status":',
			"I hit a snag. Please try once more.",
		]);

		await expect(
			service.generateFailureReplyText(runtime, "recent messages", "test"),
		).resolves.toEqual({
			kind: "text",
			value: "I hit a snag. Please try once more.",
		});
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
	});

	it("rejects a control record inside a JSON array and advances", async () => {
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const runtime = makeRuntimeReturning([
			'[{"status":"queued"},{"action":"BROWSER","parameters":{"url":"https://example.com"}}]',
			"I could not complete that. Please try again.",
		]);

		await expect(
			service.generateFailureReplyText(runtime, "recent messages", "test"),
		).resolves.toEqual({
			kind: "text",
			value: "I could not complete that. Please try again.",
		});
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
	});

	it("does not mistake genuine JSON for a control envelope", async () => {
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const runtime = makeRuntimeReturning([
			'{"action":"proceed","parameters":{"step":1},"status":"done"}',
			"I could not complete that. Please try again.",
		]);

		await expect(
			service.generateFailureReplyText(runtime, "recent messages", "test"),
		).resolves.toEqual({
			kind: "text",
			value: "I could not complete that. Please try again.",
		});
		const reportedError = (
			runtime.reportError as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[0]?.[1] as {
			context?: { classification?: string };
		};
		expect(reportedError.context?.classification).toBe("unexpected-json");
	});

	it("renders the designed default when every slot yields invalid envelopes", async () => {
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const envelope = '{"action":"X","parameters":{}}';
		const runtime = makeRuntimeReturning([
			envelope,
			envelope,
			envelope,
			envelope,
		]);
		const responseId = "00000000-0000-0000-0000-000000000002" as UUID;
		const message = {
			content: { text: "open browser" },
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		} as Memory;
		const result = await service.buildStructuredFailureReply(
			runtime,
			message,
			{ values: { recentMessages: "User: open browser" } } as State,
			responseId,
			"test",
		);

		expect(result.responseContent?.text).toBe(
			"Something went wrong on my end. Please try again.",
		);
		expect(result.responseContent?.text).not.toContain('"action"');
		expect(runtime.reportError).toHaveBeenCalledTimes(4);
	});

	it("bounds reasoning on every failure-reply model slot (thinking=off)", async () => {
		// #16394: the failure-reply fallback is a plain-text path that must stay
		// low-latency on reasoning models. Every useModel call it makes carries
		// providerOptions.eliza.thinking = "off", matching Stage-1, the
		// evaluator, and every planner iteration.
		const service =
			new DefaultMessageService() as unknown as FailureReplyService;
		const runtime = makeRuntimeReturning(["Sorry, that broke on my side."]);
		await service.generateFailureReplyText(runtime, "recent messages", "test");
		const useModel = runtime.useModel as unknown as {
			mock: { calls: unknown[][] };
		};
		expect(useModel.mock.calls.length).toBeGreaterThanOrEqual(1);
		for (const call of useModel.mock.calls) {
			const params = call[1] as {
				providerOptions?: { eliza?: { thinking?: string } };
			};
			expect(params?.providerOptions?.eliza?.thinking).toBe("off");
		}
	});
});
