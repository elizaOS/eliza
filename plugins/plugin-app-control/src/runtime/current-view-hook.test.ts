/**
 * Runtime hook tests for capturing and clearing current-view state.
 */

import type { PipelineHookContextForPhase } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { applyCurrentViewComposeHook } from "./current-view-hook.js";

type Ctx = PipelineHookContextForPhase<"compose_state_providers">;

function makeCtx(
	overrides: {
		text?: string;
		roomId?: string;
		onlyInclude?: boolean;
		current?: string[];
	} = {},
): Ctx {
	const {
		text = "",
		roomId = "11111111-1111-1111-1111-111111111111",
		onlyInclude = true,
		current = ["RECENT_MESSAGES"],
	} = overrides;
	return {
		phase: "compose_state_providers",
		message: {
			id: "00000000-0000-0000-0000-000000000000",
			entityId: "22222222-2222-2222-2222-222222222222",
			roomId,
			content: { text },
		},
		providers: { current: [...current] },
		activeContexts: [],
		onlyInclude,
		includeList: current,
	} as unknown as Ctx;
}

function augmented(userRequest: string): string {
	return [
		"Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
		"<contextual_documents>",
		'<source title="source-1">Open the inbox to review messages.</source>',
		"</contextual_documents>",
		"<user_request>",
		userRequest,
		"</user_request>",
	].join("\n");
}

describe("applyCurrentViewComposeHook (#8788)", () => {
	it("injects current_view on an imminent explicit command turn", () => {
		const ctx = makeCtx({ text: "open my wallet" });
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).toContain("current_view");
	});

	it("routes the user request rather than navigation text in retrieved context", () => {
		const explicit = makeCtx({ text: augmented("Open Notes") });
		applyCurrentViewComposeHook(explicit);
		expect(explicit.providers.current).toContain("current_view");

		const ordinary = makeCtx({ text: augmented("How are you?") });
		applyCurrentViewComposeHook(ordinary);
		expect(ordinary.providers.current).not.toContain("current_view");
	});

	it("does not replay prior-switch context on the next turn", () => {
		const ctx = makeCtx({ text: "thanks!" });
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).not.toContain("current_view");
	});

	it("does NOT inject on a non-switch turn", () => {
		const ctx = makeCtx({ text: "what's the weather like today" });
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).not.toContain("current_view");
	});

	it("does NOT inject for non-onlyInclude composes (planner already has it)", () => {
		const ctx = makeCtx({ text: "open my wallet", onlyInclude: false });
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).not.toContain("current_view");
	});

	it("is idempotent — never duplicates current_view", () => {
		const ctx = makeCtx({
			text: "open my wallet",
			current: ["RECENT_MESSAGES", "current_view"],
		});
		applyCurrentViewComposeHook(ctx);
		expect(
			ctx.providers.current.filter((n) => n === "current_view"),
		).toHaveLength(1);
	});
});
/**
 * Runtime hook tests for capturing and clearing current-view state.
 */
