/** Real runtime routing and admitted local dispatch across registry changes. */
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, test } from "vitest";
import { AgentRuntime } from "../src/runtime";
import type { Memory } from "../src/types/memory";
import {
	SEND_HANDLER_NOT_FOUND,
	type TargetInfo,
} from "../src/types/messaging";
import { ModelType } from "../src/types/model";
import type { Content, UUID } from "../src/types/primitives";
import type {
	IAgentRuntime,
	MessageConnectorRegistration,
	PostConnector,
	ThreadHandle,
} from "../src/types/runtime";

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

const localMemory: Memory = {
	id: "11111111-1111-4111-8111-111111111111" as UUID,
	entityId: "22222222-2222-4222-8222-222222222222" as UUID,
	roomId: "33333333-3333-4333-8333-333333333333" as UUID,
	content: { text: "Local hook receipt" },
};
const hookContent: Content = { text: "Local hook content" };
const localThread: ThreadHandle = {
	threadId: "local-thread",
	parentChannelId: "local-channel",
};
const localIdentity = { name: "Local author" };
const hookCases: Array<{
	name: string;
	field: keyof MessageConnectorRegistration;
	invoke: (runtime: AgentRuntime, target: TargetInfo) => Promise<unknown>;
	params: (target: TargetInfo) => object;
	result: Memory | ThreadHandle | undefined;
}> = [
	{
		name: "edit",
		field: "editHandler",
		invoke: (runtime, target) =>
			runtime.editMessageOnTarget(target, "local-message", hookContent),
		params: (target) => ({
			target,
			messageId: "local-message",
			content: hookContent,
		}),
		result: localMemory,
	},
	{
		name: "typing",
		field: "typingHandler",
		invoke: (runtime, target) => runtime.sendTypingOnTarget(target),
		params: (target) => ({ target }),
		result: undefined,
	},
	{
		name: "stop typing",
		field: "stopTypingHandler",
		invoke: (runtime, target) => runtime.stopTypingOnTarget(target),
		params: (target) => ({ target }),
		result: undefined,
	},
	{
		name: "create thread",
		field: "createThreadHandler",
		invoke: (runtime, target) =>
			runtime.createThreadOnTarget(target, {
				parentMessageId: "local-message",
				name: "Local thread",
			}),
		params: (target) => ({
			target,
			parentMessageId: "local-message",
			name: "Local thread",
		}),
		result: localThread,
	},
	{
		name: "post to thread",
		field: "postToThreadHandler",
		invoke: (runtime, target) =>
			runtime.postToThreadOnTarget(
				target,
				localThread,
				hookContent,
				localIdentity,
			),
		params: (target) => ({
			target,
			thread: localThread,
			content: hookContent,
			identity: localIdentity,
		}),
		result: localMemory,
	},
	{
		name: "reaction",
		field: "reactHandler",
		invoke: (runtime, target) =>
			runtime.addReactionOnTarget(target, "local-message", "local-reaction"),
		params: (target) => ({
			target,
			messageId: "local-message",
			emoji: "local-reaction",
		}),
		result: undefined,
	},
];

for (const hook of hookCases) {
	test(`keeps ${hook.name} bound to its descriptor across replacement and removal`, async () => {
		const runtime = newRuntime();
		const target = { source: "local-hook", accountId: "work" };
		const started = deferred();
		const release = deferred();
		const calls: string[] = [];
		const failure = new Error(`Local ${hook.name} failure`);
		runtime.registerMessageConnector({
			source: target.source,
			[hook.field]: async () => {
				calls.push("default");
				return hook.result;
			},
		});
		runtime.registerMessageConnector({
			...target,
			[hook.field]: async (owner: IAgentRuntime, params: object) => {
				expect(owner).toBe(runtime);
				expect(params).toEqual(hook.params(target));
				calls.push("admitted");
				started.resolve();
				await release.promise;
				return hook.result;
			},
		});
		const admitted = hook.invoke(runtime, target);
		try {
			await started.promise;
			runtime.registerMessageConnector({
				...target,
				label: "Metadata replacement",
			});
			release.resolve();
			expect(await admitted).toBe(hook.result);
			await expect(hook.invoke(runtime, target)).rejects.toThrow(
				"Connector does not support",
			);
			expect(calls).toEqual(["admitted"]);
			expect(
				runtime.unregisterMessageConnector(target.source, target.accountId),
			).toBe(true);
			expect(await hook.invoke(runtime, target)).toBe(hook.result);
			runtime.registerMessageConnector({
				...target,
				[hook.field]: async () => {
					calls.push("failed");
					throw failure;
				},
			});
			await expect(hook.invoke(runtime, target)).rejects.toBe(failure);
			expect(calls).toEqual(["admitted", "default", "failed"]);
			expect(runtime.unregisterMessageConnector(target.source)).toBe(true);
			await expect(hook.invoke(runtime, target)).rejects.toThrow(
				"No message connector registered",
			);
		} finally {
			release.resolve();
			await admitted;
			await runtime.stop();
			await runtime.close();
		}
	});
}

const postContext = { source: "local-post", accountId: "work" };
const postCases: Array<{
	field: "postHandler" | "fetchFeed" | "searchPosts";
	invoke: (connector: PostConnector, runtime: AgentRuntime) => unknown;
	args: (runtime: AgentRuntime) => unknown[];
	result: Memory | Memory[];
}> = [
	{
		field: "postHandler",
		invoke: (connector, runtime) =>
			connector.postHandler?.(runtime, hookContent, {
				runtime,
				...postContext,
			}),
		args: (runtime) => [runtime, hookContent, { runtime, ...postContext }],
		result: localMemory,
	},
	{
		field: "fetchFeed",
		invoke: (connector, runtime) =>
			connector.fetchFeed?.(
				{ runtime, ...postContext },
				{ feed: "local-feed", cursor: "local-cursor" },
			),
		args: (runtime) => [
			{ runtime, ...postContext },
			{ feed: "local-feed", cursor: "local-cursor" },
		],
		result: [localMemory],
	},
	{
		field: "searchPosts",
		invoke: (connector, runtime) =>
			connector.searchPosts?.(
				{ runtime, ...postContext },
				{ query: "local-query", cursor: "local-cursor" },
			),
		args: (runtime) => [
			{ runtime, ...postContext },
			{ query: "local-query", cursor: "local-cursor" },
		],
		result: [localMemory],
	},
];

for (const hook of postCases) {
	test(`retains an enumerated ${hook.field} while post registrations change`, async () => {
		const runtime = newRuntime();
		const started = deferred();
		const release = deferred();
		const calls: string[] = [];
		const failure = new Error(`Local ${hook.field} failure`);
		runtime.registerSendHandler(postContext.source, async () => {
			calls.push("message");
		});
		runtime.registerPostConnector({
			source: postContext.source,
			[hook.field]: async () => hook.result,
		});
		runtime.registerPostConnector({
			...postContext,
			[hook.field]: async (...args: unknown[]) => {
				expect(args).toEqual(hook.args(runtime));
				calls.push("admitted");
				started.resolve();
				await release.promise;
				return hook.result;
			},
		});
		const captured = runtime
			.getPostConnectors()
			.find((connector) => connector.accountId === postContext.accountId);
		expect(captured?.[hook.field]).toBeTypeOf("function");
		if (!captured) throw new Error("Missing local post descriptor");
		runtime.registerPostConnector({
			...postContext,
			label: "Metadata replacement",
		});
		expect(
			runtime
				.getPostConnectors()
				.find((connector) => connector.accountId === postContext.accountId)?.[
				hook.field
			],
		).toBeUndefined();
		expect(
			runtime.unregisterPostConnector(postContext.source, undefined, {
				exactAccount: true,
			}),
		).toBe(true);
		expect(
			runtime.getPostConnectors().map((connector) => connector.accountId),
		).toEqual(["work"]);
		const admitted = hook.invoke(captured, runtime);
		try {
			await started.promise;
			expect(runtime.unregisterPostConnector(postContext.source)).toBe(true);
			expect(runtime.unregisterPostConnector(postContext.source)).toBe(false);
			expect(runtime.getPostConnectors()).toEqual([]);
			await runtime.sendMessageToTarget(
				{ source: postContext.source },
				{ text: "Separate local message", agentVoiced: true },
			);
			runtime.registerPostConnector({
				...postContext,
				[hook.field]: async () => {
					calls.push("failed");
					throw failure;
				},
			});
			expect(runtime.unregisterMessageConnector(postContext.source)).toBe(true);
			expect(
				runtime.getPostConnectors().map((connector) => connector.accountId),
			).toEqual(["work"]);
			const replacement = runtime.getPostConnectors()[0];
			if (!replacement) throw new Error("Missing replacement post descriptor");
			await expect(hook.invoke(replacement, runtime)).rejects.toBe(failure);
			release.resolve();
			expect(await admitted).toBe(hook.result);
			expect(calls).toEqual(["admitted", "message", "failed"]);
		} finally {
			release.resolve();
			await admitted;
			await runtime.stop();
			await runtime.close();
		}
	});
}
