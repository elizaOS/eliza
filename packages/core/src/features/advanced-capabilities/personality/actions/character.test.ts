import { describe, expect, it, vi } from "vitest";
import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";

/**
 * #12087 Item 17: CHARACTER declares a coarse `roleGate: { minRole: "ADMIN" }`
 * (the floor enforced by canActionRun) but `update_identity` (rename agent /
 * replace system prompt) requires OWNER. That per-op requirement used to be
 * three scattered inline `hasRoleAccess` checks — invisible in the metadata and
 * contradicting the declared gate. It now lives in the single, exported
 * CHARACTER_OP_ACCESS map that the handler enforces uniformly.
 */
const rolesMock = vi.hoisted(() => ({ hasRoleAccess: vi.fn() }));
vi.mock("../../../../roles.ts", () => rolesMock);

import { CHARACTER_OP_ACCESS, characterAction } from "./character.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function runtime(): IAgentRuntime {
	return { agentId: AGENT_ID } as unknown as IAgentRuntime;
}

function message(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000010",
		entityId: "00000000-0000-0000-0000-000000000003",
		roomId: "00000000-0000-0000-0000-000000000002",
		content: { text: "rename yourself", source: "discord" },
	} as Memory;
}

async function runOp(op: string): Promise<{ success?: boolean } | undefined> {
	return characterAction.handler?.(
		runtime(),
		message(),
		{ data: {} } as unknown as State,
		{ parameters: { action: op, name: "New Name" } } as Record<string, unknown>,
		vi.fn() as unknown as HandlerCallback,
	);
}

describe("CHARACTER per-op role gating (#12087 Item 17)", () => {
	it("declares per-op minimum roles as visible, exported metadata", () => {
		expect(CHARACTER_OP_ACCESS.update_identity.minRole).toBe("OWNER");
		expect(CHARACTER_OP_ACCESS.modify.minRole).toBe("ADMIN");
		expect(CHARACTER_OP_ACCESS.persist.minRole).toBe("ADMIN");
		// The declared coarse gate is the floor (the least-privileged op) = ADMIN.
		expect(
			(characterAction as { roleGate?: { minRole?: string } }).roleGate,
		).toEqual({ minRole: "ADMIN" });
	});

	it("gates update_identity on OWNER — an ADMIN-but-not-OWNER caller is denied", async () => {
		rolesMock.hasRoleAccess.mockReset().mockResolvedValue(false);
		const result = await runOp("update_identity");
		expect(result?.success).toBe(false);
		expect(rolesMock.hasRoleAccess).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"OWNER",
		);
	});

	it("gates modify on the ADMIN floor", async () => {
		rolesMock.hasRoleAccess.mockReset().mockResolvedValue(false);
		const result = await runOp("modify");
		expect(result?.success).toBe(false);
		expect(rolesMock.hasRoleAccess).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"ADMIN",
		);
	});
});
