/**
 * Unit tests for `registerLocalInferenceBoot` — the plugin-owned PRE-READY boot
 * hook the app-core host drains through the generic boot-hook channel (instead
 * of hard-wiring these internals at fixed init points, arch-audit #12089 item
 * 18). Verifies the encapsulated ordering / platform gating that used to live in
 * `repairRuntimeAfterBoot`:
 *   - the mobile-voice-invariant warning fires regardless of platform,
 *   - on mobile the model handler installs ONLY when the mobile gate is on,
 *   - on desktop the model handler installs unconditionally.
 */
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the collaborators so the test exercises boot.ts's control flow only.
const ensureLocalInferenceHandler = vi.fn(async (_runtime: AgentRuntime) => {});
const shouldEnableMobileLocalInference = vi.fn(() => false);
const warnIfMobileGateActiveWithoutPlatform = vi.fn(() => false);
const isMobilePlatform = vi.fn(() => false);

vi.mock("./ensure-local-inference-handler", () => ({
	ensureLocalInferenceHandler: (r: AgentRuntime) =>
		ensureLocalInferenceHandler(r),
}));
vi.mock("./mobile-local-inference-gate", () => ({
	shouldEnableMobileLocalInference: () => shouldEnableMobileLocalInference(),
	warnIfMobileGateActiveWithoutPlatform: (_args: unknown) =>
		warnIfMobileGateActiveWithoutPlatform(),
}));
vi.mock("@elizaos/core", () => ({
	isMobilePlatform: () => isMobilePlatform(),
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { registerLocalInferenceBoot } from "./boot";

function makeFakeRuntime(): AgentRuntime {
	return {} as AgentRuntime;
}

describe("registerLocalInferenceBoot", () => {
	afterEach(() => {
		vi.clearAllMocks();
		isMobilePlatform.mockReturnValue(false);
		shouldEnableMobileLocalInference.mockReturnValue(false);
	});

	it("always emits the mobile-voice-invariant warning (evaluated regardless of platform)", async () => {
		isMobilePlatform.mockReturnValue(false);
		await registerLocalInferenceBoot(makeFakeRuntime());
		expect(warnIfMobileGateActiveWithoutPlatform).toHaveBeenCalledOnce();
	});

	it("installs the local model handler unconditionally on desktop", async () => {
		isMobilePlatform.mockReturnValue(false);
		const runtime = makeFakeRuntime();
		await registerLocalInferenceBoot(runtime);
		expect(ensureLocalInferenceHandler).toHaveBeenCalledOnce();
		expect(ensureLocalInferenceHandler).toHaveBeenCalledWith(runtime);
		// Desktop path must not consult the mobile gate for the handler decision.
		expect(shouldEnableMobileLocalInference).not.toHaveBeenCalled();
	});

	it("installs the handler on mobile ONLY when the mobile gate is on", async () => {
		isMobilePlatform.mockReturnValue(true);
		shouldEnableMobileLocalInference.mockReturnValue(true);
		const runtime = makeFakeRuntime();
		await registerLocalInferenceBoot(runtime);
		expect(shouldEnableMobileLocalInference).toHaveBeenCalledOnce();
		expect(ensureLocalInferenceHandler).toHaveBeenCalledOnce();
		expect(ensureLocalInferenceHandler).toHaveBeenCalledWith(runtime);
	});

	it("skips the handler on mobile when the mobile gate is off", async () => {
		isMobilePlatform.mockReturnValue(true);
		shouldEnableMobileLocalInference.mockReturnValue(false);
		await registerLocalInferenceBoot(makeFakeRuntime());
		expect(shouldEnableMobileLocalInference).toHaveBeenCalledOnce();
		expect(ensureLocalInferenceHandler).not.toHaveBeenCalled();
		// The invariant warning still fired even though no handler installed.
		expect(warnIfMobileGateActiveWithoutPlatform).toHaveBeenCalledOnce();
	});
});
