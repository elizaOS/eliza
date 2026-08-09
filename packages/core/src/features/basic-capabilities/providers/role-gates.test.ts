/**
 * Declaration contract for current-room context provider role gates.
 * Deterministic, mock-free: asserts the declared `roleGate` floors directly.
 *
 * The agent host (packages/agent plugin-role-gating) withholds a provider's
 * entire output from senders below its declared `minRole`. Unassigned
 * group-channel senders resolve to GUEST, so any current-room coherence
 * provider gated above GUEST goes blank for ordinary channel members — the
 * live "chat's empty" incident (2026-08-09): RECENT_MESSAGES, WORLD, and
 * ENTITIES were withheld from every non-admin, leaving Stage 1 with no
 * transcript at all. These floors are load-bearing; tightening one re-breaks
 * group conversations for non-admin senders.
 */
import { describe, expect, it } from "vitest";
import { entitiesProvider } from "./entities.ts";
import { recentMessagesProvider } from "./recentMessages.ts";
import { worldProvider } from "./world.ts";

describe("current-room context providers stay readable at the GUEST floor", () => {
	it("RECENT_MESSAGES (the current-room transcript) is not gated above GUEST", () => {
		expect(recentMessagesProvider.roleGate).toEqual({ minRole: "GUEST" });
	});

	it("WORLD (current room/world shape) is not gated above GUEST", () => {
		expect(worldProvider.roleGate).toEqual({ minRole: "GUEST" });
	});

	it("ENTITIES (who is present in the current room) is not gated above GUEST", () => {
		expect(entitiesProvider.roleGate).toEqual({ minRole: "GUEST" });
	});
});
