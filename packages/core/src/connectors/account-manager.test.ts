import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
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

	constructor(public readonly adapter?: InMemoryDatabaseAdapter) {}

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
		await connector?.sendHandler?.(this as IAgentRuntime, target, content);
	}
}

function makeRuntime(adapter?: InMemoryDatabaseAdapter): IAgentRuntime {
	return new TestRuntime(adapter) as IAgentRuntime;
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

	it("preserves PKCE code verifier through database-backed OAuth flow storage", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const runtime = makeRuntime(adapter);
		const manager = getConnectorAccountManager(runtime);
		manager.registerProvider({
			provider: "oauth-db",
			startOAuth: () => ({
				authUrl: "https://auth.example/start",
				codeVerifier: "pkce-verifier-1",
			}),
		});
		const flow = await manager.startOAuth("oauth-db");
		expect(flow.codeVerifier).toBe("pkce-verifier-1");
		const storedFlow = await adapter.getOAuthFlowState({
			provider: "oauth-db",
			state: flow.state,
			includeExpired: true,
			includeConsumed: true,
		});
		expect(storedFlow?.codeVerifierRef).toMatch(/^connector-oauth-pkce:/);
		expect(JSON.stringify(storedFlow?.metadata ?? {})).not.toContain(
			"pkce-verifier-1",
		);
		expect(storedFlow?.metadata).not.toHaveProperty("codeVerifier");

		const callbackRuntime = makeRuntime(adapter);
		const callbackManager = getConnectorAccountManager(callbackRuntime);
		let callbackVerifier: string | undefined;
		callbackManager.registerProvider({
			provider: "oauth-db",
			startOAuth: () => ({ authUrl: "https://auth.example/start" }),
			completeOAuth: (request) => {
				callbackVerifier = request.flow.codeVerifier;
				return {
					account: {
						id: "00000000-0000-4000-8000-000000000321",
						provider: "oauth-db",
						label: "OAuth DB account",
						role: "OWNER",
						purpose: ["messaging"],
						accessGate: "open",
						status: "connected",
						createdAt: 1,
						updatedAt: 1,
					},
				};
			},
		});

		await expect(
			callbackManager.completeOAuth("oauth-db", {
				state: flow.state,
				code: "code-1",
			}),
		).resolves.toMatchObject({
			account: { id: "00000000-0000-4000-8000-000000000321" },
		});
		expect(callbackVerifier).toBe("pkce-verifier-1");
		await expect(
			callbackManager.completeOAuth("oauth-db", {
				state: flow.state,
				code: "code-2",
			}),
		).rejects.toThrow(/already used|unknown|expired/i);
	});

	it("requires a verified owner-binding lookup for owner-bound policies", async () => {
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		await manager.upsertAccount("chat", {
			id: "acct-bound",
			provider: "chat",
			label: "Bound account",
			role: "OWNER",
			purpose: ["messaging"],
			accessGate: "owner_binding",
			status: "connected",
			externalId: "external-owner",
			ownerBindingId: "client-supplied-binding",
			ownerIdentityId: "client-supplied-identity",
			createdAt: 1,
			updatedAt: 1,
		});

		await expect(
			manager.evaluatePolicy(
				{
					provider: "chat",
					accessGates: ["owner_binding"],
				},
				{ accountId: "acct-bound" },
			),
		).resolves.toMatchObject({
			allowed: false,
			reason: "owner binding has not been verified",
		});
	});
});
