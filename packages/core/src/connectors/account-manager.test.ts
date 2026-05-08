import { describe, expect, it, vi } from "vitest";
import type { TargetInfo } from "../types";
import type {
	IAgentRuntime,
	MessageConnectorRegistration,
	PostConnectorRegistration,
} from "../types/runtime";
import { getConnectorAccountManager } from "./account-manager";

class TestRuntime {
	private messageConnectors: MessageConnectorRegistration[] = [];
	private postConnectors: PostConnectorRegistration[] = [];

	getService(): undefined {
		return undefined;
	}

	getMessageConnectors(): MessageConnectorRegistration[] {
		return this.messageConnectors;
	}

	registerMessageConnector(connector: MessageConnectorRegistration): void {
		this.messageConnectors.push(connector);
	}

	getPostConnectors(): PostConnectorRegistration[] {
		return this.postConnectors;
	}

	registerPostConnector(connector: PostConnectorRegistration): void {
		this.postConnectors.push(connector);
	}

	async sendMessageToTarget(target: TargetInfo, content: { text: string }) {
		const connector = this.messageConnectors.find(
			(candidate) => candidate.source === target.source,
		);
		await connector?.sendHandler?.(
			this as unknown as IAgentRuntime,
			target,
			content,
		);
	}
}

function makeRuntime(): IAgentRuntime {
	return new TestRuntime() as unknown as IAgentRuntime;
}

function makeTarget(source: string): TargetInfo {
	return {
		source,
		roomId: "00000000-0000-0000-0000-00000000000c" as TargetInfo["roomId"],
	};
}

describe("ConnectorAccountManager", () => {
	it("does not duplicate an existing MessageConnector source during provider registration", async () => {
		const runtime = makeRuntime();
		const existingSendHandler = vi.fn(async () => undefined);
		const providerSendHandler = vi.fn(async () => undefined);

		runtime.registerMessageConnector({
			source: "chat",
			sendHandler: existingSendHandler,
			fetchMessages: async () => [],
		});

		const manager = getConnectorAccountManager(runtime);
		const result = manager.registerProvider({
			provider: "chat",
			messageConnector: {
				source: "chat",
				sendHandler: providerSendHandler,
				fetchMessages: async () => [],
			},
		});

		expect(result.messageConnectorRegistered).toBe(false);
		expect(result.messageConnectorSkipped).toBe(true);
		expect(runtime.getMessageConnectors()).toHaveLength(1);

		await runtime.sendMessageToTarget(makeTarget("chat"), { text: "hello" });
		expect(existingSendHandler).toHaveBeenCalledOnce();
		expect(providerSendHandler).not.toHaveBeenCalled();
	});

	it("preserves stored account policy fields when merging provider-listed accounts", async () => {
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		await manager.upsertAccount("chat", {
			id: "acct-chat-1",
			provider: "chat",
			label: "Stored label",
			role: "AGENT",
			purpose: ["automation"],
			accessGate: "owner_binding",
			status: "disabled",
			createdAt: 10,
			updatedAt: 20,
			metadata: { stored: true },
		});
		manager.registerProvider({
			provider: "chat",
			listAccounts: () => [
				{
					id: "acct-chat-1",
					provider: "chat",
					label: "Provider label",
					role: "OWNER",
					purpose: ["messaging"],
					accessGate: "open",
					status: "connected",
					createdAt: 100,
					updatedAt: 200,
					metadata: { provider: true },
				},
			],
		});

		const accounts = await manager.listAccounts("chat");

		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({
			id: "acct-chat-1",
			role: "AGENT",
			purpose: ["automation"],
			accessGate: "owner_binding",
			status: "disabled",
			label: "Stored label",
		});
		expect(accounts[0]?.metadata).toEqual({ provider: true, stored: true });
	});

	it("resolves provider-synthesized accounts by id even before persistence", async () => {
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		manager.registerProvider({
			provider: "env-only",
			listAccounts: () => [
				{
					id: "default",
					provider: "env-only",
					label: "Imported from env",
					role: "OWNER",
					purpose: ["messaging"],
					accessGate: "open",
					status: "connected",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		});

		await expect(
			manager.getAccount("env-only", "default"),
		).resolves.toMatchObject({
			id: "default",
			role: "OWNER",
		});
	});

	it("consumes OAuth callback state only once", async () => {
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		manager.registerProvider({
			provider: "oauth-test",
			startOAuth: () => ({ authUrl: "https://auth.example/start" }),
			completeOAuth: () => ({
				account: {
					id: "oauth-account",
					provider: "oauth-test",
					label: "OAuth account",
					role: "OWNER",
					purpose: ["messaging"],
					accessGate: "open",
					status: "connected",
					createdAt: 1,
					updatedAt: 1,
				},
			}),
		});
		const flow = await manager.startOAuth("oauth-test");

		await expect(
			manager.completeOAuth("oauth-test", {
				state: flow.state,
				code: "code-1",
			}),
		).resolves.toMatchObject({
			account: { id: "oauth-account" },
		});
		await expect(
			manager.completeOAuth("oauth-test", {
				state: flow.state,
				code: "code-2",
			}),
		).rejects.toThrow(/already used|unknown|expired/i);
	});
});
