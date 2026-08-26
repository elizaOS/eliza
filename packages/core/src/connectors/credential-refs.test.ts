/**
 * Exercises the canonical connector credential persistence boundary with
 * deterministic durable-store doubles, including writer fallback, partial
 * failure, restart-visible artifacts, expiry metadata, and concurrent writes.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../types/runtime.js";
import type { ConnectorAccountManager } from "./account-manager.js";
import {
	buildConnectorCredentialVaultRef,
	persistConnectorCredentialRefs,
} from "./credential-refs.js";

type RefRow = {
	accountId: string;
	credentialType: string;
	vaultRef: string;
	expiresAt?: number;
};

function runtimeWithServices(services: Record<string, unknown>): IAgentRuntime {
	return {
		agentId: "agent/reuse",
		getService: (type: string) => services[type] ?? null,
	} as unknown as IAgentRuntime;
}

describe("connector credential persistence", () => {
	it("normalizes the canonical vault reference without provider-specific naming", () => {
		expect(
			buildConnectorCredentialVaultRef({
				agentId: " agent/reuse ",
				provider: "Google Workspace",
				accountId: "owner@example.com",
				credentialType: "oauth.tokens",
			}),
		).toBe(
			"connector.agent_reuse.Google_Workspace.owner_example_com.oauth_tokens",
		);
	});

	it("falls back from an unavailable credential store and persists restart-visible refs", async () => {
		const secrets = new Map<string, string>();
		const refs = new Map<string, RefRow>();
		const runtime = runtimeWithServices({
			connector_credential_store: {
				putSecret: vi.fn(async () => {
					throw new Error("primary unavailable");
				}),
			},
			vault: {
				set: vi.fn(async (key: string, value: string) => {
					secrets.set(key, value);
				}),
				remove: vi.fn(async (key: string) => {
					secrets.delete(key);
				}),
			},
			connector_account_storage: {
				setConnectorAccountCredentialRef: vi.fn(async (row: RefRow) => {
					refs.set(`${row.accountId}:${row.credentialType}`, row);
				}),
			},
		});

		const result = await persistConnectorCredentialRefs({
			runtime,
			provider: "google",
			accountIdForRef: "owner",
			storageAccountId: "account-1",
			caller: "oauth.callback",
			credentials: [
				{
					credentialType: "oauth.tokens",
					value: "token-json",
					expiresAt: 1_800_000_000,
				},
			],
		});

		const restartedRef = refs.get("account-1:oauth.tokens");
		expect(restartedRef?.expiresAt).toBe(1_800_000_000);
		expect(secrets.get(restartedRef?.vaultRef ?? "missing")).toBe("token-json");
		expect(result.refs).toEqual([
			expect.objectContaining({
				credentialType: "oauth.tokens",
				expiresAt: 1_800_000_000,
			}),
		]);
	});

	it("replays the complete ref set through a fallback writer after partial failure", async () => {
		const fallbackRows: RefRow[] = [];
		let primaryWrites = 0;
		const manager = {
			getStorage: () => ({
				setConnectorAccountCredentialRef: vi.fn(async () => {
					primaryWrites += 1;
					if (primaryWrites === 2) throw new Error("transaction lost");
				}),
			}),
		} as unknown as ConnectorAccountManager;
		const runtime = runtimeWithServices({
			vault: {
				set: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			connector_account_storage: {
				setConnectorAccountCredentialRef: vi.fn(async (row: RefRow) => {
					fallbackRows.push(row);
				}),
			},
		});

		await persistConnectorCredentialRefs({
			runtime,
			manager,
			provider: "slack",
			accountIdForRef: "workspace",
			storageAccountId: "account-2",
			caller: "oauth.callback",
			credentials: [
				{ credentialType: "oauth.access", value: "access" },
				{ credentialType: "oauth.refresh", value: "refresh" },
			],
		});

		expect(fallbackRows.map((row) => row.credentialType)).toEqual([
			"oauth.access",
			"oauth.refresh",
		]);
	});

	it("fails closed when either durable boundary is unavailable", async () => {
		const noVault = runtimeWithServices({
			connector_account_storage: {
				setConnectorAccountCredentialRef: vi.fn(),
			},
		});
		await expect(
			persistConnectorCredentialRefs({
				runtime: noVault,
				provider: "github",
				accountIdForRef: "owner",
				storageAccountId: "account-3",
				caller: "oauth.callback",
				credentials: [{ credentialType: "oauth.tokens", value: "secret" }],
			}),
		).rejects.toThrow(/No durable connector credential store or vault writer/);

		const noRefs = runtimeWithServices({
			vault: {
				set: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
		});
		await expect(
			persistConnectorCredentialRefs({
				runtime: noRefs,
				provider: "github",
				accountIdForRef: "owner",
				storageAccountId: "account-3",
				caller: "oauth.callback",
				credentials: [{ credentialType: "oauth.tokens", value: "secret" }],
			}),
		).rejects.toThrow(/No durable connector credential ref writer/);
	});

	it("rolls back vaulted secrets when the ref write fails", async () => {
		const secrets = new Map<string, string>();
		const runtime = runtimeWithServices({
			vault: {
				set: vi.fn(async (key: string, value: string) => {
					secrets.set(key, value);
				}),
				remove: vi.fn(async (key: string) => {
					secrets.delete(key);
				}),
			},
			connector_account_storage: {
				setConnectorAccountCredentialRef: vi.fn(async () => {
					throw new Error("ref storage down");
				}),
			},
		});

		await expect(
			persistConnectorCredentialRefs({
				runtime,
				provider: "github",
				accountIdForRef: "owner",
				storageAccountId: "account-rollback",
				caller: "oauth.callback",
				credentials: [{ credentialType: "oauth.tokens", value: "secret" }],
			}),
		).rejects.toThrow(/Failed to persist connector credential refs/);
		expect(secrets.size).toBe(0);
	});

	it("keeps concurrent provider writes isolated", async () => {
		const secrets = new Map<string, string>();
		const rows: RefRow[] = [];
		const runtime = runtimeWithServices({
			vault: {
				set: vi.fn(async (key: string, value: string) => {
					secrets.set(key, value);
				}),
				remove: vi.fn(async (key: string) => {
					secrets.delete(key);
				}),
			},
			connector_account_storage: {
				setConnectorAccountCredentialRef: vi.fn(async (row: RefRow) => {
					rows.push(row);
				}),
			},
		});

		await Promise.all(
			["github", "spotify"].map((provider) =>
				persistConnectorCredentialRefs({
					runtime,
					provider,
					accountIdForRef: "owner",
					storageAccountId: `account-${provider}`,
					caller: "oauth.callback",
					credentials: [
						{ credentialType: "oauth.tokens", value: `${provider}-secret` },
					],
				}),
			),
		);

		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.vaultRef)).size).toBe(2);
		expect([...secrets.values()].sort()).toEqual([
			"github-secret",
			"spotify-secret",
		]);
	});
});
