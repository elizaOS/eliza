/**
 * Behavioral tests for `ConnectorAccountManager` — provider registration and
 * connector dedup, stored/provider account merge, single-use OAuth consumption,
 * PKCE-secret handling, and owner-binding policy — driven against a stub runtime
 * and the real `InMemoryDatabaseAdapter` (no live connector, no network).
 */
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

	it("fails a flow whose PKCE verifier died with a restart instead of forwarding a doomed exchange", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const runtime = makeRuntime(adapter);
		const manager = getConnectorAccountManager(runtime);
		const exchange = vi.fn();
		manager.registerProvider({
			provider: "oauth-restart",
			startOAuth: () => ({ authUrl: "https://auth.example/start" }),
			completeOAuth: exchange,
		});

		// Exactly what a restart leaves behind: a durable flow row whose
		// codeVerifierRef points at a process-local PKCE secret that no longer
		// exists in this process.
		await adapter.createOAuthFlowState?.({
			state: "state-restart-1",
			provider: "oauth-restart",
			codeVerifierRef: "connector-oauth-pkce:gone-after-restart",
			metadata: { status: "pending", flowId: "oauth_restart_1" },
		});

		const result = await manager.completeOAuth("oauth-restart", {
			state: "state-restart-1",
			code: "auth-code-1",
		});
		expect(result.flow.status).toBe("failed");
		expect(result.flow.error).toMatch(/before the agent restarted/i);
		expect(result.flow.error).toMatch(/start the oauth flow again/i);
		expect(exchange).not.toHaveBeenCalled();
	});
});

describe("durable storage binding", () => {
	const GOOGLE_ACCOUNT = {
		id: "3a899cd0-170f-4b3e-932e-46ec68119b35",
		provider: "google",
		label: "user@example.com",
		externalId: "user@example.com",
		role: "OWNER" as const,
		purpose: ["automation" as const],
		accessGate: "open" as const,
		status: "connected" as const,
		createdAt: 10,
		updatedAt: 20,
		metadata: {},
	};

	it("writes through the database adapter even when the manager was constructed before the adapter registered", async () => {
		// Connector plugins construct the manager during concurrent plugin
		// registration, before plugin-sql attaches the adapter to the runtime.
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);

		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		(runtime as unknown as { adapter?: InMemoryDatabaseAdapter }).adapter =
			adapter;

		await manager.upsertAccount("google", GOOGLE_ACCOUNT);

		// The row must land in the durable adapter, not a boot-time fallback Map.
		const record = await adapter.getConnectorAccount({
			provider: "google",
			accountKey: "user@example.com",
		});
		expect(record).not.toBeNull();
		expect(record?.status).toBe("connected");

		// Simulated restart: a fresh runtime + manager over the same durable
		// backing must still see the account.
		const restartedManager = getConnectorAccountManager(makeRuntime(adapter));
		const accounts = await restartedManager.listAccounts("google");
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({
			provider: "google",
			externalId: "user@example.com",
			status: "connected",
		});
	});

	it("keeps one consistent in-memory fallback while no adapter exists", async () => {
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		await manager.upsertAccount("google", GOOGLE_ACCOUNT);
		const accounts = await manager.listAccounts("google");
		expect(accounts).toHaveLength(1);
		expect(manager.getStorage()).toBe(manager.getStorage());
	});

	it("prefers an explicitly injected storage over the runtime adapter", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const runtime = makeRuntime(adapter);
		const manager = getConnectorAccountManager(runtime);
		const injected = {
			listAccounts: vi.fn(async () => []),
			getAccount: vi.fn(async () => null),
			upsertAccount: vi.fn(async (account: unknown) => account),
			deleteAccount: vi.fn(async () => true),
			createOAuthFlow: vi.fn(),
			getOAuthFlow: vi.fn(),
			updateOAuthFlow: vi.fn(),
			consumeOAuthFlow: vi.fn(),
			deleteOAuthFlow: vi.fn(),
		};
		manager.setStorage(injected as never);
		await manager.listAccounts("google");
		expect(injected.listAccounts).toHaveBeenCalled();
	});
});

describe("fallback-to-durable state handoff", () => {
	const BOOT_ACCOUNT = {
		id: "3a899cd0-170f-4b3e-932e-46ec68119b35",
		provider: "google",
		label: "user@example.com",
		externalId: "user@example.com",
		role: "OWNER" as const,
		purpose: ["automation" as const],
		accessGate: "open" as const,
		status: "connected" as const,
		createdAt: 10,
		updatedAt: 20,
		metadata: {},
	};

	it("migrates an account written before adapter attachment into the adapter instead of masking it", async () => {
		// The exact review repro: the write lands in the fallback, THEN the
		// adapter attaches. The next read must hand the state off, not hide it.
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		await manager.upsertAccount("google", BOOT_ACCOUNT);

		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		(runtime as unknown as { adapter?: InMemoryDatabaseAdapter }).adapter =
			adapter;

		// Post-attachment read sees the boot-window account...
		const accounts = await manager.listAccounts("google");
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({
			provider: "google",
			externalId: "user@example.com",
		});
		// ...because it now lives in the durable adapter, not the fallback.
		const record = await adapter.getConnectorAccount({
			provider: "google",
			accountKey: "user@example.com",
		});
		expect(record).not.toBeNull();
		// A restart (fresh runtime + manager over the same adapter) keeps it.
		const restarted = getConnectorAccountManager(makeRuntime(adapter));
		await expect(restarted.listAccounts("google")).resolves.toHaveLength(1);
	});

	it("completes an OAuth flow whose provider attaches the adapter mid-startOAuth", async () => {
		// createOAuthFlow lands in the fallback; the adapter attaches while
		// startOAuth is awaited; updateOAuthFlow/completeOAuth then resolve the
		// database wrapper and must find the migrated flow.
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		manager.registerProvider({
			provider: "oauth-split",
			startOAuth: async () => {
				const adapter = new InMemoryDatabaseAdapter();
				await adapter.initialize();
				(runtime as unknown as { adapter?: InMemoryDatabaseAdapter }).adapter =
					adapter;
				return { authUrl: "https://auth.example/start" };
			},
			completeOAuth: () => ({
				account: {
					id: "oauth-split-account",
					provider: "oauth-split",
					label: "Split account",
					role: "OWNER",
					purpose: ["messaging"],
					accessGate: "open",
					status: "connected",
					createdAt: 1,
					updatedAt: 1,
				},
			}),
		});

		const flow = await manager.startOAuth("oauth-split");
		expect(flow.authUrl).toBe("https://auth.example/start");

		await expect(
			manager.completeOAuth("oauth-split", {
				state: flow.state,
				code: "code-1",
			}),
			// The database path mints a UUID for a non-UUID provider account id;
			// identity is carried by provider/label/status.
		).resolves.toMatchObject({
			account: {
				provider: "oauth-split",
				label: "Split account",
				status: "connected",
			},
		});
	});

	it("completes an OAuth flow whose provider attaches the adapter mid-completeOAuth", async () => {
		// The consumed-but-in-flight case: completeOAuth consumes the flow in the
		// fallback, the adapter attaches while the provider callback is awaited,
		// and the terminal updateOAuthFlow must still find the flow (migrated as
		// consumed) instead of returning the original pending flow.
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		manager.registerProvider({
			provider: "oauth-complete-split",
			startOAuth: async () => ({ authUrl: "https://auth.example/start" }),
			completeOAuth: async () => {
				const adapter = new InMemoryDatabaseAdapter();
				await adapter.initialize();
				(runtime as unknown as { adapter?: InMemoryDatabaseAdapter }).adapter =
					adapter;
				return {
					account: {
						id: "oauth-complete-split-account",
						provider: "oauth-complete-split",
						label: "Complete-split account",
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

		const flow = await manager.startOAuth("oauth-complete-split");
		const result = await manager.completeOAuth("oauth-complete-split", {
			state: flow.state,
			code: "code-1",
		});
		expect(result.account).toMatchObject({
			provider: "oauth-complete-split",
			label: "Complete-split account",
			status: "connected",
		});
		expect(result.flow.status).toBe("completed");
		// The completed flow is queryable afterward from the durable backend.
		const stored = await manager.getOAuthFlow("oauth-complete-split", flow.id);
		expect(stored?.status).toBe("completed");
	});
});
