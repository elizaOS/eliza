import { ElizaRuntimeApiClient } from "../bun/api-client.ts";
import { serializeError } from "../bun/errors.ts";
import { RuntimeLogBuffer } from "../bun/log-buffer.ts";
import { ElizaRuntimeManager } from "../bun/runtime-manager.ts";
import type { AgentMessageParams } from "../bun/protocol.ts";

function writeJson(label: string, value: unknown): void {
	process.stdout.write(`${JSON.stringify({ label, value }, null, 2)}\n`);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function capture(label: string, task: () => Promise<unknown>): Promise<unknown> {
	try {
		const value = await task();
		writeJson(label, { ok: true, value });
		return value;
	} catch (error) {
		const serialized = serializeError(error);
		writeJson(label, { ok: false, error: serialized });
		return serialized;
	}
}

const logBuffer = new RuntimeLogBuffer();
const manager = new ElizaRuntimeManager({ logBuffer });
const apiClient = new ElizaRuntimeApiClient({
	getApiBase: () => manager.status().apiBase,
	getAuthToken: () =>
		process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null,
});

writeJson("initialStatus", manager.status());

const initialHealth = await manager.health();
if (!initialHealth.ok && manager.status().mode !== "running") {
	await capture("runtimeStart", () => manager.start());
	await wait(2500);
} else {
	writeJson("runtimeStart", {
		ok: true,
		value: {
			mode: manager.status().mode,
			apiAlreadyReachable: initialHealth.ok,
		},
	});
}

await capture("api.discover", () => apiClient.discover(true));
await capture("api.status", () => apiClient.status());
await capture("agent.list", () => apiClient.listAgents());
await capture("plugin.list", () => apiClient.listPlugins());
await capture("conversation.list", () => apiClient.listConversations());
await capture("memory.search", () =>
	apiClient.searchMemory({ query: "test", limit: 5 }),
);

if (process.env.ELIZA_PHASE2_SEND_TEST_MESSAGE === "1") {
	const message: AgentMessageParams = {
		text: "Phase 2 ElizaLaunch API bridge smoke test. Reply briefly.",
	};
	await capture("agent.message", () => apiClient.sendMessage(message));
} else {
	writeJson("agent.message", {
		ok: true,
		skipped: "Set ELIZA_PHASE2_SEND_TEST_MESSAGE=1 to send a real message.",
	});
}

writeJson("logsTail", manager.logsTail(20));

if (process.env.ELIZA_PHASE2_STOP_AFTER === "1") {
	await capture("runtimeStop", () => manager.stop());
} else {
	writeJson("runtimeStop", {
		ok: true,
		skipped: "Set ELIZA_PHASE2_STOP_AFTER=1 to stop after the smoke run.",
	});
}

writeJson("finalStatus", manager.status());
