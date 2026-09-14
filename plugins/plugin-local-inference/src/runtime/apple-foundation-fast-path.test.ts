/**
 * Deterministic unit tests for the Apple Foundation Models fast path: boot
 * registration against a fake iOS bridge, per-call eligibility, the env kill
 * switch, and the parameter mapping onto the bridge's generate call.
 */
import { ElizaError, ModelType } from "@elizaos/core";
import type { IosComputerUseBridge } from "@elizaos/plugin-computeruse/mobile/ios-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	_resetAppleFoundationAdapterForTests,
	APPLE_FOUNDATION_GENERATE_FAILED,
	createAppleFoundationAdapter,
	getAppleFoundationAdapter,
	registerAppleFoundationAdapter,
} from "../backends/apple-foundation";
import {
	APPLE_FOUNDATION_FAST_PATH_ENV,
	APPLE_FOUNDATION_MAX_PROMPT_CHARS,
	APPLE_FOUNDATION_REPORT_SCOPE,
	attemptAppleFoundationFastPath,
	generateWithAppleFoundation,
	resolveAppleFoundationFastPath,
	resolveIosComputerUseBridge,
	truncateAtStopSequence,
	tryRegisterAppleFoundationAdapter,
} from "./apple-foundation-fast-path";

function makeBridge(
	overrides: Partial<IosComputerUseBridge> = {},
): IosComputerUseBridge {
	return {
		probe: () =>
			Promise.resolve({
				ok: true as const,
				data: {
					platform: "ios",
					osVersion: "26.0",
					capabilities: {
						replayKitForeground: false,
						broadcastExtension: false,
						visionOcr: false,
						appIntents: false,
						accessibilityRead: false,
						foundationModel: true,
					},
				},
			}),
		foundationModelGenerate: vi.fn(async () => ({
			ok: true as const,
			data: { text: "from apple", tokensIn: 3, tokensOut: 2, elapsedMs: 12 },
		})),
		...overrides,
	} as unknown as IosComputerUseBridge;
}

async function registerAvailableAdapter(bridge = makeBridge()) {
	const adapter = createAppleFoundationAdapter(() => bridge);
	registerAppleFoundationAdapter(adapter);
	adapter.available();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(adapter.available()).toBe(true);
	return { adapter, bridge };
}

describe("resolveIosComputerUseBridge", () => {
	it("returns the Capacitor ComputerUse handle when present and null otherwise", () => {
		const handle = makeBridge();
		expect(
			resolveIosComputerUseBridge({
				Capacitor: { Plugins: { ComputerUse: handle } },
			} as unknown as typeof globalThis),
		).toBe(handle);
		expect(resolveIosComputerUseBridge({} as typeof globalThis)).toBeNull();
		expect(
			resolveIosComputerUseBridge({
				Capacitor: { Plugins: {} },
			} as unknown as typeof globalThis),
		).toBeNull();
	});
});

describe("tryRegisterAppleFoundationAdapter", () => {
	afterEach(() => {
		_resetAppleFoundationAdapterForTests();
	});

	it("registers the adapter on iOS when the bridge probe reports foundationModel:true", async () => {
		const bridge = makeBridge();
		const result = await tryRegisterAppleFoundationAdapter({
			platform: "ios",
			getBridge: () => bridge,
		});
		expect(result).toEqual({ outcome: "registered" });
		expect(getAppleFoundationAdapter()?.name).toBe("apple-foundation");
	});

	it("skips off iOS, without a bridge, on a failed probe, and when the model is absent", async () => {
		expect(
			await tryRegisterAppleFoundationAdapter({
				platform: "android",
				getBridge: () => makeBridge(),
			}),
		).toEqual({ outcome: "skipped", reason: "not_ios" });
		expect(
			await tryRegisterAppleFoundationAdapter({
				platform: "ios",
				getBridge: () => null,
			}),
		).toEqual({ outcome: "skipped", reason: "bridge_unavailable" });
		expect(
			await tryRegisterAppleFoundationAdapter({
				platform: "ios",
				getBridge: () =>
					makeBridge({
						probe: () =>
							Promise.resolve({
								ok: false as const,
								code: "internal_error",
								message: "no",
							}),
					} as Partial<IosComputerUseBridge>),
			}),
		).toEqual({ outcome: "skipped", reason: "probe_failed" });
		expect(
			await tryRegisterAppleFoundationAdapter({
				platform: "ios",
				getBridge: () =>
					makeBridge({
						probe: () => Promise.reject(new Error("bridge crashed")),
					} as Partial<IosComputerUseBridge>),
			}),
		).toEqual({ outcome: "skipped", reason: "probe_failed" });
		const noModel = makeBridge();
		const probe = await noModel.probe();
		expect(
			await tryRegisterAppleFoundationAdapter({
				platform: "ios",
				getBridge: () =>
					makeBridge({
						probe: () =>
							Promise.resolve(
								probe.ok
									? {
											...probe,
											data: {
												...probe.data,
												capabilities: {
													...probe.data.capabilities,
													foundationModel: false,
												},
											},
										}
									: probe,
							),
					} as Partial<IosComputerUseBridge>),
			}),
		).toEqual({ outcome: "skipped", reason: "foundation_model_unavailable" });
		expect(getAppleFoundationAdapter()).toBeNull();
	});
});

describe("resolveAppleFoundationFastPath", () => {
	afterEach(() => {
		_resetAppleFoundationAdapterForTests();
	});

	it("returns null when no adapter is registered", () => {
		expect(
			resolveAppleFoundationFastPath(
				ModelType.TEXT_SMALL,
				{ prompt: "hi" },
				{},
			),
		).toBeNull();
	});

	it("serves plain short TEXT_SMALL and TEXT_COMPLETION calls only", async () => {
		const { adapter } = await registerAvailableAdapter();
		const short = { prompt: "Summarize: the cat sat." };
		expect(
			resolveAppleFoundationFastPath(ModelType.TEXT_SMALL, short, {}),
		).toBe(adapter);
		expect(
			resolveAppleFoundationFastPath(ModelType.TEXT_COMPLETION, short, {}),
		).toBe(adapter);
		for (const modelType of [
			ModelType.TEXT_LARGE,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]) {
			expect(resolveAppleFoundationFastPath(modelType, short, {})).toBeNull();
		}
	});

	it("declines long, empty, streaming, and structured-decoding requests", async () => {
		await registerAvailableAdapter();
		const decline = (params: Record<string, unknown>) =>
			expect(
				resolveAppleFoundationFastPath(
					ModelType.TEXT_SMALL,
					params as never,
					{},
				),
			).toBeNull();
		decline({ prompt: "" });
		decline({ messages: [{ role: "user", content: "hi" }] });
		decline({ prompt: "x".repeat(APPLE_FOUNDATION_MAX_PROMPT_CHARS + 1) });
		decline({ prompt: "hi", stream: true });
		decline({ prompt: "hi", streamStructured: true });
		decline({ prompt: "hi", onStreamChunk: () => undefined });
		decline({ prompt: "hi", grammar: "root ::= 'a'" });
		decline({ prompt: "hi", responseSkeleton: { kind: "json" } });
		decline({ prompt: "hi", spanSamplerPlan: {} });
		decline({ prompt: "hi", prefill: "{" });
		decline({ prompt: "hi", responseFormat: { type: "json_object" } });
		decline({ prompt: "hi", responseFormat: "json" });
		decline({ prompt: "hi", responseSchema: { type: "object" } });
		decline({
			prompt: "hi",
			tools: [{ name: "t", description: "", parameters: {} }],
		});
		decline({ prompt: "hi", toolChoice: "auto" });
		decline({ prompt: "hi", omitMaxTokens: true });
	});

	it("registration seeds availability so the first call is deterministic", async () => {
		let probes = 0;
		const bridge = makeBridge();
		const probe = bridge.probe;
		const counting = makeBridge({
			probe: () => {
				probes += 1;
				return probe();
			},
		} as Partial<IosComputerUseBridge>);
		await tryRegisterAppleFoundationAdapter({
			platform: "ios",
			getBridge: () => counting,
		});
		expect(probes).toBe(1);
		expect(
			resolveAppleFoundationFastPath(
				ModelType.TEXT_SMALL,
				{ prompt: "hi" },
				{},
			),
		).not.toBeNull();
		expect(probes).toBe(1);
	});

	it("honours the env kill switch and a not-yet-available adapter", async () => {
		const { adapter } = await registerAvailableAdapter();
		expect(
			resolveAppleFoundationFastPath(
				ModelType.TEXT_SMALL,
				{ prompt: "hi" },
				{ [APPLE_FOUNDATION_FAST_PATH_ENV]: "0" },
			),
		).toBeNull();
		expect(
			resolveAppleFoundationFastPath(
				ModelType.TEXT_SMALL,
				{ prompt: "hi" },
				{ [APPLE_FOUNDATION_FAST_PATH_ENV]: "1" },
			),
		).toBe(adapter);

		_resetAppleFoundationAdapterForTests();
		const pending = createAppleFoundationAdapter(() =>
			makeBridge({
				probe: () => new Promise(() => undefined),
			} as Partial<IosComputerUseBridge>),
		);
		registerAppleFoundationAdapter(pending);
		expect(
			resolveAppleFoundationFastPath(
				ModelType.TEXT_SMALL,
				{ prompt: "hi" },
				{},
			),
		).toBeNull();
	});
});

describe("generateWithAppleFoundation", () => {
	afterEach(() => {
		_resetAppleFoundationAdapterForTests();
	});

	it("maps prompt, maxTokens, temperature and system onto the bridge and returns the text", async () => {
		const { adapter, bridge } = await registerAvailableAdapter();
		const text = await generateWithAppleFoundation(adapter, {
			prompt: "Say hi",
			maxTokens: 64,
			temperature: 0.3,
			system: "You are terse.",
			// Stop sequences are deliberately absent from the bridge options:
			// FoundationModelOptions has no such field, so they are enforced by
			// trimming the returned text instead (next test).
			stopSequences: ["\n\n"],
		});
		expect(text).toBe("from apple");
		expect(bridge.foundationModelGenerate).toHaveBeenCalledWith({
			prompt: "Say hi",
			options: {
				maxTokens: 64,
				temperature: 0.3,
				instruction: "You are terse.",
			},
		});
	});

	it("cuts the completion at the Eliza turn markers and at caller stop sequences", async () => {
		const { adapter } = await registerAvailableAdapter(
			makeBridge({
				foundationModelGenerate: vi.fn(async () => ({
					ok: true as const,
					data: {
						text: "Hello there.<end_of_turn>\n<start_of_turn>user\nnext turn",
						tokensIn: 3,
						tokensOut: 9,
						elapsedMs: 4,
					},
				})),
			} as Partial<IosComputerUseBridge>),
		);
		await expect(
			generateWithAppleFoundation(adapter, { prompt: "Say hi" }),
		).resolves.toBe("Hello there.");
		await expect(
			generateWithAppleFoundation(adapter, {
				prompt: "Say hi",
				stopSequences: [" there"],
			}),
		).resolves.toBe("Hello");
		expect(truncateAtStopSequence("plain", ["<end_of_turn>"])).toBe("plain");
	});

	it("accepts a result without token accounting (FoundationModels reports none)", async () => {
		const { adapter } = await registerAvailableAdapter(
			makeBridge({
				foundationModelGenerate: vi.fn(async () => ({
					ok: true as const,
					data: { text: "no counts", elapsedMs: 7 },
				})),
			} as Partial<IosComputerUseBridge>),
		);
		await expect(
			generateWithAppleFoundation(adapter, { prompt: "Say hi" }),
		).resolves.toBe("no counts");
	});

	it("propagates a bridge failure as a typed error carrying the bridge code", async () => {
		const { adapter } = await registerAvailableAdapter(
			makeBridge({
				foundationModelGenerate: vi.fn(async () => ({
					ok: false as const,
					code: "foundation_model_error",
					message: "guardrail refused the prompt",
				})),
			} as Partial<IosComputerUseBridge>),
		);
		const failure = await generateWithAppleFoundation(adapter, {
			prompt: "Say hi",
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ElizaError);
		expect((failure as ElizaError).code).toBe(APPLE_FOUNDATION_GENERATE_FAILED);
		expect((failure as ElizaError).context).toEqual({
			bridgeCode: "foundation_model_error",
			bridgeMessage: "guardrail refused the prompt",
		});
	});
});

describe("attemptAppleFoundationFastPath", () => {
	afterEach(() => {
		_resetAppleFoundationAdapterForTests();
	});

	function makeRuntime() {
		return { reportError: vi.fn() };
	}

	function probeAnswering(foundationModel: boolean) {
		return vi.fn(async () => ({
			ok: true as const,
			data: {
				platform: "ios",
				osVersion: "26.0",
				capabilities: {
					replayKitForeground: false,
					broadcastExtension: false,
					visionOcr: false,
					appIntents: false,
					accessibilityRead: false,
					foundationModel,
				},
			},
		}));
	}

	it("returns the completion when the bridge serves the call", async () => {
		const { adapter } = await registerAvailableAdapter();
		const runtime = makeRuntime();
		await expect(
			attemptAppleFoundationFastPath(runtime, adapter, { prompt: "Say hi" }),
		).resolves.toEqual({ served: true, text: "from apple" });
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("hands a refused call back to llama.cpp, reports it, and keeps the adapter available", async () => {
		const { adapter } = await registerAvailableAdapter(
			makeBridge({
				foundationModelGenerate: vi.fn(async () => ({
					ok: false as const,
					code: "foundation_model_error",
					message: "guardrail refused the prompt",
				})),
			} as Partial<IosComputerUseBridge>),
		);
		const runtime = makeRuntime();
		await expect(
			attemptAppleFoundationFastPath(runtime, adapter, { prompt: "Say hi" }),
		).resolves.toEqual({ served: false, bridgeCode: "foundation_model_error" });
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
		const [scope, error, context] = runtime.reportError.mock.calls[0];
		expect(scope).toBe(APPLE_FOUNDATION_REPORT_SCOPE);
		expect(error).toBeInstanceOf(ElizaError);
		expect(context).toEqual({
			bridgeCode: "foundation_model_error",
			promptChars: 6,
			fallback: "llama.cpp",
		});
		expect(adapter.available()).toBe(true);
	});

	it("drops the cached availability when the bridge reports the model unavailable", async () => {
		const bridge = makeBridge({
			probe: probeAnswering(false),
			foundationModelGenerate: vi.fn(async () => ({
				ok: false as const,
				code: "foundation_model_unavailable",
				message: "Apple Intelligence is off",
			})),
		} as Partial<IosComputerUseBridge>);
		// Boot seeded the adapter from an earlier probe that said yes.
		const adapter = createAppleFoundationAdapter(() => bridge, {
			knownAvailable: true,
		});
		expect(adapter.available()).toBe(true);
		const runtime = makeRuntime();
		await expect(
			attemptAppleFoundationFastPath(runtime, adapter, { prompt: "Say hi" }),
		).resolves.toEqual({
			served: false,
			bridgeCode: "foundation_model_unavailable",
		});
		// The seed is gone: the next check re-probes and the fast path stays off
		// while the bridge keeps answering no.
		expect(adapter.available()).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(bridge.probe).toHaveBeenCalledTimes(1);
		expect(adapter.available()).toBe(false);
	});

	it("re-arms after a later probe answers yes again", async () => {
		const bridge = makeBridge({
			probe: probeAnswering(true),
			foundationModelGenerate: vi.fn(async () => ({
				ok: false as const,
				code: "foundation_model_unavailable",
				message: "model still loading",
			})),
		} as Partial<IosComputerUseBridge>);
		const adapter = createAppleFoundationAdapter(() => bridge, {
			knownAvailable: true,
		});
		await attemptAppleFoundationFastPath(makeRuntime(), adapter, {
			prompt: "Say hi",
		});
		expect(adapter.available()).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(adapter.available()).toBe(true);
	});

	it("keeps an abort as a rejection and does not report it", async () => {
		const { adapter } = await registerAvailableAdapter(
			makeBridge({
				foundationModelGenerate: vi.fn(async () => {
					throw new DOMException("Aborted", "AbortError");
				}),
			} as Partial<IosComputerUseBridge>),
		);
		const runtime = makeRuntime();
		await expect(
			attemptAppleFoundationFastPath(runtime, adapter, { prompt: "Say hi" }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(runtime.reportError).not.toHaveBeenCalled();
		expect(adapter.available()).toBe(true);
	});

	it("treats a bridge failure under an already-aborted signal as cancellation", async () => {
		const { adapter } = await registerAvailableAdapter(
			makeBridge({
				foundationModelGenerate: vi.fn(async () => ({
					ok: false as const,
					code: "foundation_model_error",
					message: "cut off",
				})),
			} as Partial<IosComputerUseBridge>),
		);
		const controller = new AbortController();
		controller.abort();
		const runtime = makeRuntime();
		await expect(
			attemptAppleFoundationFastPath(runtime, adapter, {
				prompt: "Say hi",
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(ElizaError);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});
});
