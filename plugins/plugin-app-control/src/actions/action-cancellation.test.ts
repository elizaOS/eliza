import type {
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelSwitchAction } from "./model-switch.js";
import { createSettingsAction, type SettingsRouteFetch } from "./settings.js";
import { createViewsAction, createViewsAliasAction } from "./views.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";

const runtime = {
	agentId: "agent-1",
	actions: [],
} as unknown as IAgentRuntime;

function message(text: string): Memory {
	return {
		roomId: "room-1",
		agentId: "agent-1",
		entityId: "user-1",
		content: { text },
	} as Memory;
}

function callbackSpy(): HandlerCallback {
	return vi.fn(async () => []);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function notesView(): ViewSummary {
	return {
		id: "notes",
		label: "Notes",
		path: "/notes",
		pluginName: "@elizaos/plugin-notes",
		available: true,
		viewType: "gui",
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("app-control turn cancellation boundaries", () => {
	it("MODEL_SWITCH performs no effect when the turn aborted before admission", async () => {
		const switchModel = vi.fn(async () => ({ ok: true as const }));
		const action = createModelSwitchAction({ switchModel });
		const controller = new AbortController();
		const reason = new DOMException("turn replaced", "AbortError");
		controller.abort(reason);

		await expect(
			action.handler(
				runtime,
				message("use eliza cloud"),
				undefined,
				{
					parameters: { target: "cloud" },
					abortSignal: controller.signal,
				},
				callbackSpy(),
			),
		).rejects.toBe(reason);
		expect(switchModel).not.toHaveBeenCalled();
	});

	it("MODEL_SWITCH settles an admitted request after the turn aborts", async () => {
		const started = deferred<void>();
		const outcome = deferred<{
			ok: true;
			target: "cloud";
			model: string;
			status: "ready";
		}>();
		const switchModel = vi.fn(async () => {
			started.resolve();
			return outcome.promise;
		});
		const action = createModelSwitchAction({ switchModel });
		const controller = new AbortController();
		const callback = callbackSpy();
		const pending = action.handler(
			runtime,
			message("use eliza cloud"),
			undefined,
			{
				parameters: { target: "cloud" },
				abortSignal: controller.signal,
			},
			callback,
		);

		await started.promise;
		controller.abort(new DOMException("barge in", "AbortError"));
		outcome.resolve({
			ok: true,
			target: "cloud",
			model: "glm-4.7",
			status: "ready",
		});

		await expect(pending).resolves.toMatchObject({
			success: true,
			values: { target: "cloud", model: "glm-4.7", status: "ready" },
		});
		expect(callback).toHaveBeenCalledOnce();
	});

	it("SETTINGS aborts after read preflight without admitting its first write", async () => {
		const controller = new AbortController();
		const reason = new DOMException("turn replaced", "AbortError");
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			expect(request.method).toBe("GET");
			controller.abort(reason);
			return { ok: true, data: { messages: {} } };
		});
		const action = createSettingsAction({ routeFetch });

		await expect(
			action.handler(
				runtime,
				message("turn continuous voice on"),
				undefined,
				{
					parameters: {
						action: "set",
						section: "voice",
						key: "continuous-chat",
						value: "always-on",
					},
					abortSignal: controller.signal,
				},
				callbackSpy(),
			),
		).rejects.toBe(reason);
		expect(routeFetch).toHaveBeenCalledOnce();
		expect(routeFetch.mock.calls[0]?.[0].method).toBe("GET");
	});

	it("SETTINGS completes every settlement step after its first write is admitted", async () => {
		const controller = new AbortController();
		const putStarted = deferred<void>();
		const putOutcome = deferred<{ ok: true }>();
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return { ok: true, data: { messages: {} } };
			}
			if (request.method === "PUT") {
				putStarted.resolve();
				return putOutcome.promise;
			}
			return { ok: true };
		});
		const action = createSettingsAction({ routeFetch });
		const callback = callbackSpy();
		const pending = action.handler(
			runtime,
			message("turn continuous voice on"),
			undefined,
			{
				parameters: {
					action: "set",
					section: "voice",
					key: "continuous-chat",
					value: "always-on",
				},
				abortSignal: controller.signal,
			},
			callback,
		);

		await putStarted.promise;
		controller.abort(new DOMException("barge in", "AbortError"));
		putOutcome.resolve({ ok: true });

		await expect(pending).resolves.toMatchObject({
			success: true,
			values: { section: "voice", key: "continuous-chat" },
		});
		expect(routeFetch.mock.calls.map(([request]) => request.method)).toEqual([
			"GET",
			"PUT",
			"POST",
		]);
		expect(callback).toHaveBeenCalledOnce();
	});

	it("VIEWS checks cancellation after async resolution and before navigation", async () => {
		const controller = new AbortController();
		const reason = new DOMException("turn replaced", "AbortError");
		const client: ViewsClient = {
			listViews: vi.fn(async () => {
				controller.abort(reason);
				return [notesView()];
			}),
			getCurrentView: vi.fn(async () => null),
			navigate: vi.fn(async () => true),
		};
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const action = createViewsAction({ client });

		await expect(
			action.handler(
				runtime,
				message("open notes"),
				undefined,
				{
					parameters: { action: "show", view: "notes" },
					abortSignal: controller.signal,
				},
				callbackSpy(),
			),
		).rejects.toBe(reason);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("VIEWS settles an admitted navigation after the turn aborts", async () => {
		const controller = new AbortController();
		const navigationStarted = deferred<void>();
		const navigationResponse = deferred<Response>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				navigationStarted.resolve();
				return navigationResponse.promise;
			}),
		);
		const client: ViewsClient = {
			listViews: vi.fn(async () => [notesView()]),
			getCurrentView: vi.fn(async () => null),
			navigate: vi.fn(async () => true),
		};
		const action = createViewsAction({ client });
		const callback = callbackSpy();
		const pending = action.handler(
			runtime,
			message("open notes"),
			undefined,
			{
				parameters: { action: "show", view: "notes" },
				abortSignal: controller.signal,
			},
			callback,
		);

		await navigationStarted.promise;
		controller.abort(new DOMException("barge in", "AbortError"));
		navigationResponse.resolve(new Response(null, { status: 200 }));

		await expect(pending).resolves.toMatchObject({
			success: true,
			values: { mode: "show", viewId: "notes" },
		});
		expect(callback).toHaveBeenCalledOnce();
	});

	it("CLOSE_VIEW preserves the outer abort signal while rewriting parameters", async () => {
		const controller = new AbortController();
		const reason = new DOMException("turn replaced", "AbortError");
		controller.abort(reason);
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === "GET") {
				return new Response(JSON.stringify({ views: [notesView()] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const action = createViewsAliasAction("CLOSE_VIEW");

		await expect(
			action.handler(
				runtime,
				message("close notes"),
				undefined,
				{
					parameters: { view: "notes" },
					abortSignal: controller.signal,
				} satisfies HandlerOptions,
				callbackSpy(),
			),
		).rejects.toBe(reason);
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
		).toHaveLength(0);
	});
});
