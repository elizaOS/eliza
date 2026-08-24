/**
 * Deterministic unit suite for SecretsService itself (features/secrets):
 * covers the ENCRYPTION_SALT_REQUIRED construction guard, global/world/user
 * level routing and isolation, created-vs-updated-vs-deleted change events
 * with unsubscribe semantics, offline validation failures that reject writes,
 * plugin requirement classification, getMissingSecrets level behaviour, and
 * the access-log ring buffer with its filters and defensive copies. Runs
 * against createMockRuntime with real encrypted storage round-trips — no
 * network, no mocked subject.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	Component,
	IAgentRuntime,
	UUID,
	World,
} from "../../../types/index.ts";
import { EncryptionError } from "../crypto/encryption.ts";
import type { PluginSecretRequirement, SecretContext } from "../types.ts";
import { SecretsError } from "../types.ts";
import { SECRETS_SERVICE_TYPE, SecretsService } from "./secrets.ts";

const WORLD_ID = "00000000-0000-0000-0000-000000000010" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000020" as UUID;

/**
 * Mock runtime with the fixed ENCRYPTION_SALT the local backends require plus
 * an isolated character.settings.secrets object, extended with small in-memory
 * fakes for the world/component surfaces the world and user stores drive.
 */
function makeRuntime(
	overrides: { world?: World; components?: Component[] } = {},
): IAgentRuntime {
	const world: World | undefined = overrides.world;
	const components: Component[] = overrides.components ?? [];
	return createMockRuntime({
		getSetting: ((key: string) =>
			key === "ENCRYPTION_SALT"
				? "test-salt"
				: undefined) as IAgentRuntime["getSetting"],
		character: {
			name: "T",
			bio: [],
			settings: { secrets: {} },
		} as IAgentRuntime["character"],
		getWorld: (async (id: UUID) =>
			id === world?.id ? world : null) as IAgentRuntime["getWorld"],
		updateWorld: (async (updated: World) => {
			if (updated.id === world?.id) {
				Object.assign(world, updated);
				return true;
			}
			return false;
		}) as IAgentRuntime["updateWorld"],
		getComponents: (async (_entityId: UUID) =>
			components.slice()) as IAgentRuntime["getComponents"],
		createComponent: (async (component: Component) => {
			components.push(component);
			return true;
		}) as IAgentRuntime["createComponent"],
		updateComponent: (async (component: Component) => {
			const index = components.findIndex((c) => c.id === component.id);
			if (index === -1) return false;
			components[index] = component;
			return true;
		}) as IAgentRuntime["updateComponent"],
		deleteComponent: (async (id: UUID) => {
			const index = components.findIndex((c) => c.id === id);
			if (index === -1) return false;
			components.splice(index, 1);
			return true;
		}) as IAgentRuntime["deleteComponent"],
	});
}

const GLOBAL_CTX = (agentId: string): SecretContext => ({
	level: "global",
	agentId,
	requesterId: agentId,
});

async function startService(
	runtime: IAgentRuntime,
	config?: Parameters<typeof SecretsService.start>[1],
): Promise<SecretsService> {
	return SecretsService.start(runtime, config);
}

describe("SecretsService — construction and identity", () => {
	it("exports the SECRETS service type constant the registry keys on", () => {
		expect(SECRETS_SERVICE_TYPE).toBe("SECRETS");
		expect(SecretsService.serviceType).toBe(SECRETS_SERVICE_TYPE);
	});

	it("refuses to construct without ENCRYPTION_SALT when a runtime is supplied", async () => {
		const runtime = createMockRuntime({
			getSetting: (() => undefined) as IAgentRuntime["getSetting"],
		});
		expect(() => new SecretsService(runtime)).toThrow(SecretsError);
		await expect(SecretsService.start(runtime)).rejects.toMatchObject({
			name: "SecretsError",
			code: "ENCRYPTION_SALT_REQUIRED",
		});
	});

	it("starts against a mock runtime and serves an encrypted global round-trip", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		const ctx = GLOBAL_CTX(runtime.agentId);

		await svc.set("API_TOKEN", "hunter2", ctx);
		expect(await svc.get("API_TOKEN", ctx)).toBe("hunter2");
	});
});

describe("SecretsService — level routing and isolation", () => {
	it("keeps global, world, and user scopes separate for the same key", async () => {
		const world: World = {
			id: WORLD_ID,
			name: "W",
			agentId: "00000000-0000-0000-0000-000000000000",
			metadata: {},
		} as World;
		const components: Component[] = [];
		const runtime = makeRuntime({ world, components });
		const svc = await startService(runtime);

		await svc.setGlobal("SHARED_KEY", "global-value");
		await svc.setWorld("SHARED_KEY", "world-value", WORLD_ID);
		await svc.setUser("SHARED_KEY", "user-value", USER_ID);

		expect(await svc.getGlobal("SHARED_KEY")).toBe("global-value");
		expect(await svc.getWorld("SHARED_KEY", WORLD_ID)).toBe("world-value");
		expect(await svc.getUser("SHARED_KEY", USER_ID)).toBe("user-value");
	});

	it("stores user secrets encrypted at rest, never as plaintext components", async () => {
		const components: Component[] = [];
		const runtime = makeRuntime({ components });
		const svc = await startService(runtime);

		await svc.setUser("USER_TOKEN", "plaintext-value", USER_ID);

		expect(components).toHaveLength(1);
		const serialized = JSON.stringify(components[0]?.data);
		expect(serialized).toContain("USER_TOKEN");
		expect(serialized).not.toContain("plaintext-value");
	});

	it("returns null for a missing secret instead of throwing", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);

		expect(await svc.getGlobal("NEVER_SET")).toBeNull();
	});
});

describe("SecretsService — change notifications", () => {
	it("emits created then updated, delivering values in order to subscribers", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		const seen: Array<[string, string | null]> = [];
		svc.onAnySecretChanged((key, value) => seen.push([key, value]));

		await svc.setGlobal("EVENT_KEY", "v1");
		await svc.setGlobal("EVENT_KEY", "v2");

		expect(seen).toEqual([
			["EVENT_KEY", "v1"],
			["EVENT_KEY", "v2"],
		]);
	});

	it("emits a null-valued event on deletion and nothing when the write fails", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		const seen: Array<[string, string | null]> = [];
		svc.onAnySecretChanged((key, value) => seen.push([key, value]));

		const ctx = GLOBAL_CTX(runtime.agentId);
		expect(await svc.delete("GHOST", ctx)).toBe(false);
		await svc.setGlobal("LIFE_KEY", "alive");
		expect(await svc.delete("LIFE_KEY", ctx)).toBe(true);
		await expect(
			svc.setGlobal("BAD_URL", "::not a url::", {
				validationMethod: "url:valid",
			}),
		).rejects.toBeInstanceOf(SecretsError);

		expect(seen).toEqual([
			["LIFE_KEY", "alive"],
			["LIFE_KEY", null],
		]);
	});

	it("scopes key subscriptions to their key and stops after unsubscribe", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		const calls: string[] = [];
		const off = svc.onSecretChanged("WATCHED", () => calls.push("watched"));

		await svc.setGlobal("OTHER", "x");
		expect(calls).toEqual([]);

		await svc.setGlobal("WATCHED", "x");
		expect(calls).toEqual(["watched"]);

		off();
		await svc.setGlobal("WATCHED", "y");
		expect(calls).toEqual(["watched"]);
	});
});

describe("SecretsService — validation", () => {
	it("rejects a write whose configured validation strategy fails and stores nothing", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);

		await expect(
			svc.setGlobal("ENDPOINT_URL", "not-a-url", {
				type: "url",
				required: true,
				description: "",
				canGenerate: false,
				status: "missing",
				attempts: 0,
				plugin: "test",
				level: "global",
				validationMethod: "url:valid",
			}),
		).rejects.toMatchObject({
			name: "SecretsError",
			code: "VALIDATION_FAILED",
		});
		expect(await svc.getGlobal("ENDPOINT_URL")).toBeNull();

		const failures = svc.getAccessLogs({
			key: "ENDPOINT_URL",
			action: "write",
		});
		expect(failures.some((l) => !l.success)).toBe(true);
	});

	it("delegates validate() to the named strategy and lists available strategies", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);

		const ok = await svc.validate("U", "https://example.com/api", "url:valid");
		expect(ok.isValid).toBe(true);
		const bad = await svc.validate("U", "::bad::", "url:valid");
		expect(bad.isValid).toBe(false);

		const strategies = svc.getValidationStrategies();
		expect(strategies).toContain("url:valid");
		expect(strategies).toContain("api_key:openai");
	});
});

describe("SecretsService — plugin requirements", () => {
	const requirement = (
		over: Partial<PluginSecretRequirement>,
	): PluginSecretRequirement => ({
		description: "d",
		type: "api_key",
		required: true,
		...over,
	});

	it("classifies missing required, missing optional, and invalid values", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		await svc.setGlobal("PRESENT_KEY", "good-value");
		await svc.setGlobal("INVALID_URL", "::bad::");

		const result = await svc.checkPluginRequirements("plugin-x", {
			PRESENT_KEY: requirement({}),
			MISSING_REQUIRED: requirement({}),
			MISSING_OPTIONAL: requirement({ required: false }),
			INVALID_URL: requirement({
				type: "url",
				validationMethod: "url:valid",
			}),
		});

		expect(result.ready).toBe(false);
		expect(result.missingRequired).toEqual(["MISSING_REQUIRED"]);
		expect(result.missingOptional).toEqual(["MISSING_OPTIONAL"]);
		expect(result.invalid).toEqual(["INVALID_URL"]);
	});

	it("reports ready when every required secret is present and valid", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		await svc.setGlobal("ONLY_KEY", "fine");

		const result = await svc.checkPluginRequirements("plugin-x", {
			ONLY_KEY: requirement({}),
		});
		expect(result).toMatchObject({
			ready: true,
			missingRequired: [],
			missingOptional: [],
			invalid: [],
		});
	});
});

describe("SecretsService — getMissingSecrets", () => {
	it("reports only absent keys at the global level", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		await svc.setGlobal("HAVE_THIS", "x");

		expect(await svc.getMissingSecrets(["HAVE_THIS", "NOT_THIS"], "global")) //
			.toEqual(["NOT_THIS"]);
	});

	it("reports every key as missing for world and user levels, which need ids", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		await svc.setGlobal("STORED_GLOBALLY", "x");

		expect(await svc.getMissingSecrets(["STORED_GLOBALLY"], "world")) //
			.toEqual(["STORED_GLOBALLY"]);
		expect(await svc.getMissingSecrets(["STORED_GLOBALLY"], "user")) //
			.toEqual(["STORED_GLOBALLY"]);
	});
});

describe("SecretsService — access logging", () => {
	it("records operations and filters by key, action, since, and context level", async () => {
		const world: World = {
			id: WORLD_ID,
			name: "W",
			agentId: "00000000-0000-0000-0000-000000000000",
			metadata: {},
		} as World;
		const runtime = makeRuntime({ world });
		const svc = await startService(runtime);
		const t0 = Date.now();

		await svc.setGlobal("LOG_A", "1");
		await svc.setGlobal("LOG_B", "2");
		await svc.setWorld("LOG_C", "3", WORLD_ID);

		expect(svc.getAccessLogs().length).toBe(3);

		const byKey = svc.getAccessLogs({ key: "LOG_A" });
		expect(byKey).toHaveLength(1);
		expect(byKey[0]?.secretKey).toBe("LOG_A");

		expect(svc.getAccessLogs({ action: "write" })).toHaveLength(3);
		expect(svc.getAccessLogs({ action: "delete" })).toHaveLength(0);

		expect(svc.getAccessLogs({ since: t0 })).toHaveLength(3);
		expect(svc.getAccessLogs({ since: Date.now() + 600_000 })).toHaveLength(0);

		const globalOnly = svc.getAccessLogs({ context: { level: "global" } });
		expect(globalOnly.map((l) => l.secretKey).sort()).toEqual([
			"LOG_A",
			"LOG_B",
		]);
		const worldOnly = svc.getAccessLogs({ context: { level: "world" } });
		expect(worldOnly.map((l) => l.secretKey)).toEqual(["LOG_C"]);

		for (const log of svc.getAccessLogs()) {
			expect(log.success).toBe(true);
			expect(log.accessedBy).toBe(runtime.agentId);
			expect(log.timestamp).toBeGreaterThanOrEqual(t0);
		}
	});

	it("trims the log to maxAccessLogEntries, keeping the newest entries", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime, { maxAccessLogEntries: 3 });

		await svc.setGlobal("TRIM_1", "a");
		await svc.setGlobal("TRIM_2", "b");
		await svc.setGlobal("TRIM_3", "c");
		await svc.setGlobal("TRIM_4", "d");
		await svc.setGlobal("TRIM_5", "e");

		const logs = svc.getAccessLogs();
		expect(logs).toHaveLength(3);
		expect(logs.map((l) => l.secretKey)).toEqual([
			"TRIM_3",
			"TRIM_4",
			"TRIM_5",
		]);
	});

	it("records nothing when enableAccessLogging is false, and clearAccessLogs empties", async () => {
		const runtime = makeRuntime();
		const quiet = await startService(runtime, { enableAccessLogging: false });
		await quiet.setGlobal("QUIET_KEY", "v");
		expect(quiet.getAccessLogs()).toEqual([]);

		const loud = await startService(makeRuntime());
		await loud.setGlobal("LOUD_KEY", "v");
		expect(loud.getAccessLogs()).toHaveLength(1);
		loud.clearAccessLogs();
		expect(loud.getAccessLogs()).toEqual([]);
	});

	it("hands callers a copy of the log buffer, not the live array", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		await svc.setGlobal("COPY_KEY", "v");

		const snapshot = svc.getAccessLogs();
		snapshot.push({
			secretKey: "FORGED",
			accessedBy: runtime.agentId,
			action: "read",
			timestamp: Date.now(),
			context: GLOBAL_CTX(runtime.agentId),
			success: true,
		});

		expect(svc.getAccessLogs()).toHaveLength(1);
		expect(svc.getAccessLogs()[0]?.secretKey).toBe("COPY_KEY");
	});
});

describe("SecretsService — config and listing", () => {
	it("round-trips getConfig/updateConfig and reports unknown keys honestly", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);

		expect(await svc.getConfig("CFG_KEY", GLOBAL_CTX(runtime.agentId))) //
			.toBeNull();
		await svc.setGlobal("CFG_KEY", "v");
		expect(
			await svc.updateConfig("CFG_KEY", GLOBAL_CTX(runtime.agentId), {
				description: "updated description",
			}),
		).toBe(true);
		expect(
			(await svc.getConfig("CFG_KEY", GLOBAL_CTX(runtime.agentId)))
				?.description,
		).toBe("updated description");

		expect(
			await svc.getConfig("UNKNOWN_KEY", GLOBAL_CTX(runtime.agentId)),
		).toBeNull();
		expect(
			await svc.updateConfig("UNKNOWN_KEY", GLOBAL_CTX(runtime.agentId), {
				description: "nope",
			}),
		).toBe(false);
	});

	it("lists stored keys with metadata only and never leaks values", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		await svc.setGlobal("LIST_A", "secret-value-a");
		await svc.setGlobal("LIST_B", "secret-value-b");

		const metadata = await svc.list(GLOBAL_CTX(runtime.agentId));
		expect(Object.keys(metadata).sort()).toEqual(["LIST_A", "LIST_B"]);
		const serialized = JSON.stringify(metadata);
		expect(serialized).not.toContain("secret-value-a");
		expect(serialized).not.toContain("secret-value-b");
	});

	it("stop() empties access logs and fails closed on later operations", async () => {
		const runtime = makeRuntime();
		const svc = await startService(runtime);
		await svc.setGlobal("STOP_KEY", "v");

		await svc.stop();
		expect(svc.getAccessLogs()).toEqual([]);

		// Teardown wiped the encryption keys, so further secret operations
		// reject instead of serving or writing anything.
		await expect(svc.setGlobal("STOP_KEY", "after-stop")).rejects.toThrow(
			EncryptionError,
		);
	});
});
