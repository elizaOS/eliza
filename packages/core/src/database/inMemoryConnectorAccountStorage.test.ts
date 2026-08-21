/**
 * Exercises the connector-account storage surface of `IDatabaseAdapter` against
 * the real `InMemoryDatabaseAdapter`: account upsert/get/list, credential refs,
 * audit-event secret redaction, and OAuth flow-state create/consume/update/delete.
 */
import { describe, expect, it } from "vitest";
import type { IDatabaseAdapter, UUID } from "../types";
import {
	CONNECTOR_JSON_UNBOUNDED,
	MAX_CONNECTOR_JSON_NODES,
} from "./connector-json";
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

function nest(depth: number): Record<string, unknown> {
	let value: Record<string, unknown> = { leaf: true };
	for (let i = 0; i < depth; i += 1) {
		value = { n: value };
	}
	return value;
}

function expectUnbounded(error: unknown): void {
	expect(error).toBeInstanceOf(Error);
	expect(error).not.toBeInstanceOf(TypeError);
	expect((error as { code?: string }).code).toBe(CONNECTOR_JSON_UNBOUNDED);
}

async function expectUpsertRejects(
	adapter: InMemoryDatabaseAdapter,
	params: Parameters<InMemoryDatabaseAdapter["upsertConnectorAccount"]>[0],
): Promise<void> {
	try {
		await adapter.upsertConnectorAccount(params);
	} catch (error) {
		expectUnbounded(error);
		return;
	}
	throw new Error("expected the connector account upsert to reject");
}

/**
 * The bounded JSON projection itself is unit-tested in `connector-json.test.ts`.
 * These cases pin the contract at the adapter boundary: that every connector
 * write and read actually routes through it, that a typed rejection leaves no
 * ghost record or bricked lookup key, and that the projection's reflection
 * bound still holds when a hostile value arrives through the public
 * `IDatabaseAdapter` surface rather than through a direct helper call.
 */
describe("InMemoryDatabaseAdapter connector JSON bounds", () => {
	it("origin JSON.stringify of a 40000-deep profile RangeErrors", () => {
		// bun stringify is iterative until ~40k; node already RangeErrors at 8k.
		expect(() => JSON.parse(JSON.stringify(nest(40_000)))).toThrow(RangeError);
	});

	it("upserts an honest profile and metadata clone", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const nested = { plan: "free" };
		const account = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-honest",
			profile: { login: "octo", extra: nested },
			metadata: { source: "oauth" },
		});
		expect(account.profile).toEqual({ login: "octo", extra: { plan: "free" } });
		expect(account.metadata).toEqual({ source: "oauth" });
		// The stored record must not alias caller-owned subtrees.
		nested.plan = "mutated";
		const read = await adapter.getConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-honest",
		});
		expect(read?.profile).toEqual({ login: "octo", extra: { plan: "free" } });
	});

	it("fail-closes upsert on a cyclic profile instead of TypeError", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const cyclic: Record<string, unknown> = { login: "octo" };
		cyclic.self = cyclic;
		expect(() => JSON.parse(JSON.stringify(cyclic))).toThrow(TypeError);
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-cycle",
			profile: cyclic,
		});
	});

	it("fail-closes upsert on a 40000-deep profile instead of RangeError", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-deep",
			profile: nest(40_000),
		});
	});

	it("leaves no ghost account behind a rejected write", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const cyclic: Record<string, unknown> = { login: "octo" };
		cyclic.self = cyclic;
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-ghost",
			profile: cyclic,
		});
		await expect(
			adapter.getConnectorAccount({
				agentId,
				provider: "github",
				accountKey: "github-ghost",
			}),
		).resolves.toBeNull();
		await expect(
			adapter.listConnectorAccounts({ agentId, provider: "github" }),
		).resolves.toHaveLength(0);
	});

	it("keeps the existing record and lookup key when a re-upsert is rejected", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const account = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-reupsert",
			profile: { login: "octo" },
		});
		const cyclic: Record<string, unknown> = { login: "octo" };
		cyclic.self = cyclic;
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-reupsert",
			profile: cyclic,
		});
		// Key lookup must still resolve the live account, and the next honest
		// upsert must reuse its id instead of minting a duplicate.
		await expect(
			adapter.getConnectorAccount({
				agentId,
				provider: "github",
				accountKey: "github-reupsert",
			}),
		).resolves.toMatchObject({ id: account.id, profile: { login: "octo" } });
		await expect(
			adapter.upsertConnectorAccount({
				agentId,
				provider: "github",
				accountKey: "github-reupsert",
				profile: { login: "octo-2" },
			}),
		).resolves.toMatchObject({ id: account.id });
		await expect(
			adapter.listConnectorAccounts({ agentId, provider: "github" }),
		).resolves.toHaveLength(1);
	});

	it("never invokes an own enumerable accessor on the upsert path", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		let calls = 0;
		const profile: Record<string, unknown> = {};
		Object.defineProperty(profile, "login", {
			configurable: true,
			enumerable: true,
			get() {
				calls += 1;
				return "octo";
			},
		});
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-own-accessor",
			profile,
		});
		expect(calls).toBe(0);
	});

	it("fail-closes a revoked proxy profile without leaking a raw TypeError", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const revoked = Proxy.revocable({ login: "octo" }, {});
		revoked.revoke();
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-revoked-proxy",
			profile: { nested: revoked.proxy } as never,
		});
	});

	it("stops requesting array index descriptors at the node cap on upsert", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		let indexDescriptorCalls = 0;
		const dense = new Proxy(
			Array.from({ length: 100_000 }, () => 1),
			{
				getOwnPropertyDescriptor(target, key) {
					if (key !== "length") indexDescriptorCalls += 1;
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			},
		);
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-dense-array",
			profile: { arr: dense } as never,
		});
		// The length cap must short-circuit before any index descriptor is
		// materialised, so the walk never pays O(elements) to fail closed.
		expect(indexDescriptorCalls).toBe(0);
	});

	it("rejects a wide object profile before allocating per-property descriptors", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const keys = Array.from(
			{ length: MAX_CONNECTOR_JSON_NODES * 4 },
			(_, index) => `k${index}`,
		);
		const target = Object.fromEntries(keys.map((key) => [key, 1]));
		let descriptorCalls = 0;
		const wide = new Proxy(target, {
			getOwnPropertyDescriptor(currentTarget, key) {
				descriptorCalls += 1;
				return Reflect.getOwnPropertyDescriptor(currentTarget, key);
			},
		});
		await expectUpsertRejects(adapter, {
			agentId,
			provider: "github",
			accountKey: "github-wide-object",
			profile: { wide } as never,
		});
		expect(descriptorCalls).toBe(0);
	});

	it("records a bounded audit event for hostile metadata instead of throwing", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const account = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-audit-cycle",
		});
		const cyclic: Record<string, unknown> = {
			safe: "visible",
			accessToken: "secret",
		};
		cyclic.self = cyclic;
		const audit = await adapter.appendConnectorAccountAuditEvent({
			accountId: account.id,
			action: "credential.set",
			metadata: cyclic,
		});
		expect(audit.metadata.safe).toBe("visible");
		expect(audit.metadata.accessToken).toBe("[REDACTED]");
		expect(audit.metadata.self).toBe("[BOUNDED]");
	});

	it("bounds deep non-cyclic audit metadata without dropping the event", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const account = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-audit-deep",
		});
		const audit = await adapter.appendConnectorAccountAuditEvent({
			accountId: account.id,
			action: "credential.set",
			metadata: { safe: "visible", deep: nest(40) },
		});
		expect(audit.metadata.safe).toBe("visible");
		expect(JSON.stringify(audit.metadata)).toContain("[BOUNDED]");
	});

	it("preserves literal [BOUNDED] profile strings across write and read", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const profile = { arr: ["[BOUNDED]", "must-survive", 3] };
		const account = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "github-bounded-literal",
			profile,
		});
		expect(account.profile).toEqual(profile);
		await expect(
			adapter.getConnectorAccount({
				agentId,
				provider: "github",
				accountKey: "github-bounded-literal",
			}),
		).resolves.toMatchObject({ profile });
	});
});
