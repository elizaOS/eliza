/** ELIZA_ACTION_ALLOWLIST refuses unlisted actions for every caller, the agent included. */
import { afterEach, describe, expect, it } from "vitest";
import {
	actionGateRejection,
	assertActionAllowlistMatchesActions,
	readActionAllowlist,
	resolveActionGateFailure,
} from "../src/runtime/action-gate";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";
import type { IAgentRuntime } from "../src/types/runtime";

const agentId = "00000000-0000-4000-8000-0000000000a1" as UUID;
const settings = { name: "SETTINGS", roleGate: { minRole: "OWNER" as const } };
const databaseQuery = {
	name: "DATABASE_QUERY",
	roleGate: { minRole: "ADMIN" as const },
};
const reply = { name: "REPLY" };

afterEach(() => {
	delete process.env.ELIZA_ACTION_ALLOWLIST;
});

describe("ELIZA_ACTION_ALLOWLIST", () => {
	it("leaves every action to its own gates when unset", () => {
		expect(readActionAllowlist()).toBeNull();
		expect(actionGateRejection(settings, { userRoles: ["OWNER"] })).toBe(
			undefined,
		);
	});

	it("refuses an unlisted action for an OWNER caller and allows a listed one", () => {
		process.env.ELIZA_ACTION_ALLOWLIST = JSON.stringify(["REPLY"]);
		for (const action of [settings, databaseQuery]) {
			expect(
				actionGateRejection(action, { userRoles: ["OWNER"] }),
			).toMatchObject({
				kind: "context",
				reason: `Action ${action.name} is not available in this product`,
			});
		}
		expect(actionGateRejection(reply, { userRoles: ["OWNER"] })).toBe(
			undefined,
		);
	});

	it("refuses an unlisted action on the agent's own turn", async () => {
		process.env.ELIZA_ACTION_ALLOWLIST = JSON.stringify(["REPLY"]);
		const runtime = { agentId } as IAgentRuntime;
		const message = {
			entityId: agentId,
			roomId: agentId,
			content: { text: "scheduled trigger" },
		} as Memory;
		await expect(
			resolveActionGateFailure(runtime, settings, { message }),
		).resolves.toBe("Action SETTINGS is not available in this product");
		await expect(
			resolveActionGateFailure(runtime, reply, { message }),
		).resolves.toBeUndefined();
	});

	it("throws on a malformed setting instead of disabling it", () => {
		for (const raw of [
			"",
			"  ",
			"[REPLY",
			'{"REPLY":true}',
			'["REPLY", 3]',
			'[""]',
		]) {
			process.env.ELIZA_ACTION_ALLOWLIST = raw;
			expect(() => actionGateRejection(reply, {})).toThrow(
				expect.objectContaining({ code: "INVALID_ACTION_ALLOWLIST" }),
			);
		}
	});

	it("throws at boot when an entry names no registered action", () => {
		process.env.ELIZA_ACTION_ALLOWLIST = JSON.stringify(["REPLY", "RPLY"]);
		expect(() =>
			assertActionAllowlistMatchesActions([reply, settings]),
		).toThrow(
			expect.objectContaining({
				code: "INVALID_ACTION_ALLOWLIST",
				context: { unmatched: ["RPLY"] },
			}),
		);
		process.env.ELIZA_ACTION_ALLOWLIST = JSON.stringify(["REPLY"]);
		expect(() =>
			assertActionAllowlistMatchesActions([reply, settings]),
		).not.toThrow();
	});
});
