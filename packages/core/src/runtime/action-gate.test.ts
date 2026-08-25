/**
 * Deterministic unit tests for the unified action gate (`canActionRun` /
 * `actionGateFailure`) — synthetic in-process actions, no live model or DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	getTrustedDeliveryAudience,
} from "../security/trusted-delivery-audience";
import type { IAgentRuntime, Room, UUID } from "../types";
import { ChannelType } from "../types";
import type { Action } from "../types/components";
import type { AgentContext, RoleGateRole } from "../types/contexts";
import type { Memory } from "../types/memory";
import {
	type ActionGateContext,
	actionGateFailure,
	actionGateRejection,
	canActionRun,
	type GateableAction,
} from "./action-gate";
import {
	_resetActionRolePolicyCacheForTests,
	warnOnUnmatchedActionRolePolicyKeys,
} from "./action-role-policy";

/**
 * #12087 Item 9: one gate — `canActionRun` — for every exposure/execution path
 * (planner selection, sub-planner child filtering, the tool-call executor, the
 * shortcut gate). These tests pin the precedence (private → policy → contextGate
 * → roleGate) and the two divergences the audit called out: the executor's
 * private-gate enforcement and the sub-planner OR-filter that admitted a child
 * whose ACTION_ROLE_POLICY role the caller fails.
 */

function action(overrides: Partial<GateableAction> & { name: string }): Action {
	return {
		description: "",
		validate: async () => true,
		handler: async () => ({ text: "" }),
		examples: [],
		...overrides,
	} as unknown as Action;
}

const userTurn: Memory = {
	content: { text: "hi" },
} as Memory;

const autonomousTurn: Memory = {
	content: { text: "self", metadata: { isAutonomous: true } },
} as Memory;

function ctx(over: Partial<ActionGateContext> = {}): ActionGateContext {
	return {
		message: userTurn,
		userRoles: ["USER"],
		activeContexts: [],
		...over,
	};
}

afterEach(() => {
	_resetActionRolePolicyCacheForTests();
	delete process.env.ACTION_ROLE_POLICY;
});

describe("canActionRun — roleGate", () => {
	it("denies a USER an OWNER-gated action, allows an OWNER", () => {
		const owned = action({ name: "SECRETS", roleGate: { minRole: "OWNER" } });
		expect(canActionRun(owned, ctx({ userRoles: ["USER"] }))).toBe(false);
		expect(actionGateRejection(owned, ctx({ userRoles: ["USER"] }))?.kind).toBe(
			"role",
		);
		expect(canActionRun(owned, ctx({ userRoles: ["OWNER"] }))).toBe(true);
	});

	it("a stored MEMBER (USER-tier alias) clears a minRole:USER gate", () => {
		const gated = action({ name: "NOTE", roleGate: { minRole: "USER" } });
		expect(
			canActionRun(gated, ctx({ userRoles: ["MEMBER" as RoleGateRole] })),
		).toBe(true);
	});
});

describe("canActionRun — private-action gate", () => {
	const priv = action({ name: "REFLECT", private: true });

	it("withholds a private action on a user turn but not the autonomous loop", () => {
		expect(canActionRun(priv, ctx({ message: userTurn }))).toBe(false);
		expect(canActionRun(priv, ctx({ message: autonomousTurn }))).toBe(true);
	});

	it("skipPrivateGate lets static exposure paths pass a private action", () => {
		expect(
			canActionRun(priv, ctx({ message: userTurn, skipPrivateGate: true })),
		).toBe(true);
	});

	it("returns a descriptive failure reason", () => {
		expect(actionGateFailure(priv, ctx({ message: userTurn }))).toMatch(
			/private/i,
		);
		expect(actionGateRejection(priv, ctx({ message: userTurn }))?.kind).toBe(
			"private",
		);
	});
});

describe("canActionRun — ACTION_ROLE_POLICY replaces the declared gate", () => {
	beforeEach(() => {
		_resetActionRolePolicyCacheForTests();
	});

	it("policy loosens: an OWNER-gated action becomes USER-reachable", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ SHELL: "USER" });
		_resetActionRolePolicyCacheForTests();
		const shell = action({ name: "SHELL", roleGate: { minRole: "OWNER" } });
		expect(canActionRun(shell, ctx({ userRoles: ["USER"] }))).toBe(true);
	});

	it("policy still gates: a caller below the policy role is denied", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ SHELL: "ADMIN" });
		_resetActionRolePolicyCacheForTests();
		const shell = action({ name: "SHELL", contexts: [] });
		// GUEST fails the ADMIN policy even though the action has no roleGate —
		// this is the sub-planner OR-filter bug: contextGate passing must NOT admit
		// a child whose policy role the caller fails.
		expect(canActionRun(shell, ctx({ userRoles: ["GUEST"] }))).toBe(false);
		expect(canActionRun(shell, ctx({ userRoles: ["ADMIN"] }))).toBe(true);
	});

	it("cannot loosen a component's owner-exclusive disclosure policy", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ SECRETS: "GUEST" });
		_resetActionRolePolicyCacheForTests();
		const secrets = action({
			name: "SECRETS",
			disclosureGate: { require: "owner_exclusive" },
		});

		expect(canActionRun(secrets, ctx({ userRoles: ["OWNER"] }))).toBe(false);
		expect(actionGateFailure(secrets, ctx({ userRoles: ["OWNER"] }))).toContain(
			"missing_attestation",
		);
		expect(
			actionGateRejection(secrets, ctx({ userRoles: ["OWNER"] }))?.kind,
		).toBe("disclosure");
	});
});

describe("warnOnUnmatchedActionRolePolicyKeys (#12087 Item 19)", () => {
	it("flags policy keys matching no registered action name", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({
			SHELL: "OWNER",
			RENAMED_OLD_NAME: "USER",
		});
		_resetActionRolePolicyCacheForTests();
		const unmatched = warnOnUnmatchedActionRolePolicyKeys([
			{ name: "SHELL" },
			{ name: "REPLY", similes: ["RESPOND"] },
		]);
		expect(unmatched).toEqual(["RENAMED_OLD_NAME"]);
	});

	it("does not treat action similes as policy keys", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ RESPOND: "USER" });
		_resetActionRolePolicyCacheForTests();
		expect(
			warnOnUnmatchedActionRolePolicyKeys([
				{ name: "REPLY", similes: ["RESPOND"] },
			]),
		).toEqual(["RESPOND"]);
	});

	it("is a no-op when no policy is configured", () => {
		_resetActionRolePolicyCacheForTests();
		expect(warnOnUnmatchedActionRolePolicyKeys([{ name: "SHELL" }])).toEqual(
			[],
		);
	});
});

describe("canActionRun — contextGate", () => {
	it("denies an action whose required context is not active", () => {
		const coding = action({
			name: "FILE",
			contextGate: { contexts: ["coding" as AgentContext] },
		});
		expect(canActionRun(coding, ctx({ activeContexts: [] }))).toBe(false);
		expect(actionGateRejection(coding, ctx({ activeContexts: [] }))?.kind).toBe(
			"context",
		);
		expect(
			canActionRun(coding, ctx({ activeContexts: ["coding" as AgentContext] })),
		).toBe(true);
	});
});

/**
 * Gate-routing proof (split-disclosure PR2): the unified action gate routes the
 * `audience_admission` disclosure variant through the min-over-members policy
 * over the ATTESTED audience. The pre-wiring gate had no such variant and
 * `disclosureGateFailure` returned undefined for anything but `owner_exclusive`
 * — so a component carrying this policy would have been ALLOWED into a group
 * room (a leak). These assertions fail without the wiring and pass with it.
 */
describe("actionGateRejection — audience_admission disclosure variant", () => {
	const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
	const AGENT = "22222222-2222-2222-2222-222222222222" as UUID;
	const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;
	const ROOM = "44444444-4444-4444-4444-444444444444" as UUID;

	function attestRuntime(type: ChannelType, participants: UUID[]) {
		return {
			agentId: AGENT,
			getRoom: async (roomId: UUID) =>
				roomId === ROOM
					? ({ id: ROOM, agentId: AGENT, type, source: "test" } as Room)
					: null,
			getParticipantsForRoom: async () => [...participants],
			getSetting: (key: string) =>
				key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : undefined,
			reportError: () => {},
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		} as unknown as IAgentRuntime;
	}

	async function attestedTurn(
		type: ChannelType,
		participants: UUID[],
	): Promise<Memory> {
		const msg = {
			id: "66666666-6666-6666-6666-666666666666" as UUID,
			entityId: OWNER,
			agentId: AGENT,
			roomId: ROOM,
			content: { text: "surface owner-private artifact", source: "discord" },
		} as Memory;
		await attestDeliveryAudienceFromCanonicalRoom(
			attestRuntime(type, participants),
			msg,
			{ nowMs: 1_000 },
		);
		if (!getTrustedDeliveryAudience(msg)) {
			throw new Error("attestation did not bind");
		}
		return msg;
	}

	const gated = action({
		name: "OWNER_ARTIFACT",
		disclosureGate: {
			require: "audience_admission",
			subject: { scope: "owner-private", scopedEntityId: OWNER },
		},
	});

	it("allows the component in a two-party owner DM", async () => {
		const message = await attestedTurn(ChannelType.DM, [OWNER, AGENT]);
		expect(canActionRun(gated, ctx({ message, userRoles: ["OWNER"] }))).toBe(
			true,
		);
	});

	it("denies the component when an ungranted third member is present", async () => {
		const message = await attestedTurn(ChannelType.GROUP, [
			OWNER,
			AGENT,
			GUEST,
		]);
		const rej = actionGateRejection(
			gated,
			ctx({ message, userRoles: ["OWNER"] }),
		);
		expect(rej?.kind).toBe("disclosure");
		expect(rej?.reason).toContain("Audience-admission disclosure denied");
	});

	it("denies fail-closed when the turn carries no attestation", () => {
		const rej = actionGateRejection(
			gated,
			ctx({ message: userTurn, userRoles: ["OWNER"] }),
		);
		expect(rej?.kind).toBe("disclosure");
		expect(rej?.reason).toContain("missing_attestation");
	});
});
