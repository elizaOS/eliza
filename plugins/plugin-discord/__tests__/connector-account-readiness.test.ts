/**
 * Exercises account inventory through the real connector manager while a
 * deterministic gateway boundary changes readiness, credentials, and accounts.
 */
import {
	ConnectorAccountManager,
	type IAgentRuntime,
	InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createDiscordConnectorAccountProvider } from "../connector-account-provider";

function inventory() {
	const accounts = {
		previous: { token: "previous-token", enabled: true },
		replacement: { token: "replacement-token", enabled: true },
	};
	const clients = new Map<string, { token: string; isReady(): boolean }>();
	let serviceAvailable = true;
	const runtime = {
		character: { settings: { discord: { accounts } } },
		getSetting: () => undefined,
		getService: () =>
			serviceAvailable
				? { getClient: (id: string) => clients.get(id) ?? null }
				: null,
	} as unknown as IAgentRuntime;
	const manager = new ConnectorAccountManager(
		undefined,
		new InMemoryConnectorAccountStorage(),
	);
	manager.registerProvider(createDiscordConnectorAccountProvider(runtime));
	return {
		accounts,
		clients,
		manager,
		stopService() {
			serviceAvailable = false;
		},
		async status(id: string) {
			return (await manager.getAccount("discord", id))?.status;
		},
	};
}

describe("Discord account gateway readiness", () => {
	it("requires the selected gateway to be ready and observes disconnects", async () => {
		const source = inventory();
		let ready = false;
		source.clients.set("replacement", {
			token: "replacement-token",
			isReady: () => ready,
		});
		expect(await source.status("replacement")).toBe("pending");
		ready = true;
		expect(await source.status("replacement")).toBe("connected");
		expect(await source.status("previous")).toBe("pending");
		ready = false;
		expect(await source.status("replacement")).toBe("pending");
	});

	it("does not reuse an old gateway after changing the configured token", async () => {
		const source = inventory();
		source.clients.set("replacement", {
			token: "replacement-token",
			isReady: () => true,
		});
		expect(await source.status("replacement")).toBe("connected");
		source.accounts.replacement.token = "new-token";
		expect(await source.status("replacement")).toBe("pending");
		source.clients.set("replacement", {
			token: "new-token",
			isReady: () => true,
		});
		expect(await source.status("replacement")).toBe("connected");
		source.stopService();
		expect(await source.status("replacement")).toBe("pending");
	});

	it("keeps disabled and credential-less accounts unavailable beside a ready sibling", async () => {
		const source = inventory();
		for (const id of ["previous", "replacement"] as const) {
			source.clients.set(id, {
				token: source.accounts[id].token,
				isReady: () => true,
			});
		}
		source.accounts.previous.enabled = false;
		expect(await source.status("previous")).toBe("disabled");
		expect(await source.status("replacement")).toBe("connected");
		source.accounts.replacement.token = "";
		expect(await source.status("replacement")).toBe("disabled");
	});

	it("reconciles stale connected storage with current gateway state", async () => {
		const source = inventory();
		await source.manager.upsertAccount("discord", {
			id: "replacement",
			status: "connected",
		});
		expect(await source.status("replacement")).toBe("pending");
		expect(
			(await source.manager.listAccounts("discord")).find(
				(a) => a.id === "replacement",
			)?.status,
		).toBe("pending");
	});

	it.each(["disabled", "revoked"] as const)(
		"preserves a stored %s decision after reconnect",
		async (status) => {
			const source = inventory();
			source.clients.set("replacement", {
				token: "replacement-token",
				isReady: () => true,
			});
			await source.manager.upsertAccount("discord", {
				id: "replacement",
				status,
			});
			expect(await source.status("replacement")).toBe(status);
		},
	);
});
