import { describe, expect, it } from "vitest";
import type { IDatabaseAdapter, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;

describe("InMemoryDatabaseAdapter connector account storage", () => {
	it("implements the connector account storage surface through IDatabaseAdapter", async () => {
		const adapter: IDatabaseAdapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();

		const account = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-user-1",
			displayName: "GitHub User",
			role: "OWNER",
			purpose: ["messaging"],
			accessGate: "open",
			scopes: ["repo"],
			metadata: { source: "oauth" },
		});

		const updated = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-user-1",
			displayName: "Updated User",
		});

		expect(updated.id).toBe(account.id);
		expect(updated.displayName).toBe("Updated User");
		expect(updated.role).toBe("OWNER");
		expect(updated.purpose).toEqual(["messaging"]);
		expect(updated.scopes).toEqual(["repo"]);
		await expect(
			adapter.listConnectorAccounts({ agentId, provider: "github" }),
		).resolves.toHaveLength(1);
		await expect(
			adapter.getConnectorAccount({
				agentId,
				provider: "github",
				accountKey: "github-user-1",
			}),
		).resolves.toMatchObject({ id: account.id });

		const credential = await adapter.setConnectorAccountCredentialRef({
			accountId: account.id,
			credentialType: "oauth.refresh_token",
			vaultRef: `connector.${agentId}.github.${account.id}.refresh`,
			metadata: { rotatedBy: "test" },
		});
		await expect(
			adapter.getConnectorAccountCredentialRef({
				accountId: account.id,
				credentialType: "oauth.refresh_token",
			}),
		).resolves.toMatchObject({ vaultRef: credential.vaultRef });
		await expect(
			adapter.listConnectorAccountCredentialRefs({ accountId: account.id }),
		).resolves.toHaveLength(1);

		const audit = await adapter.appendConnectorAccountAuditEvent({
			accountId: account.id,
			action: "credential.set",
			metadata: {
				accessToken: "secret",
				nested: { refresh_token: "secret", safe: "visible" },
			},
		});
		expect(audit.metadata.accessToken).toBe("[REDACTED]");
		expect((audit.metadata.nested as Record<string, unknown>).safe).toBe(
			"visible",
		);
		expect(
			(audit.metadata.nested as Record<string, unknown>).refresh_token,
		).toBe("[REDACTED]");

		const flow = await adapter.createOAuthFlowState({
			agentId,
			provider: "github",
			state: "opaque-state",
			ttlMs: 60_000,
			metadata: { flowId: "oauth_test" },
		});
		expect(flow.stateHash).not.toBe("opaque-state");
		expect(flow.stateHash).toHaveLength(64);
		await expect(
			adapter.getOAuthFlowState({
				agentId,
				provider: "github",
				flowId: "oauth_test",
				includeExpired: true,
			}),
		).resolves.toMatchObject({ stateHash: flow.stateHash });
		await expect(
			adapter.updateOAuthFlowState({
				agentId,
				provider: "github",
				flowId: "oauth_test",
				metadata: { status: "completed" },
			}),
		).resolves.toMatchObject({
			metadata: { flowId: "oauth_test", status: "completed" },
		});

		await expect(
			adapter.consumeOAuthFlowState({
				agentId,
				provider: "github",
				state: "opaque-state",
				consumedBy: "callback",
			}),
		).resolves.toMatchObject({ consumedBy: "callback" });
		await expect(
			adapter.consumeOAuthFlowState({
				agentId,
				provider: "github",
				state: "opaque-state",
			}),
		).resolves.toBeNull();
		await expect(
			adapter.deleteOAuthFlowState({
				agentId,
				provider: "github",
				flowId: "oauth_test",
			}),
		).resolves.toBe(true);

		await expect(
			adapter.deleteConnectorAccount({
				agentId,
				provider: "github",
				accountKey: "github-user-1",
			}),
		).resolves.toBe(true);
		await expect(
			adapter.getConnectorAccountCredentialRef({
				accountId: account.id,
				credentialType: "oauth.refresh_token",
			}),
		).resolves.toBeNull();
	});
});
