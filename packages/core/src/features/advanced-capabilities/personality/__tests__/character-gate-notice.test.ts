/**
 * Covers the CHARACTER_GATE_NOTICE provider against the in-memory FakeRuntime
 * with the real characterAction gate metadata and real hasRoleAccess (no live
 * model, no DB): a below-gate sender's explicit character-modification ask
 * produces a model-visible notice, an owner's ask and non-asks stay silent, and
 * an ACTION_ROLE_POLICY loosening suppresses the notice entirely.
 */
import { afterEach, describe, expect, test } from "vitest";
import { _resetActionRolePolicyCacheForTests } from "../../../../runtime/action-role-policy.ts";
import type { IAgentRuntime, Memory, UUID } from "../../../../types/index.ts";
import { characterAction } from "../actions/character.ts";
import { characterGateNoticeProvider } from "../providers/character-gate-notice.ts";
import { makeFakeRuntime, makeMessage } from "./test-helpers.ts";

const OWNER = "00000000-0000-4000-8000-0000000000aa" as UUID;
const GUEST = "00000000-0000-4000-8000-0000000000bb" as UUID;

const EXPLICIT_ASK = "change your personality to never say bet";

function gateRuntime(): IAgentRuntime {
	const fake = makeFakeRuntime({ owner: OWNER });
	const runtimeMutable = fake.runtime as unknown as {
		actions: unknown[];
		reportError: () => void;
	};
	runtimeMutable.actions = [characterAction];
	runtimeMutable.reportError = () => {};
	return fake.runtime;
}

function connectorMessage(
	runtime: IAgentRuntime,
	args: {
		entityId: UUID;
		text: string;
	},
): Memory {
	const message = makeMessage({
		entityId: args.entityId,
		agentId: runtime.agentId,
		text: args.text,
	});
	// A connector source keeps the unresolved-role floor at GUEST (roles.ts),
	// matching the live Discord turn this notice exists for.
	message.content.source = "discord";
	return message;
}

afterEach(() => {
	delete process.env.ACTION_ROLE_POLICY;
	_resetActionRolePolicyCacheForTests();
});

describe("CHARACTER_GATE_NOTICE", () => {
	test("a GUEST's explicit character-change ask surfaces the gated-capability notice", async () => {
		const runtime = gateRuntime();
		const result = await characterGateNoticeProvider.get(
			runtime,
			connectorMessage(runtime, { entityId: GUEST, text: EXPLICIT_ASK }),
		);
		expect(result.text).toContain("Character modification access notice");
		expect(result.text).toContain("ADMIN");
		expect(result.text).toContain("Do not promise");
		expect(result.values?.characterModificationGated).toBe(true);
		expect(result.values?.requiredRole).toBe("ADMIN");
	});

	test("the owner's identical ask produces no notice", async () => {
		const runtime = gateRuntime();
		const result = await characterGateNoticeProvider.get(
			runtime,
			connectorMessage(runtime, { entityId: OWNER, text: EXPLICIT_ASK }),
		);
		expect(result.text).toBe("");
		expect(result.values?.characterModificationGated).toBeUndefined();
	});

	test("a GUEST's unrelated message produces no notice", async () => {
		const runtime = gateRuntime();
		const result = await characterGateNoticeProvider.get(
			runtime,
			connectorMessage(runtime, {
				entityId: GUEST,
				text: "what's the weather today",
			}),
		);
		expect(result.text).toBe("");
	});

	test("an inconclusive character mention produces no notice", async () => {
		const runtime = gateRuntime();
		const result = await characterGateNoticeProvider.get(
			runtime,
			connectorMessage(runtime, {
				entityId: GUEST,
				text: "hmm your personality could probably improve somehow",
			}),
		);
		expect(result.text).toBe("");
	});

	test("an ACTION_ROLE_POLICY loosening to GUEST suppresses the notice", async () => {
		process.env.ACTION_ROLE_POLICY = '{"CHARACTER":"GUEST"}';
		_resetActionRolePolicyCacheForTests();
		const runtime = gateRuntime();
		const result = await characterGateNoticeProvider.get(
			runtime,
			connectorMessage(runtime, { entityId: GUEST, text: EXPLICIT_ASK }),
		);
		expect(result.text).toBe("");
	});
});
