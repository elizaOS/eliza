/** Unit tests for `installRouterHandler` wiring the routing-policy layer onto the runtime. Deterministic, fake runtime. */
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { installRouterHandler, ROUTER_PROVIDER } from "./router-handler";

describe("installRouterHandler", () => {
	it("does not register router handlers for skipped slots", () => {
		const registrations: Array<{
			modelType: string;
			provider: string;
			priority?: number;
		}> = [];
		const runtime = {
			registerModel: vi.fn(
				(
					modelType: string,
					_handler: unknown,
					provider: string,
					priority?: number,
				) => {
					registrations.push({ modelType, provider, priority });
				},
			),
		} as unknown as AgentRuntime;

		installRouterHandler(runtime, { skipSlots: ["TEXT_EMBEDDING"] });

		expect(registrations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					modelType: ModelType.TEXT_SMALL,
					provider: ROUTER_PROVIDER,
				}),
				expect.objectContaining({
					modelType: ModelType.TEXT_LARGE,
					provider: ROUTER_PROVIDER,
				}),
			]),
		);
		expect(
			registrations.some(
				(registration) => registration.modelType === ModelType.TEXT_EMBEDDING,
			),
		).toBe(false);
	});
});
