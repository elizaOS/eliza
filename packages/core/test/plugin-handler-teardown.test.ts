/** Plugin unload must tear down chat pre-handlers and response-handler
 * (field) evaluators, not only actions/providers/evaluators. */
import { expect, it } from "vitest";
import { SEND_HANDLER_NOT_FOUND } from "../src/types/messaging";
import type { Plugin } from "../src/types/plugin";
import type { IAgentRuntime } from "../src/types/runtime";
import { Service } from "../src/types/service";

/** The chat pre-handler registry is internal to the concrete runtime; the test
 * reads it directly to assert the real post-unload state, not just bookkeeping. */
type RuntimeWithPreHandlerRegistry = {
	chatPreHandlerRegistry: { list(): { id: string }[] };
};

function buildPlugin(): Plugin {
	return {
		name: "handler-teardown-fixture",
		description: "Registers one of each hot-teardown-eligible handler type",
		chatPreHandlers: [
			{
				id: "fixture-pre-handler",
				tryHandle: async () => null,
			},
		],
		responseHandlerEvaluators: [
			{
				name: "FIXTURE_RH_EVALUATOR",
				shouldRun: () => false,
				evaluate: () => undefined,
			},
		],
		responseHandlerFieldEvaluators: [
			{
				name: "fixtureField",
				description: "Fixture field evaluator for teardown coverage.",
				schema: { type: "string" },
			},
		],
	};
}

function preHandlerIds(runtime: unknown): string[] {
	return (runtime as RuntimeWithPreHandlerRegistry).chatPreHandlerRegistry
		.list()
		.map((handler) => handler.id);
}

it("unloadPlugin removes chat pre-handlers and response-handler evaluators", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown", bio: [] },
		logLevel: "fatal",
	});

	await runtime.registerPlugin(buildPlugin());

	expect(preHandlerIds(runtime)).toContain("fixture-pre-handler");
	expect(
		runtime.responseHandlerEvaluators.some(
			(evaluator) => evaluator.name === "FIXTURE_RH_EVALUATOR",
		),
	).toBe(true);
	expect(
		runtime.responseHandlerFieldEvaluators.some(
			(evaluator) => evaluator.name === "fixtureField",
		),
	).toBe(true);

	const ownership = await runtime.unloadPlugin("handler-teardown-fixture");
	expect(ownership).not.toBeNull();

	// The bug: these three handler kinds were never captured as owned, so they
	// survived unload. After the fix the registry and both arrays are clean.
	expect(preHandlerIds(runtime)).not.toContain("fixture-pre-handler");
	expect(
		runtime.responseHandlerEvaluators.some(
			(evaluator) => evaluator.name === "FIXTURE_RH_EVALUATOR",
		),
	).toBe(false);
	expect(
		runtime.responseHandlerFieldEvaluators.some(
			(evaluator) => evaluator.name === "fixtureField",
		),
	).toBe(false);
});

it("re-registering after unload installs fresh handler instances", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown reload", bio: [] },
		logLevel: "fatal",
	});

	await runtime.registerPlugin(buildPlugin());
	await runtime.unloadPlugin("handler-teardown-fixture");
	// A leaked registration would make this a silent duplicate-skip that keeps
	// the stale instances live; a clean teardown lets the fresh ones register.
	const fresh = buildPlugin();
	await runtime.registerPlugin(fresh);

	expect(livePreHandler(runtime, "fixture-pre-handler")).toBe(
		fresh.chatPreHandlers?.[0],
	);
	const liveEvaluators = runtime.responseHandlerEvaluators.filter(
		(evaluator) => evaluator.name === "FIXTURE_RH_EVALUATOR",
	);
	expect(liveEvaluators).toHaveLength(1);
	expect(liveEvaluators[0]).toBe(fresh.responseHandlerEvaluators?.[0]);
	const liveFieldEvaluators = runtime.responseHandlerFieldEvaluators.filter(
		(evaluator) => evaluator.name === "fixtureField",
	);
	expect(liveFieldEvaluators).toHaveLength(1);
	expect(liveFieldEvaluators[0]).toBe(
		fresh.responseHandlerFieldEvaluators?.[0],
	);
});

type PreHandler = NonNullable<Plugin["chatPreHandlers"]>[number];

function preHandlerPlugin(name: string, handler: PreHandler): Plugin {
	return {
		name,
		description: "Same-id chat pre-handler fixture",
		chatPreHandlers: [handler],
	};
}

function livePreHandler(runtime: unknown, id: string) {
	return (runtime as RuntimeWithPreHandlerRegistry).chatPreHandlerRegistry
		.list()
		.find((handler) => handler.id === id);
}

it("a second plugin's same-id chat pre-handler never displaces or outlives the first", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown same id", bio: [] },
		logLevel: "fatal",
	});
	const first: PreHandler = {
		id: "shared-pre-handler",
		tryHandle: async () => null,
	};
	const second: PreHandler = {
		id: "shared-pre-handler",
		tryHandle: async () => null,
	};

	await runtime.registerPlugin(preHandlerPlugin("pre-handler-first", first));
	await runtime.registerPlugin(preHandlerPlugin("pre-handler-second", second));
	// Teardown cannot restore a displaced incumbent, so a plugin-boundary
	// same-id registration is first-wins, like actions/providers/evaluators.
	expect(livePreHandler(runtime, "shared-pre-handler")).toBe(first);

	await runtime.unloadPlugin("pre-handler-second");
	expect(livePreHandler(runtime, "shared-pre-handler")).toBe(first);

	await runtime.unloadPlugin("pre-handler-first");
	expect(livePreHandler(runtime, "shared-pre-handler")).toBeUndefined();
});

it("unloading a plugin whose same-name response-handler evaluators were skipped keeps the incumbent's", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown same name", bio: [] },
		logLevel: "fatal",
	});
	const incumbent = buildPlugin();
	await runtime.registerPlugin(incumbent);
	// Response-handler (field) evaluator registration skips a duplicate name,
	// so the second plugin never owns the incumbent's evaluators.
	await runtime.registerPlugin({
		...buildPlugin(),
		name: "handler-teardown-duplicate",
	});
	await runtime.unloadPlugin("handler-teardown-duplicate");

	expect(runtime.responseHandlerEvaluators).toContain(
		incumbent.responseHandlerEvaluators?.[0],
	);
	expect(runtime.responseHandlerFieldEvaluators).toContain(
		incumbent.responseHandlerFieldEvaluators?.[0],
	);
});

/** Registers connectors from its started service, through the same
 * registerSendHandlers hook plugin-telegram, plugin-discord and plugin-slack use. */
class ConnectorFixtureService extends Service {
	static serviceType = "connector_teardown_fixture";
	capabilityDescription = "Connector teardown fixture";
	static async start(runtime: IAgentRuntime): Promise<Service> {
		return new ConnectorFixtureService(runtime);
	}
	async stop(): Promise<void> {}
	static registerSendHandlers(runtime: IAgentRuntime): void {
		const sendHandler = async () => undefined;
		runtime.registerMessageConnector({ source: "fixture-chat", sendHandler });
		runtime.registerMessageConnector({
			source: "fixture-chat",
			accountId: "second",
			sendHandler,
		});
		runtime.registerPostConnector({ source: "fixture-feed" });
		runtime.registerSendHandler("fixture-legacy", sendHandler);
	}
}

function connectorSources(runtime: IAgentRuntime) {
	return {
		message: runtime
			.getMessageConnectors()
			.map(({ source, accountId }) => `${source}:${accountId ?? ""}`),
		post: runtime.getPostConnectors().map(({ source }) => source),
	};
}

it("unloadPlugin removes the message and post connectors its service registered", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown connectors", bio: [] },
		logLevel: "fatal",
	});

	await runtime.registerPlugin({
		name: "connector-teardown-fixture",
		description: "Registers message and post connectors from a service",
		services: [ConnectorFixtureService],
	});
	await runtime.getServiceLoadPromise("connector_teardown_fixture");
	expect(connectorSources(runtime)).toEqual({
		message: ["fixture-chat:", "fixture-chat:second", "fixture-legacy:"],
		post: ["fixture-feed"],
	});

	await runtime.unloadPlugin("connector-teardown-fixture");

	// A connector that outlives its plugin still looks available to MESSAGE,
	// POST and scheduled dispatch, and routes sends to the stopped service.
	expect(connectorSources(runtime)).toEqual({ message: [], post: [] });
	for (const target of [
		{ source: "fixture-chat" },
		{ source: "fixture-chat", accountId: "second" },
		{ source: "fixture-legacy" },
	]) {
		await expect(
			runtime.sendMessageToTarget(target, { text: "after unload" }),
		).rejects.toMatchObject({ code: SEND_HANDLER_NOT_FOUND });
	}
});

/** Registers the same connector keys as another fixture plugin; each send
 * records which plugin's handler the registry routed it to. */
function sharedConnectorPlugin(name: string, delivered: string[]): Plugin {
	class SharedConnectorService extends Service {
		static serviceType = `${name}_service`;
		capabilityDescription = "Shared connector key fixture";
		static async start(runtime: IAgentRuntime): Promise<Service> {
			return new SharedConnectorService(runtime);
		}
		async stop(): Promise<void> {}
		static registerSendHandlers(runtime: IAgentRuntime): void {
			runtime.registerMessageConnector({
				source: "shared-chat",
				accountId: "T1",
				sendHandler: async () => {
					delivered.push(name);
				},
			});
			runtime.registerPostConnector({ source: "shared-feed" });
		}
	}
	return {
		name,
		description: "Registers connector keys another plugin also registers",
		services: [SharedConnectorService],
	};
}

it("unloading a plugin keeps a connector another plugin registered later under the same key", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown shared connector", bio: [] },
		logLevel: "fatal",
	});
	const delivered: string[] = [];
	const target = { source: "shared-chat", accountId: "T1" };

	await runtime.registerPlugin(
		sharedConnectorPlugin("connector-earlier", delivered),
	);
	await runtime.getServiceLoadPromise("connector-earlier_service");
	await runtime.registerPlugin(
		sharedConnectorPlugin("connector-later", delivered),
	);
	await runtime.getServiceLoadPromise("connector-later_service");
	// The registry keeps the later registration for a (source, accountId) key.
	await runtime.sendMessageToTarget(target, { text: "both loaded" });
	expect(delivered).toEqual(["connector-later"]);

	await runtime.unloadPlugin("connector-earlier");

	// The earlier plugin's entry was already replaced, so its unload must not
	// remove the live connector of the plugin that is still loaded.
	expect(connectorSources(runtime)).toEqual({
		message: ["shared-chat:T1"],
		post: ["shared-feed"],
	});
	await runtime.sendMessageToTarget(target, { text: "earlier unloaded" });
	expect(delivered).toEqual(["connector-later", "connector-later"]);

	await runtime.unloadPlugin("connector-later");

	expect(connectorSources(runtime)).toEqual({ message: [], post: [] });
	await expect(
		runtime.sendMessageToTarget(target, { text: "both unloaded" }),
	).rejects.toMatchObject({ code: SEND_HANDLER_NOT_FOUND });
});

/** Registers the default account, or a named one, on connector sources
 * another fixture plugin also uses; each send records the plugin it reached. */
function accountConnectorPlugin(
	name: string,
	accountId: string | undefined,
	delivered: string[],
): Plugin {
	class AccountConnectorService extends Service {
		static serviceType = `${name}_service`;
		capabilityDescription = "Connector account fixture";
		static async start(runtime: IAgentRuntime): Promise<Service> {
			return new AccountConnectorService(runtime);
		}
		async stop(): Promise<void> {}
		static registerSendHandlers(runtime: IAgentRuntime): void {
			const sendHandler = async () => {
				delivered.push(name);
			};
			runtime.registerMessageConnector({
				source: "account-chat",
				accountId,
				sendHandler,
			});
			runtime.registerPostConnector({ source: "account-feed", accountId });
			if (accountId) {
				runtime.registerMessageConnector({
					source: "account-legacy",
					accountId,
					sendHandler,
				});
			} else {
				runtime.registerSendHandler("account-legacy", sendHandler);
			}
		}
	}
	return {
		name,
		description: "Registers one account on shared connector sources",
		services: [AccountConnectorService],
	};
}

it("unloading a plugin's default account keeps another plugin's named account on the same source", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown connector accounts", bio: [] },
		logLevel: "fatal",
	});
	const delivered: string[] = [];

	await runtime.registerPlugin(
		accountConnectorPlugin("connector-default", undefined, delivered),
	);
	await runtime.getServiceLoadPromise("connector-default_service");
	await runtime.registerPlugin(
		accountConnectorPlugin("connector-work", "work", delivered),
	);
	await runtime.getServiceLoadPromise("connector-work_service");

	await runtime.unloadPlugin("connector-default");

	// Unregistering a source without an account removes every account of it,
	// so the default account's unload must remove only its own entries.
	expect(connectorSources(runtime).message).toEqual([
		"account-chat:work",
		"account-legacy:work",
	]);
	expect(
		runtime
			.getPostConnectors()
			.map(({ source, accountId }) => `${source}:${accountId ?? ""}`),
	).toEqual(["account-feed:work"]);
	for (const source of ["account-chat", "account-legacy"]) {
		await runtime.sendMessageToTarget(
			{ source, accountId: "work" },
			{ text: "default unloaded" },
		);
		await expect(
			runtime.sendMessageToTarget({ source }, { text: "default unloaded" }),
		).rejects.toMatchObject({ code: SEND_HANDLER_NOT_FOUND });
	}
	expect(delivered).toEqual(["connector-work", "connector-work"]);
});

type DefaultRouteApi = "connector" | "legacy";

/** Registers the default account of a source through either API; both write
 * the same route key. Each send records the plugin it reached. */
function registerDefaultRoute(
	runtime: IAgentRuntime,
	api: DefaultRouteApi,
	source: string,
	sendHandler: () => Promise<void>,
): void {
	if (api === "connector") {
		runtime.registerMessageConnector({ source, sendHandler });
	} else {
		runtime.registerSendHandler(source, sendHandler);
	}
}

function defaultRoutePlugin(
	name: string,
	routes: Record<string, DefaultRouteApi>,
	delivered: string[],
): Plugin {
	class DefaultRouteService extends Service {
		static serviceType = `${name}_service`;
		capabilityDescription = "Default route fixture";
		static async start(runtime: IAgentRuntime): Promise<Service> {
			return new DefaultRouteService(runtime);
		}
		async stop(): Promise<void> {}
		static registerSendHandlers(runtime: IAgentRuntime): void {
			for (const [source, api] of Object.entries(routes)) {
				registerDefaultRoute(runtime, api, source, async () => {
					delivered.push(name);
				});
			}
		}
	}
	return {
		name,
		description: "Registers default connector routes",
		services: [DefaultRouteService],
	};
}

for (const [earlierApi, laterApi] of [
	["connector", "legacy"],
	["legacy", "connector"],
] as const) {
	it(`unloading a plugin's ${earlierApi} keeps the default route another plugin's later ${laterApi} registration took over`, async () => {
		const { createInitializedRuntime } = await import("./initialized-runtime");
		const runtime = await createInitializedRuntime({
			character: { name: "Teardown mixed connector APIs", bio: [] },
			logLevel: "fatal",
		});
		const delivered: string[] = [];

		await runtime.registerPlugin(
			defaultRoutePlugin(
				"route-earlier",
				{ "mixed-chat": earlierApi },
				delivered,
			),
		);
		await runtime.getServiceLoadPromise("route-earlier_service");
		await runtime.registerPlugin(
			defaultRoutePlugin("route-later", { "mixed-chat": laterApi }, delivered),
		);
		await runtime.getServiceLoadPromise("route-later_service");

		await runtime.unloadPlugin("route-earlier");

		// Both APIs write the source's default route key, so the later
		// registration owns it whichever API made it.
		expect(connectorSources(runtime).message).toEqual(["mixed-chat:"]);
		await runtime.sendMessageToTarget(
			{ source: "mixed-chat" },
			{ text: "earlier unloaded" },
		);
		expect(delivered).toEqual(["route-later"]);

		await runtime.unloadPlugin("route-later");

		expect(connectorSources(runtime).message).toEqual([]);
		await expect(
			runtime.sendMessageToTarget(
				{ source: "mixed-chat" },
				{ text: "both unloaded" },
			),
		).rejects.toMatchObject({ code: SEND_HANDLER_NOT_FOUND });
	});
}

it("unloading a plugin keeps a default route the host registered over it", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown host connector", bio: [] },
		logLevel: "fatal",
	});
	const delivered: string[] = [];
	const routes = {
		"host-chat": "connector",
		"host-legacy": "legacy",
	} as const;

	await runtime.registerPlugin(
		defaultRoutePlugin("route-plugin", routes, delivered),
	);
	await runtime.getServiceLoadPromise("route-plugin_service");
	// Outside plugin context, with the other API than the plugin used.
	registerDefaultRoute(runtime, "legacy", "host-chat", async () => {
		delivered.push("host");
	});
	registerDefaultRoute(runtime, "connector", "host-legacy", async () => {
		delivered.push("host");
	});

	await runtime.unloadPlugin("route-plugin");

	expect(connectorSources(runtime).message).toEqual([
		"host-chat:",
		"host-legacy:",
	]);
	for (const source of Object.keys(routes)) {
		await runtime.sendMessageToTarget({ source }, { text: "plugin unloaded" });
	}
	expect(delivered).toEqual(["host", "host"]);
});
