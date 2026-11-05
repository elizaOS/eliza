/**
 * Chat calls RESPONSE_HANDLER and ACTION_PLANNER directly, not through the
 * router, and a remote provider (Eliza Cloud) registers them at a higher
 * priority than the local backend. An "On-device only" policy on the text
 * slot must still keep those calls on the device: the remote registration is
 * refused and the runtime falls back to local, or fails when no local backend
 * is registered.
 *
 * Runs the real router hook on a real AgentRuntime, with the policy written to
 * a real routing.json under a temporary state dir.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRouterHandler } from "./router-handler";
import { setPolicy } from "./routing-preferences";

const ENV_KEYS = ["ELIZA_STATE_DIR", "ELIZA_LOCAL_ONLY"] as const;
const priorEnv = new Map<string, string | undefined>();
let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "router-local-only-chat-"));
	for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
	process.env.ELIZA_STATE_DIR = stateDir;
	delete process.env.ELIZA_LOCAL_ONLY;
});

afterEach(() => {
	for (const [key, value] of priorEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(stateDir, { recursive: true, force: true });
});

function makeRuntime(options: { local: boolean }): {
	runtime: AgentRuntime;
	calls: string[];
} {
	const runtime = createSQLiteTestRuntime({
		character: {
			name: "LocalOnlyChatTest",
			bio: "local-only chat routing test",
			settings: {},
		} as never,
		logLevel: "fatal",
	});
	const calls: string[] = [];
	for (const modelType of [
		ModelType.RESPONSE_HANDLER,
		ModelType.ACTION_PLANNER,
	]) {
		if (options.local) {
			runtime.registerModel(
				modelType,
				async () => {
					calls.push(`eliza-local-inference:${modelType}`);
					return "local reply";
				},
				"eliza-local-inference",
				0,
			);
		}
	}
	// Eliza Cloud registers the chat brain at priority 50, including the
	// fallback text types the runtime tries after RESPONSE_HANDLER.
	for (const modelType of [
		ModelType.RESPONSE_HANDLER,
		ModelType.ACTION_PLANNER,
		ModelType.TEXT_NANO,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_LARGE,
	]) {
		runtime.registerModel(
			modelType,
			async () => {
				calls.push(`elizaOSCloud:${modelType}`);
				return "cloud reply";
			},
			"elizaOSCloud",
			50,
		);
	}
	installRouterHandler(runtime);
	return { runtime, calls };
}

describe("on-device-only policy for the chat model types", () => {
	it("serves RESPONSE_HANDLER and ACTION_PLANNER locally, never from Cloud", async () => {
		await setPolicy("TEXT_SMALL", "local-only");
		await setPolicy("TEXT_LARGE", "local-only");
		const { runtime, calls } = makeRuntime({ local: true });

		await runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hi" });
		await runtime.useModel(ModelType.ACTION_PLANNER, { prompt: "hi" });

		expect(calls).toEqual([
			`eliza-local-inference:${ModelType.RESPONSE_HANDLER}`,
			`eliza-local-inference:${ModelType.ACTION_PLANNER}`,
		]);
	});

	it("fails instead of using Cloud when no local backend is registered", async () => {
		await setPolicy("TEXT_SMALL", "local-only");
		await setPolicy("TEXT_LARGE", "local-only");
		const { runtime, calls } = makeRuntime({ local: false });

		// Cloud is refused for RESPONSE_HANDLER and for each fallback type
		// (TEXT_NANO, TEXT_MEDIUM, and the TEXT_SMALL / TEXT_LARGE routers), so
		// the call fails without a remote call and names the policy.
		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hi" }),
		).rejects.toThrow(/on-device only/);
		expect(calls).toEqual([]);
	});

	it("keeps the Cloud chat brain under the default policy", async () => {
		const { runtime, calls } = makeRuntime({ local: true });

		await runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hi" });

		expect(calls).toEqual([`elizaOSCloud:${ModelType.RESPONSE_HANDLER}`]);
	});
});
