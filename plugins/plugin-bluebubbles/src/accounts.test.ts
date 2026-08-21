/**
 * Unit tests for BlueBubbles multi-account resolution in `accounts.ts`.
 * Fail-closes ghost / unrecognized accountIds so they cannot inherit the
 * owner's BLUEBUBBLES_SERVER_URL, BLUEBUBBLES_PASSWORD, webhook, or
 * auto-start. Uses a hand-built fake runtime; no live BlueBubbles server.
 */
import type { Character, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	type BlueBubblesMultiAccountConfig,
	listEnabledBlueBubblesAccounts,
	resolveBlueBubblesAccount,
} from "./accounts";

function createRuntime(
	bluebubbles?: BlueBubblesMultiAccountConfig,
	env?: Record<string, string | undefined>,
): IAgentRuntime {
	const character: Partial<Character> = {
		settings: bluebubbles ? { bluebubbles } : {},
	};
	const settings = env ?? {};
	return {
		agentId: "agent-1",
		character: character as Character,
		getSetting: (key: string) => settings[key] ?? null,
	} as unknown as IAgentRuntime;
}

describe("resolveBlueBubblesAccount owner-bind fail-closed", () => {
	const ownerEnv = {
		BLUEBUBBLES_SERVER_URL: "http://owner.example:1234",
		BLUEBUBBLES_PASSWORD: "owner-password",
		BLUEBUBBLES_WEBHOOK_PATH: "/owner-hook",
		BLUEBUBBLES_AUTOSTART_COMMAND: "/owner/BlueBubbles.app",
	};

	it("lets the default account inherit owner env identity and transport", () => {
		const rt = createRuntime(undefined, ownerEnv);
		const resolved = resolveBlueBubblesAccount(rt, "default");
		expect(resolved.accountId).toBe("default");
		expect(resolved.serverUrl).toBe("http://owner.example:1234");
		expect(resolved.configured).toBe(true);
		expect(resolved.config?.password).toBe("owner-password");
		expect(resolved.config?.webhookPath).toBe("/owner-hook");
		expect(resolved.config?.autoStartCommand).toBe("/owner/BlueBubbles.app");
	});

	it("does not give a ghost accountId the owner server URL or password", () => {
		const rt = createRuntime(
			{
				accounts: {
					work: {
						serverUrl: "http://work.example:1234",
						password: "work-secret",
					},
				},
			},
			ownerEnv,
		);
		const ghost = resolveBlueBubblesAccount(rt, "ghost-account");
		expect(ghost.accountId).toBe("ghost-account");
		expect(ghost.serverUrl).toBe("");
		expect(ghost.configured).toBe(false);
		expect(ghost.config).toBeNull();
	});

	it("does not let a named account without its own creds inherit env identity", () => {
		const rt = createRuntime(
			{ accounts: { work: { enabled: true } } },
			ownerEnv,
		);
		const work = resolveBlueBubblesAccount(rt, "work");
		expect(work.accountId).toBe("work");
		expect(work.serverUrl).toBe("");
		expect(work.configured).toBe(false);
		expect(work.config).toBeNull();
	});

	it("keeps a named account's own server and does not attach owner env transport", () => {
		const rt = createRuntime(
			{
				accounts: {
					work: {
						enabled: true,
						serverUrl: "http://work.example:1234",
						password: "work-secret",
						webhookPath: "/work-hook",
					},
				},
			},
			ownerEnv,
		);
		const work = resolveBlueBubblesAccount(rt, "work");
		expect(work.accountId).toBe("work");
		expect(work.serverUrl).toBe("http://work.example:1234");
		expect(work.configured).toBe(true);
		expect(work.config?.password).toBe("work-secret");
		expect(work.config?.webhookPath).toBe("/work-hook");
		expect(work.config?.autoStartCommand).toBeUndefined();
	});

	it("lists only accounts that own their own credentials", () => {
		const rt = createRuntime(
			{
				accounts: {
					work: {
						serverUrl: "http://work.example:1234",
						password: "work-secret",
					},
					ghosty: { enabled: true },
				},
			},
			ownerEnv,
		);
		const enabled = listEnabledBlueBubblesAccounts(rt);
		expect(enabled.map((item) => item.accountId).sort()).toEqual([
			"default",
			"work",
		]);
	});
});
