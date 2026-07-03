import {
	type AgentRuntime,
	type IAgentRuntime,
	ModelType,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Force a deterministic manual policy pinned to our fake cloud provider so the
// router picks it without consulting device tier / live signals / assignments.
const prefsState = {
	policy: { TEXT_LARGE: "manual" } as Record<string, string>,
	preferredProvider: { TEXT_LARGE: "test-cloud" } as Record<string, string>,
};

vi.mock("./routing-preferences", () => ({
	DEFAULT_ROUTING_POLICY: "prefer-local",
	readRoutingPreferences: vi.fn(async () => prefsState),
}));

import { installRouterHandler, ROUTER_PROVIDER } from "./router-handler";

type Handler = (
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Capture the router handler `installRouterHandler` registers for TEXT_LARGE,
 * then build a runtime whose live `models` map carries a provider handler for
 * the router to introspect and dispatch to — the path that used to depend on
 * the `registerModel` prototype monkey-patch.
 */
function setup(providerHandler: Handler) {
	const routerHandlers = new Map<string, Handler>();
	const installTarget = {
		registerModel: vi.fn(
			(modelType: string, handler: Handler, provider: string) => {
				if (provider === ROUTER_PROVIDER)
					routerHandlers.set(modelType, handler);
			},
		),
	} as unknown as AgentRuntime;
	installRouterHandler(installTarget, {
		skipSlots: [
			"TEXT_SMALL",
			"TEXT_EMBEDDING",
			"TEXT_TO_SPEECH",
			"TRANSCRIPTION",
		],
	});

	const runtime = {
		models: new Map<string, unknown[]>([
			[
				ModelType.TEXT_LARGE,
				[{ provider: "test-cloud", priority: 0, handler: providerHandler }],
			],
		]),
	} as unknown as IAgentRuntime;

	const router = routerHandlers.get(ModelType.TEXT_LARGE);
	if (!router) throw new Error("router handler for TEXT_LARGE not installed");
	return { router, runtime };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("router dispatches via runtime introspection, not a prototype patch", () => {
	it("invokes the registered provider handler resolved from runtime.models", async () => {
		const providerHandler = vi.fn(async () => "cloud-result");
		const { router, runtime } = setup(providerHandler);

		const result = await router(runtime, { prompt: "hi" });

		expect(result).toBe("cloud-result");
		expect(providerHandler).toHaveBeenCalledTimes(1);
		expect(providerHandler).toHaveBeenCalledWith(runtime, { prompt: "hi" });
	});

	it("surfaces the provider error in manual mode (no silent fallback)", async () => {
		const boom = new Error("cloud down");
		const providerHandler = vi.fn(async () => {
			throw boom;
		});
		const { router, runtime } = setup(providerHandler);

		await expect(router(runtime, { prompt: "hi" })).rejects.toBe(boom);
	});
});
