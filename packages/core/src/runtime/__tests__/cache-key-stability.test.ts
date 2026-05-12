import { describe, expect, it } from "vitest";

import {
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL,
	PLAN_ACTIONS_TOOL,
	STABLE_PLANNER_TOOLS,
} from "../../actions/to-tool";
import type { PromptSegment } from "../../types/model";
import { computePrefixHashes, hashStableJson } from "../context-hash";
import {
	cachePrefixSegments,
	normalizePromptSegments,
} from "../context-renderer";
import { buildProviderCachePlan } from "../provider-cache-plan";

/**
 * Cache-key stability CI gate.
 *
 * These hashes are snapshots of the Anthropic prompt-cache key inputs for a
 * fixed canonical Stage 1 / Stage 2 / planner-tool envelope. If any of these
 * hashes drift, the Anthropic cached prefix is busted and every subsequent PR
 * pays ~80% extra tokens until someone notices.
 *
 * When a hash change is INTENTIONAL (you genuinely meant to alter a stable
 * prompt segment, the planner tool schema, or the cache-key construction),
 * update the literal hash baked in below and document the change in
 * `docs/audits/lifeops-2026-05-11/cache-key-stability.md`.
 *
 * When the change is UNINTENTIONAL — typically a whitespace edit in a
 * prompt template, a reordered action list, an environment-dependent string,
 * or a new prompt segment that should have been marked `stable: false` — fix
 * the source, do NOT just rebase the snapshot.
 */

// -- Canonical Stage 1 prefix ------------------------------------------------
//
// A small fixed set of stable prompt segments simulating the static system
// prefix for Stage 1 (HANDLE_RESPONSE). No timestamps, no UUIDs, no
// environment-dependent strings.
const STAGE_1_CANONICAL_SEGMENTS: PromptSegment[] = normalizePromptSegments([
	{
		id: "agent-identity",
		label: "system",
		content: "You are a helpful assistant. Respond clearly and concisely.",
		stable: true,
	},
	{
		id: "available-contexts",
		label: "available_contexts",
		content: "- general: planning context\n- simple: trivial replies",
		stable: true,
	},
	{
		id: "protocol",
		label: "system",
		content:
			"Call HANDLE_RESPONSE exactly once per inbound message before any PLAN_ACTIONS calls.",
		stable: true,
	},
]);

// -- Canonical Stage 2 prefix ------------------------------------------------
//
// The Stage 2 planner prefix typically contains the Stage 1 prefix plus a
// fixed protocol description for PLAN_ACTIONS.
const STAGE_2_CANONICAL_SEGMENTS: PromptSegment[] = normalizePromptSegments([
	...STAGE_1_CANONICAL_SEGMENTS,
	{
		id: "planner-protocol",
		label: "system",
		content:
			"Use PLAN_ACTIONS to invoke an action by name with parameters. Action names live in available_actions.",
		stable: true,
	},
]);

function stableSegmentPrefixHash(segments: PromptSegment[]): string {
	const stableSegments = cachePrefixSegments(segments).filter(
		(segment) => segment.stable,
	);
	const prefixHashes = computePrefixHashes(stableSegments);
	const last = prefixHashes[prefixHashes.length - 1];
	if (!last) {
		throw new Error(
			"cache-key stability: stable prefix is empty — canonical segments lost their `stable: true` marker.",
		);
	}
	return last.hash;
}

describe("cache-key stability — Anthropic prompt-cache invariants", () => {
	it("Stage 1 stable-prefix hash is byte-stable for canonical input", () => {
		const prefixHash = stableSegmentPrefixHash(STAGE_1_CANONICAL_SEGMENTS);
		expect(prefixHash).toBe(
			"e3ec3d90577182cc5c430080e9373665c9b68d0380caae091239ae58632c9f0c",
		);
	});

	it("Stage 2 stable-prefix hash is byte-stable for canonical input", () => {
		const prefixHash = stableSegmentPrefixHash(STAGE_2_CANONICAL_SEGMENTS);
		expect(prefixHash).toBe(
			"a7a69c373a131c913d2a2964b0b3a381a33eac3dd4682448fac97ed1f6d9acaf",
		);
	});

	it("planner tool envelope (STABLE_PLANNER_TOOLS) is byte-stable", () => {
		const toolEnvelopeHash = hashStableJson(STABLE_PLANNER_TOOLS);
		expect(toolEnvelopeHash).toBe(
			"ffcc5806c797213dc187dd244e040c9506a40ab56d37ee7b046348a1061c5fa2",
		);
	});

	it("HANDLE_RESPONSE full (non-DM) envelope is byte-stable", () => {
		const fullEnvelopeHash = hashStableJson(HANDLE_RESPONSE_TOOL);
		expect(fullEnvelopeHash).toBe(
			"8efe679ac6a3928e621510eda82d5649253d234339a52d10ddf2c0cec5af164b",
		);
	});

	it("HANDLE_RESPONSE direct (DM) envelope is byte-stable", () => {
		const directEnvelopeHash = hashStableJson(
			createHandleResponseTool({ directMessage: true }),
		);
		expect(directEnvelopeHash).toBe(
			"6cdf4f3f0efd220778676fae7f5a19526def2ffb9af3968e1e47db3b9b384f38",
		);
	});

	it("PLAN_ACTIONS tool envelope is byte-stable", () => {
		const planActionsHash = hashStableJson(PLAN_ACTIONS_TOOL);
		expect(planActionsHash).toBe(
			"8535914469c2a514d4186027932272dad0440861675555b4f3f064dacec04e3d",
		);
	});

	it("buildProviderCachePlan emits the canonical promptCacheKey for the Stage 1 prefix", () => {
		const prefixHash = stableSegmentPrefixHash(STAGE_1_CANONICAL_SEGMENTS);
		const plan = buildProviderCachePlan({
			prefixHash,
			promptSegments: STAGE_1_CANONICAL_SEGMENTS,
		});
		expect(plan.promptCacheKey).toBe(`v5:${prefixHash}`);
	});
});

describe("cache-key churn detector — appending a suffix MUST NOT churn the prefix", () => {
	it("Stage 1 prefix hash is unchanged when an unstable suffix segment is appended", () => {
		const baseHash = stableSegmentPrefixHash(STAGE_1_CANONICAL_SEGMENTS);

		const withVolatileSuffix: PromptSegment[] = normalizePromptSegments([
			...STAGE_1_CANONICAL_SEGMENTS,
			{
				id: "current-user-message",
				label: "message:user",
				content: "What's the weather in Tokyo right now?",
				stable: false,
			},
		]);

		const churnedHash = stableSegmentPrefixHash(withVolatileSuffix);
		expect(churnedHash).toBe(baseHash);
	});

	it("Stage 1 prefix hash is unchanged across multiple turns of dynamic suffix", () => {
		const baseHash = stableSegmentPrefixHash(STAGE_1_CANONICAL_SEGMENTS);

		const withConversation: PromptSegment[] = normalizePromptSegments([
			...STAGE_1_CANONICAL_SEGMENTS,
			{
				id: "turn-1-user",
				label: "message:user",
				content: "Hello",
				stable: false,
			},
			{
				id: "turn-1-assistant",
				label: "message:assistant",
				content: "Hi there",
				stable: false,
			},
			{
				id: "turn-2-user",
				label: "message:user",
				content: "Goodbye",
				stable: false,
			},
		]);

		expect(stableSegmentPrefixHash(withConversation)).toBe(baseHash);
	});

	it("any change to a stable prefix segment DOES churn the hash (negative control)", () => {
		const baseHash = stableSegmentPrefixHash(STAGE_1_CANONICAL_SEGMENTS);

		const mutatedStablePrefix: PromptSegment[] = normalizePromptSegments([
			{
				id: "agent-identity",
				label: "system",
				// Intentionally different wording — should churn.
				content: "You are an unhelpful assistant. Respond unclearly.",
				stable: true,
			},
			...STAGE_1_CANONICAL_SEGMENTS.slice(1),
		]);

		expect(stableSegmentPrefixHash(mutatedStablePrefix)).not.toBe(baseHash);
	});
});
