/**
 * Behavioral tests for `ConnectorAccountManager` — provider registration and
 * connector dedup, stored/provider account merge, single-use OAuth consumption,
 * PKCE-secret handling, and owner-binding policy — driven against a stub runtime
 * and the real `InMemoryDatabaseAdapter` (no live connector, no network).
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { ElizaError } from "../errors";
import type { TargetInfo } from "../types";
import type {
	IAgentRuntime,
	MessageConnectorRegistration,
	PostConnectorRegistration,
} from "../types/runtime";
import {
	type ConnectorAccountStorage,
	type ConnectorOAuthFlow,
	getConnectorAccountManager,
	InMemoryConnectorAccountStorage,
} from "./account-manager";

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

	it("rejects an ambiguous external alias while resolving an exact account key", async () => {
		const manager = getConnectorAccountManager(makeRuntime());
		const shared = {
			provider: "google",
			purpose: ["automation" as const],
			accessGate: "open" as const,
			status: "connected" as const,
			externalId: "shared-google-subject",
			createdAt: 1,
			updatedAt: 1,
		};
		manager.registerProvider({
			provider: "google",
			listAccounts: () => [
				{
					...shared,
					id: "owner-account",
					accountKey: "owner-key",
					role: "OWNER",
				},
				{
					...shared,
					id: "agent-account",
					accountKey: "agent-key",
					role: "AGENT",
				},
			],
		});

		await expect(
			manager.getAccount("google", "agent-key"),
		).resolves.toMatchObject({
			id: "agent-account",
			role: "AGENT",
		});
		await expect(
			manager.getAccount("google", "shared-google-subject"),
		).resolves.toBeNull();
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

	it("serializes concurrent OAuth callbacks through final account persistence", async () => {
		const storage = new InMemoryConnectorAccountStorage();
		const persistAccount = storage.upsertAccount.bind(storage);
		let signalFirstWrite!: () => void;
		let releaseFirstWrite!: () => void;
		const firstWriteEntered = new Promise<void>((resolve) => {
			signalFirstWrite = resolve;
		});
		const firstWriteRelease = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		let writeCount = 0;
		storage.upsertAccount = async (account) => {
			writeCount += 1;
			if (writeCount === 1) {
				signalFirstWrite();
				await firstWriteRelease;
			}
			return persistAccount(account);
		};

		const firstRuntime = makeRuntime();
		const secondRuntime = makeRuntime();
		(firstRuntime as unknown as { agentId: string }).agentId = "shared-agent";
		(secondRuntime as unknown as { agentId: string }).agentId = "shared-agent";
		const firstManager = getConnectorAccountManager(firstRuntime);
		const secondManager = getConnectorAccountManager(secondRuntime);
		firstManager.setStorage(storage);
		secondManager.setStorage(storage);
		const callbackCodes: string[] = [];
		const provider = {
			provider: "oauth-serialized-success",
			startOAuth: () => ({ authUrl: "https://auth.example/start" }),
			completeOAuth: (request) => {
				callbackCodes.push(request.code ?? "");
				return {
					account: {
						id: "shared-oauth-account",
						provider: "oauth-serialized-success",
						role: "OWNER",
						purpose: ["messaging"],
						accessGate: "open",
						status: "connected",
						createdAt: 1,
						updatedAt: 1,
					},
				};
			},
		};
		firstManager.registerProvider(provider);
		secondManager.registerProvider(provider);
		const firstFlow = await firstManager.startOAuth("oauth-serialized-success");
		const secondFlow = await secondManager.startOAuth(
			"oauth-serialized-success",
		);

		const first = firstManager.completeOAuth("oauth-serialized-success", {
			state: firstFlow.state,
			code: "code-1",
		});
		await firstWriteEntered;
		const second = secondManager.completeOAuth("oauth-serialized-success", {
			state: secondFlow.state,
			code: "code-2",
		});
		await Promise.resolve();

		expect(callbackCodes).toEqual(["code-1"]);
		releaseFirstWrite();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(callbackCodes).toEqual(["code-1", "code-2"]);
		await expect(
			firstManager.listAccounts("oauth-serialized-success"),
		).resolves.toHaveLength(1);
	});

	it("keeps a committed OAuth account when the queued callback fails", async () => {
		const storage = new InMemoryConnectorAccountStorage();
		const persistAccount = storage.upsertAccount.bind(storage);
		let signalFirstWrite!: () => void;
		let releaseFirstWrite!: () => void;
		const firstWriteEntered = new Promise<void>((resolve) => {
			signalFirstWrite = resolve;
		});
		const firstWriteRelease = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		storage.upsertAccount = async (account) => {
			signalFirstWrite();
			await firstWriteRelease;
			storage.upsertAccount = persistAccount;
			return persistAccount(account);
		};

		const manager = getConnectorAccountManager(makeRuntime());
		manager.setStorage(storage);
		const callbackCodes: string[] = [];
		manager.registerProvider({
			provider: "oauth-serialized-failure",
			startOAuth: () => ({ authUrl: "https://auth.example/start" }),
			completeOAuth: (request) => {
				callbackCodes.push(request.code ?? "");
				if (request.code === "code-2")
					throw new Error("second callback rejected");
				return {
					account: {
						id: "committed-oauth-account",
						provider: "oauth-serialized-failure",
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
		const firstFlow = await manager.startOAuth("oauth-serialized-failure");
		const secondFlow = await manager.startOAuth("oauth-serialized-failure");

		const first = manager.completeOAuth("oauth-serialized-failure", {
			state: firstFlow.state,
			code: "code-1",
		});
		await firstWriteEntered;
		const second = manager.completeOAuth("oauth-serialized-failure", {
			state: secondFlow.state,
			code: "code-2",
		});
		const secondRejection =
			expect(second).rejects.toThrow(/completion failed/i);
		await Promise.resolve();

		expect(callbackCodes).toEqual(["code-1"]);
		releaseFirstWrite();
		await expect(first).resolves.toMatchObject({
			account: { id: "committed-oauth-account" },
		});
		await secondRejection;
		expect(callbackCodes).toEqual(["code-1", "code-2"]);
		await expect(
			manager.getAccount("oauth-serialized-failure", "committed-oauth-account"),
		).resolves.toMatchObject({ status: "connected" });
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

	it("persists the canonical redirect URI selected by an OAuth provider", async () => {
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		manager.registerProvider({
			provider: "oauth-canonical",
			startOAuth: () => ({
				authUrl: "https://auth.example/start",
				redirectUri:
					"http://127.0.0.1:31437/api/connectors/example/oauth/callback",
			}),
		});

		const flow = await manager.startOAuth("oauth-canonical");

		expect(flow.redirectUri).toBe(
			"http://127.0.0.1:31437/api/connectors/example/oauth/callback",
		);
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

	it("round-trips a provider-owned account key separately from the external identity", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const manager = getConnectorAccountManager(makeRuntime(adapter));
		const stableKey = "acct_google_role_bound_key";

		const account = await manager.upsertAccount("google", {
			...GOOGLE_ACCOUNT,
			id: stableKey,
			accountKey: stableKey,
			externalId: "shared-google-subject",
		});

		expect(account.accountKey).toBe(stableKey);
		await expect(
			adapter.getConnectorAccount({
				provider: "google",
				accountKey: stableKey,
			}),
		).resolves.toMatchObject({
			accountKey: stableKey,
			externalId: "shared-google-subject",
		});
	});

	it("preserves stored identity fields when a provider returns a partial patch", async () => {
		const manager = getConnectorAccountManager(makeRuntime());
		await manager.upsertAccount("google", {
			...GOOGLE_ACCOUNT,
			accountKey: "acct_google_owner_key",
			externalId: "google-owner-subject",
		});
		manager.registerProvider({
			provider: "google",
			patchAccount: async () => ({ status: "disabled" }),
		});

		await expect(
			manager.patchAccount("google", GOOGLE_ACCOUNT.id, { status: "disabled" }),
		).resolves.toMatchObject({
			accountKey: "acct_google_owner_key",
			externalId: "google-owner-subject",
			role: "OWNER",
			status: "disabled",
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

	it("lands an in-flight upsert on the durable backend when the adapter attaches mid-call", async () => {
		// The #18110 interleaving: a facade write starts while only the fallback
		// exists, and the adapter attaches in the same synchronous frame. The
		// serialized facade must resolve the backend at execution time — not at
		// call time — so the write lands durably instead of stranding in the
		// boot-time fallback.
		const runtime = makeRuntime();
		const manager = getConnectorAccountManager(runtime);
		const storage = manager.getStorage();

		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();

		const pendingUpsert = storage.upsertAccount(BOOT_ACCOUNT);
		(runtime as unknown as { adapter?: InMemoryDatabaseAdapter }).adapter =
			adapter;
		await pendingUpsert;

		// The account must be visible on the durable backend itself...
		const record = await adapter.getConnectorAccount({
			provider: "google",
			accountKey: "user@example.com",
		});
		expect(record).not.toBeNull();
		expect(record?.status).toBe("connected");
		// ...and through the manager, without a stranded fallback copy.
		await expect(manager.listAccounts("google")).resolves.toHaveLength(1);
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

describe("failure-state persistence after consumed OAuth state (#19225)", () => {
	const PROVIDER_ERROR = "token endpoint returned 500";

	/**
	 * Real manager + real in-memory storage; only the terminal failed-state
	 * write is intercepted (`patch.status === "failed"`), so the flow create /
	 * consume path under test stays the production one.
	 */
	function makeManagerWithFailedWrite(
		providerId: string,
		failedWrite: () => Promise<ConnectorOAuthFlow | null>,
	) {
		const real = new InMemoryConnectorAccountStorage();
		const storage: ConnectorAccountStorage = {
			listAccounts: (provider) => real.listAccounts(provider),
			getAccount: (provider, accountId) => real.getAccount(provider, accountId),
			upsertAccount: (account) => real.upsertAccount(account),
			deleteAccount: (provider, accountId) =>
				real.deleteAccount(provider, accountId),
			createOAuthFlow: (flow) => real.createOAuthFlow(flow),
			getOAuthFlow: (provider, flowIdOrState) =>
				real.getOAuthFlow(provider, flowIdOrState),
			consumeOAuthFlow: (provider, state, consumedBy) =>
				real.consumeOAuthFlow(provider, state, consumedBy),
			updateOAuthFlow: (provider, flowIdOrState, patch) =>
				patch.status === "failed"
					? failedWrite()
					: real.updateOAuthFlow(provider, flowIdOrState, patch),
			deleteOAuthFlow: (provider, flowIdOrState) =>
				real.deleteOAuthFlow(provider, flowIdOrState),
		};
		const manager = getConnectorAccountManager(makeRuntime());
		manager.setStorage(storage);
		manager.registerProvider({
			provider: providerId,
			startOAuth: () => ({ authUrl: "https://auth.example/start" }),
			completeOAuth: () => {
				throw new Error(PROVIDER_ERROR);
			},
		});
		return manager;
	}

	async function completeAndCatch(
		manager: ReturnType<typeof getConnectorAccountManager>,
		providerId: string,
		state: string,
	): Promise<unknown> {
		try {
			await manager.completeOAuth(providerId, { state, code: "code-1" });
			return undefined;
		} catch (err) {
			return err;
		}
	}

	function expectPersistenceFailureContract(
		thrown: unknown,
		providerId: string,
	): asserts thrown is ElizaError {
		// The thrown type is ElizaError with a stable code — a bare
		// AggregateError may only appear as its cause.
		expect(thrown).toBeInstanceOf(ElizaError);
		const typed = thrown as ElizaError;
		expect(typed.code).toBe("CONNECTOR_OAUTH_FAILURE_STATE_PERSISTENCE_FAILED");
		expect(typed.context).toMatchObject({ provider: providerId });
		expect(typed.cause).toBeInstanceOf(AggregateError);
		const aggregated = (typed.cause as AggregateError).errors;
		expect(aggregated).toHaveLength(2);
		expect(aggregated[0]).toBeInstanceOf(ElizaError);
		expect((aggregated[0] as ElizaError).code).toBe(
			"CONNECTOR_OAUTH_COMPLETION_FAILED",
		);
		expect(((aggregated[0] as ElizaError).cause as Error).message).toContain(
			PROVIDER_ERROR,
		);
		// The public messages stay generic; the raw provider text rides the cause.
		expect(typed.message).not.toContain(PROVIDER_ERROR);
		expect((aggregated[0] as ElizaError).message).not.toContain(PROVIDER_ERROR);
	}

	it("wraps a throwing failed-state write in a typed persistence-failure error", async () => {
		const providerId = "oauth-failstate-throw";
		const manager = makeManagerWithFailedWrite(providerId, async () => {
			throw new Error("failure-state write rejected: disk full");
		});
		const flow = await manager.startOAuth(providerId);

		const thrown = await completeAndCatch(manager, providerId, flow.state);
		expectPersistenceFailureContract(thrown, providerId);
		expect(
			((thrown.cause as AggregateError).errors[1] as Error).message,
		).toContain("disk full");

		// The one-time state stays consumed even though persistence failed.
		await expect(
			manager.completeOAuth(providerId, { state: flow.state, code: "code-2" }),
		).rejects.toThrow(/already used|unknown|expired/i);
	});

	it("treats a null failed-state write as a persistence failure, not success", async () => {
		const providerId = "oauth-failstate-null";
		const manager = makeManagerWithFailedWrite(providerId, async () => null);
		const flow = await manager.startOAuth(providerId);

		const thrown = await completeAndCatch(manager, providerId, flow.state);
		expectPersistenceFailureContract(thrown, providerId);
		expect(
			((thrown.cause as AggregateError).errors[1] as Error).message,
		).toMatch(/returned null/i);

		await expect(
			manager.completeOAuth(providerId, { state: flow.state, code: "code-2" }),
		).rejects.toThrow(/already used|unknown|expired/i);
	});
});
