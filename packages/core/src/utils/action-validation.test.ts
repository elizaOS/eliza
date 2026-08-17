/**
 * Unit tests for hasActionContext in packages/core/src/utils/action-validation.ts.
 */

import { describe, expect, it } from "vitest";
import type { AgentContext, Memory, State } from "../types/index";
import { hasActionContext } from "./action-validation";
import {
	CONTEXT_ROUTING_METADATA_KEY,
	CONTEXT_ROUTING_STATE_KEY,
} from "./context-routing";

describe("hasActionContext", () => {
	const baseMessage: Memory = {
		id: "11111111-1111-1111-1111-111111111111" as `${string}-${string}-${string}-${string}-${string}`,
		entityId:
			"22222222-2222-2222-2222-222222222222" as `${string}-${string}-${string}-${string}-${string}`,
		roomId:
			"33333333-3333-3333-3333-333333333333" as `${string}-${string}-${string}-${string}-${string}`,
		content: {
			text: "test message",
		},
	};

	it("returns false safely without throwing when options is undefined", () => {
		expect(hasActionContext(baseMessage, undefined, undefined)).toBe(false);
	});

	it("returns true when state context routing overlaps declared action contexts", () => {
		const state: State = {
			values: {
				[CONTEXT_ROUTING_STATE_KEY]: {
					primaryContext: "trading",
					secondaryContexts: ["wallet"],
				},
			},
			data: {},
			text: "",
		};

		const eligible = hasActionContext(baseMessage, state, {
			contexts: ["trading" as AgentContext],
		});
		expect(eligible).toBe(true);
	});

	it("returns true when message metadata context routing overlaps declared action contexts", () => {
		const messageWithContext: Memory = {
			...baseMessage,
			content: {
				text: "swap sol for usdc",
				metadata: {
					[CONTEXT_ROUTING_METADATA_KEY]: {
						primaryContext: "crypto",
						secondaryContexts: ["trading"],
					},
				},
			},
		};

		const eligible = hasActionContext(messageWithContext, undefined, {
			contexts: ["trading" as AgentContext],
		});
		expect(eligible).toBe(true);
	});

	it("returns false when active contexts do not overlap declared action contexts", () => {
		const state: State = {
			values: {
				[CONTEXT_ROUTING_STATE_KEY]: {
					primaryContext: "social",
					secondaryContexts: ["chat"],
				},
			},
			data: {},
			text: "",
		};

		const eligible = hasActionContext(baseMessage, state, {
			contexts: ["trading" as AgentContext],
		});
		expect(eligible).toBe(false);
	});
});
