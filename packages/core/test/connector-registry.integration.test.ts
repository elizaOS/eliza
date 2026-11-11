/** Real runtime routing and admitted local dispatch across registry changes. */
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, test } from "vitest";
import { AgentRuntime } from "../src/runtime";
import { SEND_HANDLER_NOT_FOUND } from "../src/types/messaging";
import { ModelType } from "../src/types/model";

function newRuntime() {
	const runtime = new AgentRuntime({
		character: { name: "Local connector registry" },
		enableBasicCapabilities: false,
		logLevel: "fatal",
	});
	runtime.registerDatabaseAdapter(
		SQLiteDatabaseAdapter.create(":memory:", runtime.agentId),
	);
	return runtime;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("keeps internal transport and descriptor publication separate", async () => {
	const runtime = newRuntime();
	const delivered: string[] = [];
	const target = { source: "local-chat" };
	const content = { text: "Local receipt", agentVoiced: true };
	try {
		runtime.registerInternalSendHandler(
			"local-chat",
			async (owner, received) => {
				expect(owner).toBe(runtime);
				expect(received).toBe(target);
				delivered.push("internal");
			},
		);
		expect(runtime.getMessageConnectors()).toEqual([]);
		await runtime.sendMessageToTarget(target, content);
		runtime.registerMessageConnector({
			source: "local-chat",
			label: "Published local transport",
		});
		await runtime.sendMessageToTarget(target, content);
		expect(runtime.getMessageConnectors().map(({ label }) => label)).toEqual([
			"Published local transport",
		]);
		runtime.registerSendHandler("local-chat", async () => {
			delivered.push("legacy");
		});
		runtime.registerMessageConnector({
			source: "local-chat",
			label: "Updated",
		});
		await runtime.sendMessageToTarget(target, content);
		expect(delivered).toEqual(["internal", "internal", "legacy"]);
		expect(runtime.getMessageConnectors().map(({ label }) => label)).toEqual([
			"Updated",
		]);
	} finally {
		await runtime.stop();
		await runtime.close();
	}
});

test("selects exact routes and distinguishes exact from source-wide removal", async () => {
	const runtime = newRuntime();
	const delivered: string[] = [];
	const content = { text: "Local routing receipt", agentVoiced: true };
	try {
		runtime.registerSendHandler("local-chat", async () => {
			delivered.push("default");
		});
		runtime.registerMessageConnector({
			source: "local-chat",
			accountId: "work",
			sendHandler: async () => {
				delivered.push("work");
			},
		});
		await runtime.sendMessageToTarget(
			{ source: "local-chat", accountId: "work" },
			content,
		);
		await runtime.sendMessageToTarget(
			{ source: "local-chat", accountId: "other" },
			content,
		);
		expect(
			runtime.unregisterMessageConnector("local-chat", undefined, {
				exactAccount: true,
			}),
		).toBe(true);
		await runtime.sendMessageToTarget(
			{ source: "local-chat", accountId: "work" },
			content,
		);
		await expect(
			runtime.sendMessageToTarget({ source: "local-chat" }, content),
		).rejects.toMatchObject({ code: SEND_HANDLER_NOT_FOUND });
		expect(
			runtime.getMessageConnectors().map(({ accountId }) => accountId),
		).toEqual(["work"]);
		runtime.registerInternalSendHandler("local-chat", async () => {
			delivered.push("restored-default");
		});
		expect(runtime.unregisterMessageConnector("local-chat", "work")).toBe(true);
		runtime.registerMessageConnector({
			source: "local-chat",
			accountId: "work",
			label: "Descriptor without an exact transport",
		});
		await runtime.sendMessageToTarget(
			{ source: "local-chat", accountId: "work" },
			content,
		);
		expect(runtime.unregisterMessageConnector("local-chat")).toBe(true);
		expect(runtime.unregisterMessageConnector("local-chat")).toBe(false);
		expect(runtime.getMessageConnectors()).toEqual([]);
		await expect(
			runtime.sendMessageToTarget(
				{ source: "local-chat", accountId: "work" },
				content,
			),
		).rejects.toMatchObject({ code: SEND_HANDLER_NOT_FOUND });
		expect(delivered).toEqual(["work", "default", "work", "restored-default"]);
	} finally {
		await runtime.stop();
		await runtime.close();
	}
});

for (const change of ["replacement", "unregister"] as const) {
	test(`retains the admitted handler across voice-gate ${change}`, async () => {
		const runtime = newRuntime();
		const started = deferred();
		const release = deferred();
		const delivered: string[] = [];
		const text = `Local voice-gate ${change} receipt`;
		const target = { source: "local-chat", accountId: "work" };
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (owner) => {
				expect(owner).toBe(runtime);
				started.resolve();
				await release.promise;
				if (change === "unregister") throw new Error("Local rephrase failed");
				return "Rephrased local receipt";
			},
			"local",
		);
		runtime.registerMessageConnector({
			source: "local-chat",
			accountId: "work",
			sendHandler: async (owner, received, content) => {
				expect(owner).toBe(runtime);
				expect(received).toBe(target);
				delivered.push(`admitted:${content.text}`);
			},
		});
		const sending = runtime.sendMessageToTarget(target, { text });
		try {
			await started.promise;
			expect(delivered).toEqual([]);
			if (change === "replacement") {
				runtime.registerMessageConnector({
					source: "local-chat",
					accountId: "work",
					sendHandler: async () => {
						delivered.push("replacement");
					},
				});
			} else {
				expect(runtime.unregisterMessageConnector("local-chat", "work")).toBe(
					true,
				);
			}
			release.resolve();
			await sending;
			if (change === "replacement") {
				expect(runtime.getRecentReportedErrors()).toEqual([]);
			}
			expect(delivered).toEqual([
				`admitted:${change === "replacement" ? "Rephrased local receipt" : text}`,
			]);
			if (change === "replacement") {
				await runtime.sendMessageToTarget(target, { text, agentVoiced: true });
				expect(delivered.at(-1)).toBe("replacement");
			} else {
				await expect(
					runtime.sendMessageToTarget(target, { text, agentVoiced: true }),
				).rejects.toMatchObject({ code: SEND_HANDLER_NOT_FOUND });
			}
		} finally {
			release.resolve();
			await sending;
			await runtime.stop();
			await runtime.close();
		}
	});
}

test("propagates admitted failure without retrying the current fallback", async () => {
	const runtime = newRuntime();
	const started = deferred();
	const release = deferred();
	const failure = new Error("Local admitted send failed");
	const delivered: string[] = [];
	const target = { source: "local-chat", accountId: "work" };
	const content = { text: "Local failure receipt", agentVoiced: true };
	runtime.registerSendHandler("local-chat", async () => {
		delivered.push("default");
	});
	runtime.registerMessageConnector({
		source: "local-chat",
		accountId: "work",
		sendHandler: async () => {
			delivered.push("admitted");
			started.resolve();
			await release.promise;
			throw failure;
		},
	});
	const sending = runtime.sendMessageToTarget(target, content);
	const rejected = expect(sending).rejects.toBe(failure);
	try {
		await started.promise;
		runtime.unregisterMessageConnector("local-chat", "work");
		release.resolve();
		await rejected;
		expect(delivered).toEqual(["admitted"]);
		await runtime.sendMessageToTarget(target, content);
		expect(delivered).toEqual(["admitted", "default"]);
	} finally {
		release.resolve();
		await rejected;
		await runtime.stop();
		await runtime.close();
	}
});
