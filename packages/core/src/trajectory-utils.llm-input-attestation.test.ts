/**
 * Exercises request-scoped final-model-input attestation without a provider or
 * trajectory logger, including concurrency and fail-before-call behavior.
 */
import { describe, expect, it, vi } from "vitest";
import {
	attestLlmInputSubstring,
	type RecordLlmCallDetails,
	recordLlmCall,
	runWithLlmInputSubstringAttestation,
} from "./trajectory-utils";

function details(
	overrides: Partial<RecordLlmCallDetails> = {},
): RecordLlmCallDetails {
	return {
		model: "fixture-model",
		modelType: "ACTION_PLANNER",
		provider: "fixture-provider",
		systemPrompt: "",
		userPrompt: "",
		temperature: 0,
		maxTokens: 128,
		purpose: "external_llm",
		actionType: "fixture.generate",
		...overrides,
	};
}

describe("final LLM input substring attestation", () => {
	it("attests final message-bearing inputs without counting prompt aliases", async () => {
		const hint = "exact shared lifecycle instruction";
		const scoped = await runWithLlmInputSubstringAttestation(hint, async () => {
			await recordLlmCall(
				null,
				details({
					systemPrompt: `prefix\n${hint}\nsuffix`,
					messages: [{ role: "user", content: "delegate the work" }],
					prompt: hint,
					userPrompt: hint,
				}),
				async () => "ok",
			);
			await recordLlmCall(
				null,
				details({
					modelType: "RESPONSE_HANDLER",
					prompt: hint,
					userPrompt: hint,
				}),
				async () => "ok",
			);
			return "complete";
		});

		expect(scoped.result).toBe("complete");
		expect(scoped.attestation).toMatchObject({
			schemaVersion: 1,
			modelCallCount: 2,
			matchingCallCount: 2,
			totalOccurrences: 2,
			exactOncePerModelCall: true,
			modelTypeCallCounts: {
				ACTION_PLANNER: 1,
				RESPONSE_HANDLER: 1,
			},
		});
		expect(scoped.attestation.expectedSha256).toBe(
			"cc35ae69b855e91e3e16b7c8f84764b17327b423e902d0dbcb37f33f6652a7f7",
		);
		expect(JSON.stringify(scoped.attestation)).not.toContain(hint);
	});

	it("reads rich message content from the final messages surface", async () => {
		const hint = "message-only instruction";
		const scoped = await runWithLlmInputSubstringAttestation(hint, () =>
			recordLlmCall(
				null,
				details({
					systemPrompt: "system without instruction",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: hint },
								{ type: "file", mediaType: "text/plain" },
							],
						},
					],
					prompt: hint,
					userPrompt: hint,
				}),
				async () => "ok",
			),
		);

		expect(scoped.attestation.totalOccurrences).toBe(1);
		expect(scoped.attestation.exactOncePerModelCall).toBe(true);
	});

	it("rechecks provider retries while counting one logical model call", async () => {
		const hint = "retry-stable instruction";
		const call = details({ systemPrompt: hint });
		const provider = vi.fn();
		const scoped = await runWithLlmInputSubstringAttestation(hint, () => {
			attestLlmInputSubstring(call);
			provider();
			attestLlmInputSubstring(call);
			provider();
		});

		expect(provider).toHaveBeenCalledTimes(2);
		expect(scoped.attestation).toMatchObject({
			modelCallCount: 1,
			matchingCallCount: 1,
			totalOccurrences: 1,
			exactOncePerModelCall: true,
			modelTypeCallCounts: { ACTION_PLANNER: 1 },
		});

		const changedCall = details({ systemPrompt: hint });
		const changedProvider = vi.fn();
		await expect(
			runWithLlmInputSubstringAttestation(hint, () => {
				attestLlmInputSubstring(changedCall);
				changedProvider();
				changedCall.systemPrompt = "instruction removed before retry";
				attestLlmInputSubstring(changedCall);
				changedProvider();
			}),
		).rejects.toMatchObject({
			code: "LLM_INPUT_SUBSTRING_ATTESTATION_MISMATCH",
			context: { retryAttempt: true },
		});
		expect(changedProvider).toHaveBeenCalledTimes(1);
	});

	it.each([
		["missing", "unrelated system context"],
		["duplicate", "expected instruction expected instruction"],
	])(
		"rejects a %s instruction before invoking the provider",
		async (_label, systemPrompt) => {
			const provider = vi.fn(async () => "unreachable");
			await expect(
				runWithLlmInputSubstringAttestation("expected instruction", () =>
					recordLlmCall(
						null,
						details({
							systemPrompt,
							messages: [{ role: "user", content: "go" }],
						}),
						provider,
					),
				),
			).rejects.toMatchObject({
				code: "LLM_INPUT_SUBSTRING_ATTESTATION_MISMATCH",
			});
			expect(provider).not.toHaveBeenCalled();
		},
	);

	it("rejects a completed scope that never reached a model boundary", async () => {
		await expect(
			runWithLlmInputSubstringAttestation(
				"expected instruction",
				async () => "no model",
			),
		).rejects.toMatchObject({
			code: "LLM_INPUT_SUBSTRING_ATTESTATION_MISSING",
		});
	});

	it("keeps unscoped model calls usable without requiring attestation", async () => {
		const provider = vi.fn(async () => "unscoped");
		await expect(recordLlmCall(null, details(), provider)).resolves.toBe(
			"unscoped",
		);
		expect(provider).toHaveBeenCalledTimes(1);
	});

	it("propagates isolated scopes across concurrent async boundaries", async () => {
		const gate = Promise.withResolvers<void>();
		const first = runWithLlmInputSubstringAttestation(
			"first hint",
			async () => {
				await gate.promise;
				return recordLlmCall(
					null,
					details({ systemPrompt: "first hint" }),
					async () => "first",
				);
			},
		);
		const second = runWithLlmInputSubstringAttestation(
			"second hint",
			async () => {
				gate.resolve();
				return recordLlmCall(
					null,
					details({ systemPrompt: "second hint" }),
					async () => "second",
				);
			},
		);

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.attestation.exactOncePerModelCall).toBe(true);
		expect(secondResult.attestation.exactOncePerModelCall).toBe(true);
		expect(firstResult.attestation.expectedSha256).not.toBe(
			secondResult.attestation.expectedSha256,
		);
	});
});
