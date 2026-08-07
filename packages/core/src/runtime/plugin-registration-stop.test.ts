/** Proves a plugin whose async initialization outlives runtime stop cannot publish late capabilities. */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import type { Action, Plugin } from "../types";

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("plugin registration during runtime stop", () => {
	it("rolls back a plugin that finishes initialization after stop", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const initialization = deferred();
		const enteredInitialization = deferred();
		const lateAction: Action = {
			name: "LATE_ACTION",
			description: "Must never become visible after runtime stop",
			similes: [],
			examples: [],
			validate: async () => true,
			handler: async () => ({ success: true }),
		};
		const plugin: Plugin = {
			name: "late-plugin",
			description: "Waits until the owning runtime stops",
			init: async () => {
				enteredInitialization.resolve();
				await initialization.promise;
			},
			actions: [lateAction],
		};

		const registration = runtime.registerPlugin(plugin);
		await enteredInitialization.promise;
		await runtime.stop({ fast: true });
		initialization.resolve();

		await expect(registration).rejects.toMatchObject({
			code: "RUNTIME_STOPPED_DURING_PLUGIN_REGISTRATION",
		});
		expect(runtime.actions).not.toContain(lateAction);
		expect(runtime.plugins).not.toContain(plugin);
		await expect(
			registration.catch((error) => error instanceof ElizaError),
		).resolves.toBe(true);
	});
});
