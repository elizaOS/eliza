import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import {
	SECRETS_BROKER_STRICT_KEY,
	SECRETS_BROKER_TOKEN_KEY,
	SECRETS_BROKER_URL_KEY,
	SecretsBrokerUnavailableError,
} from "../storage/index.ts";
import type {
	ISecretBrokerClient,
	SecretContext,
	SecretHandle,
} from "../types.ts";
import {
	isSerializedSecretHandle,
	parseSecretHandle,
	SECRET_HANDLE_MARKER,
} from "../types.ts";
import { SecretsService } from "./secrets.ts";

/**
 * Build a mock runtime whose `getSetting` returns the supplied env map plus a
 * fixed ENCRYPTION_SALT (required by the local backend), with a character that
 * has a settings.secrets object the local store can use.
 */
function runtimeWithEnv(
	env: Record<string, string | undefined>,
): IAgentRuntime {
	return createMockRuntime({
		getSetting: ((key: string) =>
			key === "ENCRYPTION_SALT"
				? "test-salt"
				: env[key]) as IAgentRuntime["getSetting"],
		character: {
			name: "T",
			bio: [],
			settings: { secrets: {} },
		} as IAgentRuntime["character"],
	});
}

const GLOBAL_CTX = (agentId: string): SecretContext => ({
	level: "global",
	agentId,
});

function makeHandleBroker(
	over: Partial<SecretHandle> = {},
): ISecretBrokerClient {
	const handle: SecretHandle = {
		marker: SECRET_HANDLE_MARKER,
		ref: "lease-xyz",
		key: "OPENAI_API_KEY",
		resolveVia: "model-gateway",
		...over,
	};
	return {
		hasSecret: vi.fn(async (k: string) => k === handle.key),
		issueHandle: vi.fn(async (k: string) => (k === handle.key ? handle : null)),
	};
}

async function startService(
	runtime: IAgentRuntime,
	brokerClient?: ISecretBrokerClient,
): Promise<SecretsService> {
	return SecretsService.start(runtime, { brokerClient });
}

describe("SecretsService — broker UNSET: local default unchanged", () => {
	it("uses the local composite store when no broker env is set", async () => {
		const runtime = runtimeWithEnv({});
		const client = makeHandleBroker();
		const svc = await startService(runtime, client);

		// A client was supplied but the env is unset -> broker never activates.
		const ctx = GLOBAL_CTX(runtime.agentId);
		await svc.set("LOCAL_KEY", "local-value", ctx);
		expect(await svc.get("LOCAL_KEY", ctx)).toBe("local-value");
		// broker was never consulted
		expect(client.issueHandle).not.toHaveBeenCalled();
	});

	it("does not activate the broker when env is set but no client is supplied", async () => {
		const runtime = runtimeWithEnv({
			[SECRETS_BROKER_URL_KEY]: "https://broker.example",
			[SECRETS_BROKER_TOKEN_KEY]: "handle-abc",
		});
		const svc = await startService(runtime); // no brokerClient

		const ctx = GLOBAL_CTX(runtime.agentId);
		await svc.set("LOCAL_KEY", "local-value", ctx);
		expect(await svc.get("LOCAL_KEY", ctx)).toBe("local-value");
	});
});

describe("SecretsService — broker CONFIGURED: precedence + handles", () => {
	it("returns a serialized handle (never plaintext) for a broker-held key", async () => {
		const runtime = runtimeWithEnv({
			[SECRETS_BROKER_URL_KEY]: "https://broker.example",
			[SECRETS_BROKER_TOKEN_KEY]: "handle-abc",
		});
		const client = makeHandleBroker();
		const svc = await startService(runtime, client);

		const ctx = GLOBAL_CTX(runtime.agentId);
		const value = await svc.get("OPENAI_API_KEY", ctx);
		expect(isSerializedSecretHandle(value)).toBe(true);
		expect(parseSecretHandle(value)?.ref).toBe("lease-xyz");
		expect(await svc.exists("OPENAI_API_KEY", ctx)).toBe(true);
	});

	it("falls through to local for keys the broker does not hold", async () => {
		const runtime = runtimeWithEnv({
			[SECRETS_BROKER_URL_KEY]: "https://broker.example",
			[SECRETS_BROKER_TOKEN_KEY]: "handle-abc",
		});
		const svc = await startService(runtime, makeHandleBroker());

		const ctx = GLOBAL_CTX(runtime.agentId);
		await svc.set("LOCAL_ONLY", "local-value", ctx);
		expect(await svc.get("LOCAL_ONLY", ctx)).toBe("local-value");
	});
});

describe("SecretsService — fail-closed under strict", () => {
	it("propagates SecretsBrokerUnavailableError instead of falling back to local", async () => {
		const runtime = runtimeWithEnv({
			[SECRETS_BROKER_URL_KEY]: "https://broker.example",
			[SECRETS_BROKER_TOKEN_KEY]: "handle-abc",
			[SECRETS_BROKER_STRICT_KEY]: "1",
		});
		// A configured-but-unreachable broker.
		const unreachable: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
			issueHandle: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		};
		const svc = await startService(runtime, unreachable);

		const ctx = GLOBAL_CTX(runtime.agentId);
		// Even though a local value would exist, strict mode must fail closed and
		// never silently serve from the plaintext-capable local store.
		await svc.set("OPENAI_API_KEY", "local-plaintext", ctx);
		await expect(svc.get("OPENAI_API_KEY", ctx)).rejects.toBeInstanceOf(
			SecretsBrokerUnavailableError,
		);
	});

	it("non-strict: unreachable broker degrades to local (soft)", async () => {
		const runtime = runtimeWithEnv({
			[SECRETS_BROKER_URL_KEY]: "https://broker.example",
			[SECRETS_BROKER_TOKEN_KEY]: "handle-abc",
			// strict unset
		});
		const unreachable: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => false),
			issueHandle: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		};
		const svc = await startService(runtime, unreachable);

		const ctx = GLOBAL_CTX(runtime.agentId);
		await svc.set("OPENAI_API_KEY", "local-plaintext", ctx);
		expect(await svc.get("OPENAI_API_KEY", ctx)).toBe("local-plaintext");
	});
});
