/** Verifies every Discord DM policy through the shared message/interaction access boundary. */

import {
	checkPairingAllowed,
	getConnectorAdminWhitelist,
	type IAgentRuntime,
	isInAllowlist,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDiscordDmAccess } from "../dm-access";
import type { DiscordSettings } from "../types";

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...actual,
		checkPairingAllowed: vi.fn(),
		getConnectorAdminWhitelist: vi.fn(),
		isInAllowlist: vi.fn(),
	};
});

const user = {
	id: "user-1",
	username: "asker",
	displayName: "Asker",
	discriminator: "0",
};

function runtime(): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa",
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

async function check(settings: DiscordSettings) {
	return checkDiscordDmAccess(runtime(), settings, user);
}

describe("checkDiscordDmAccess", () => {
	beforeEach(() => {
		vi.mocked(isInAllowlist).mockReset();
		vi.mocked(checkPairingAllowed).mockReset();
		vi.mocked(getConnectorAdminWhitelist).mockReset();
		vi.mocked(getConnectorAdminWhitelist).mockReturnValue({});
	});

	it("distinguishes disabled, open, and statically allowed policies", async () => {
		await expect(check({ dmPolicy: "disabled" })).resolves.toEqual({
			allowed: false,
		});
		await expect(check({ dmPolicy: "open" })).resolves.toEqual({
			allowed: true,
		});
		await expect(
			check({ dmPolicy: "allowlist", allowFrom: [user.id] }),
		).resolves.toEqual({ allowed: true });
	});

	it("uses the dynamic allowlist without starting pairing", async () => {
		vi.mocked(isInAllowlist)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		await expect(check({ dmPolicy: "allowlist" })).resolves.toEqual({
			allowed: true,
		});
		await expect(check({ dmPolicy: "allowlist" })).resolves.toEqual({
			allowed: false,
		});
		expect(checkPairingAllowed).not.toHaveBeenCalled();
	});

	it("allows connector admins through the pairing policy", async () => {
		vi.mocked(getConnectorAdminWhitelist).mockReturnValue({
			discord: [user.id],
		});
		await expect(check({ dmPolicy: "pairing" })).resolves.toEqual({
			allowed: true,
		});
		expect(checkPairingAllowed).not.toHaveBeenCalled();
	});

	it("returns a new pairing request message but suppresses repeated prompts", async () => {
		vi.mocked(checkPairingAllowed)
			.mockResolvedValueOnce({
				allowed: false,
				newRequest: true,
				pairingCode: "PAIR-1",
				replyMessage: "Pair with code PAIR-1",
			})
			.mockResolvedValueOnce({
				allowed: false,
				newRequest: false,
				pairingCode: "PAIR-1",
				replyMessage: "Pair with code PAIR-1",
			});
		await expect(check({ dmPolicy: "pairing" })).resolves.toEqual({
			allowed: false,
			replyMessage: "Pair with code PAIR-1",
		});
		await expect(check({ dmPolicy: "pairing" })).resolves.toEqual({
			allowed: false,
		});
	});

	it("allows a user accepted by the pairing service", async () => {
		vi.mocked(checkPairingAllowed).mockResolvedValue({ allowed: true });
		await expect(check({ dmPolicy: "pairing" })).resolves.toEqual({
			allowed: true,
		});
	});
});
