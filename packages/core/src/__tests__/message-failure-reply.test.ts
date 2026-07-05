/**
 * Exercises the message service's structured failure-reply classifier for model
 * fallback cascades. Deterministic: the runtime only exposes a queued useModel
 * stub, so no provider, database, or live model is involved.
 */
import { describe, expect, it, vi } from "vitest";
import { DefaultMessageService } from "../services/message";
import type { IAgentRuntime } from "../types/runtime";

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
});
