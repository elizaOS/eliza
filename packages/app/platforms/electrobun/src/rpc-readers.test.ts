import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { PlatformSecureStore } from "../../../src/security/platform-secure-store";
import { createDatabaseSnapshot } from "./database";
import {
	LaunchOrchestrator,
	type LaunchOrchestratorOptions,
} from "./launch/launch-orchestrator";
import {
	deleteRuntimeCredentialRecord,
	desktopStoreRuntimeCredential,
} from "./runtime-credential-rpc";
import { readSubscriptionStatusViaHttp } from "./subscription-rpc";

async function readSubscriptions(provider: Record<string, unknown>) {
	const server = createServer((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ providers: [provider] }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing TCP address");
		return await readSubscriptionStatusViaHttp(address.port);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}
const provider = {
	provider: "anthropic",
	accountId: "account",
	label: "Claude",
	configured: true,
	valid: true,
	source: "app",
	expiresAt: null,
};
describe("subscription HTTP reader", () => {
	it.each([false, true])(
		"preserves explicit available=%s",
		async (available) => {
			expect(await readSubscriptions({ ...provider, available })).toEqual({
				providers: [{ ...provider, available }],
			});
		},
	);
	it("preserves an omitted availability flag", async () => {
		expect(await readSubscriptions(provider)).toEqual({
			providers: [provider],
		});
	});
	it.each(["false", null, 0])(
		"rejects invalid availability %s",
		async (available) => {
			expect(await readSubscriptions({ ...provider, available })).toBeNull();
		},
	);
});

function launch(overrides: Partial<LaunchOrchestratorOptions> = {}) {
	const status = {
		state: "running" as const,
		agentName: "Eliza",
		port: 31337,
		startedAt: 1,
		error: null,
	};
	return new LaunchOrchestrator({
		agent: {
			getStatus: () => status,
			start: async () => status,
			restart: async () => status,
		},
		readBootProgress: async () => ({
			...status,
			phase: "running",
			lastError: null,
			pluginsLoaded: 1,
			pluginsFailed: 0,
			database: "ok",
			updatedAt: new Date().toISOString(),
		}),
		readAuthStatus: async () => ({
			required: false,
			pairingEnabled: false,
			expiresAt: null,
		}),
		readFirstRunStatus: async () => ({ complete: true }),
		readDiagnostics: () => ({
			...status,
			phase: "running",
			updatedAt: new Date().toISOString(),
			lastError: null,
			logPath: "",
			statusPath: "",
		}),
		readDiagnosticLogTail: () => "",
		createBugReportBundle: () => {
			throw new Error("Unexpected report creation");
		},
		...overrides,
	});
}
describe("launch readiness", () => {
	it("reports ready only after successful status reads", async () => {
		expect((await launch().getProgress()).phase).toBe("ready");
	});
	it.each([
		"readAuthStatus",
		"readFirstRunStatus",
		"readBootProgress",
	] as const)("reports %s failure", async (reader) => {
		const snapshot = await launch({
			[reader]: async () => {
				throw new Error("unavailable");
			},
		}).getProgress();
		expect(snapshot.phase).toBe("error");
	});
	it("reports generic database failure", async () => {
		const snapshot = await launch({
			readDatabaseStatus: () =>
				createDatabaseSnapshot({
					mode: "pglite-persistent",
					status: "error",
					postgresUrlSet: false,
					error: "storage failed",
				}),
		}).getProgress();
		expect(snapshot.phase).toBe("error");
		expect(snapshot.recovery.suggestedAction).toContain("database recovery");
	});
});

describe("runtime credential mutations", () => {
	it.each([false, true])(
		"keeps deletion ordered after an in-flight write (write fails: %s)",
		async (failWrite) => {
			let stored: string | null = null;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const store: PlatformSecureStore = {
				backend: "none",
				isAvailable: async () => true,
				get: async () =>
					stored === null
						? { ok: false, reason: "not_found" }
						: { ok: true, value: stored },
				set: async (_vault, _kind, value) => {
					entered.resolve();
					await release.promise;
					if (failWrite) throw new Error("Credential write failed");
					stored = value;
					return { ok: true };
				},
				delete: async () => {
					const deleted = stored !== null;
					stored = null;
					return { ok: true, deleted };
				},
			};
			const write = desktopStoreRuntimeCredential(
				{ runtimeId: "delete-race", accessToken: "token" },
				store,
			);
			await entered.promise;
			const deletion = deleteRuntimeCredentialRecord("delete-race", store);
			release.resolve();
			const outcomes = await Promise.allSettled([write, deletion]);
			expect(outcomes[0].status).toBe(failWrite ? "rejected" : "fulfilled");
			expect(outcomes[1].status).toBe("fulfilled");
			expect(stored).toBeNull();
		},
	);
});
