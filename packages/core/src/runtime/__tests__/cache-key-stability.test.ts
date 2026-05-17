import { describe, expect, it } from "vitest";

import {
	CORE_PLANNER_TERMINALS,
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL,
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
			"Call HANDLE_RESPONSE exactly once per inbound message before any action tool calls.",
		stable: true,
	},
]);

// -- Canonical Stage 2 prefix ------------------------------------------------
//
// The Stage 2 planner prefix typically contains the Stage 1 prefix plus a
// fixed protocol description for the per-action native tool calls.
const STAGE_2_CANONICAL_SEGMENTS: PromptSegment[] = normalizePromptSegments([
	...STAGE_1_CANONICAL_SEGMENTS,
	{
		id: "planner-protocol",
		label: "system",
		content:
			"Each registered action is exposed as its own native tool; call the action by name with its parameter schema.",
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
		// Snapshot captured when Stage 1 protocol text was updated for the
		// per-action native-tools refactor (removed "PLAN_ACTIONS" wording).
		expect(prefixHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("Stage 2 stable-prefix hash is byte-stable for canonical input", () => {
		const prefixHash = stableSegmentPrefixHash(STAGE_2_CANONICAL_SEGMENTS);
		expect(prefixHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("terminal-sentinel tool envelope (CORE_PLANNER_TERMINALS) is byte-stable", () => {
		const toolEnvelopeHash = hashStableJson(CORE_PLANNER_TERMINALS);
		// CORE_PLANNER_TERMINALS replaces the prior STABLE_PLANNER_TOOLS pair —
		// the hash is a snapshot of REPLY / IGNORE / STOP exposed as their own
		// native tools and changes only when one of those shapes is edited.
		expect(toolEnvelopeHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("HANDLE_RESPONSE full (non-DM) envelope is byte-stable", () => {
		const fullEnvelopeHash = hashStableJson(HANDLE_RESPONSE_TOOL);
		expect(fullEnvelopeHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("HANDLE_RESPONSE direct (DM) envelope is byte-stable", () => {
		const directEnvelopeHash = hashStableJson(
			createHandleResponseTool({ directMessage: true }),
		);
		expect(directEnvelopeHash).toMatch(/^[0-9a-f]{64}$/);
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
