/**
 * Planner-owned view switching through the real VIEWS action handler.
 * Uses a fake view registry and captured navigation transport to verify that
 * structured targets, not user-utterance inference, determine the destination.
 * Compatibility-only intent helper coverage remains separate below.
 */

import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURATED_MULTILINGUAL } from "./view-matrix.fixtures.js";
import { createViewsAction } from "./views.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { resolveIntentView } from "./views-show.js";

const coreMock = vi.hoisted(() => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	resolveServerOnlyPort: vi.fn(() => 3456),
	hasOwnerAccess: vi.fn(async () => true),
	// @elizaos/shared re-exports formatError (as errorMessage) from @elizaos/core,
	// and app-control imports @elizaos/shared at module load — the mock must carry it.
	formatError: (error: unknown): string =>
		error instanceof Error ? error.message : String(error),
}));

// views-show.ts (loaded via ./views.js and the direct resolveIntentView import)
// pulls getUserMessageText from @elizaos/core, so the mock must carry the real
// implementation — keep the rest of core mocked. Mirrors views-management.test.ts.
vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...coreMock,
		getStreamingContext: actual.getStreamingContext,
		getTurnActionConstraint: actual.getTurnActionConstraint,
		setTurnActionConstraint: actual.setTurnActionConstraint,
		getUserMessageText: actual.getUserMessageText,
		unwrapUserMessageText: actual.unwrapUserMessageText,
		containsExternalEnvelopeMaterial: actual.containsExternalEnvelopeMaterial,
		completeUserReferenceView: actual.completeUserReferenceView,
	};
});

function message(text: string, roomId = "room-1", clientTransport?: string) {
	return {
		entityId: "user-1",
		roomId,
		agentId: "agent-1",
		content: {
			text,
			...(clientTransport ? { metadata: { clientTransport } } : {}),
		},
	};
}

/**
 * Full user-facing view registry, mirroring real plugin ViewDeclarations:
 * the 9 BUILTIN_VIEWS (packages/agent/src/api/builtin-views.ts) plus the
 * first-party plugin views referenced by the product spec (inbox/email,
 * wallet, calendar) and a coding/app-builder surface.
 */
const REGISTRY: ViewSummary[] = [
	{
		id: "chat",
		label: "Chat",
		description:
			"Conversations with your agent, inbound messages from every connector",
		path: "/chat",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["messaging", "conversation", "agent"],
		visibleInManager: true,
	},
	{
		id: "character",
		label: "Character",
		description: "Agent identity, personality, style, and knowledge documents",
		path: "/character",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["identity", "personality", "character"],
		visibleInManager: true,
	},
	{
		id: "automations",
		label: "Automations",
		description: "Scheduled tasks and recurring workflows",
		path: "/automations",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["automation", "tasks", "scheduling"],
		visibleInManager: true,
	},
	{
		id: "plugins-page",
		label: "Plugins",
		description: "Manage installed plugins, configure credentials",
		path: "/apps/plugins",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: [
			"plugins",
			"plugin-browser",
			"plugin browser",
			"plugin-manager",
			"plugin manager",
			"configuration",
			"extensions",
		],
		visibleInManager: true,
	},
	{
		id: "trajectories",
		label: "Trajectories",
		description: "Agent trajectory logs and training data",
		path: "/apps/trajectories",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["training", "logs", "trajectories"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "memories",
		label: "Memories",
		description: "Agent memory viewer and management",
		path: "/apps/memories",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["memory", "knowledge"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "database",
		label: "Database",
		description: "Raw database viewer and query interface",
		path: "/apps/database",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["database", "data", "debug"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "logs",
		label: "Logs",
		description: "Runtime logs and agent debug output",
		path: "/apps/logs",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["logs", "debug", "runtime"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "settings",
		label: "Settings",
		description: "Configuration, plugins, credentials, and preferences",
		path: "/settings",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["configuration", "preferences", "plugins"],
		visibleInManager: true,
	},
	// First-party plugin views referenced by the product spec.
	{
		id: "inbox",
		label: "Inbox",
		description: "Cross-channel inbox triage",
		path: "/inbox",
		pluginName: "@elizaos/plugin-inbox",
		available: true,
		viewType: "gui",
		tags: ["inbox", "triage", "communication"],
		visibleInManager: true,
	},
	{
		id: "wallet",
		label: "Wallet",
		description: "Non-custodial wallet inventory and token balances",
		path: "/wallet",
		pluginName: "@elizaos/plugin-wallet:ui",
		available: true,
		viewType: "gui",
		tags: ["finance", "crypto", "wallet"],
		visibleInManager: true,
	},
	{
		id: "calendar",
		label: "Calendar",
		description:
			"Unified Google + Apple calendar with day/week/month tabs and inline conflict detection.",
		path: "/calendar",
		pluginName: "@elizaos/plugin-calendar",
		available: true,
		viewType: "gui",
		tags: ["calendar", "schedule", "events"],
		visibleInManager: true,
	},
];

const SIMPLE_CALENDAR_VIEW: ViewSummary = {
	id: "simple-calendar",
	label: "Calendar",
	description:
		"A durable Cloud calendar for agent-driven events and view switching.",
	path: "/simple-calendar",
	pluginName: "@elizaos/plugin-simple-views",
	available: true,
	viewType: "gui",
	tags: [
		"calendar",
		"calender",
		"simple calendar",
		"events",
		"schedule",
		"view switching",
	],
	visibleInManager: true,
};

const REGISTRY_WITH_SIMPLE_CALENDAR: ViewSummary[] = [
	...REGISTRY,
	SIMPLE_CALENDAR_VIEW,
];

function clientFor(views: ViewSummary[]): ViewsClient {
	return {
		listViews: vi.fn(async () => views),
		getCurrentView: vi.fn(async () => null),
	};
}

/** Capture every navigate POST the show handler dispatches. */
function installNavigateCapture(): { navigated: string[] } {
	const navigated: string[] = [];
	vi.mocked(globalThis.fetch).mockImplementation(async (url: unknown) => {
		const requestUrl = String(url);
		const match = /\/api\/views\/([^/?]+)\/navigate/.exec(requestUrl);
		if (match) navigated.push(decodeURIComponent(match[1]));
		return {
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ ok: true }),
		} as Response;
	});
	return { navigated };
}

async function runShow(
	views: ViewSummary[],
	text: string,
	options?: Record<string, unknown>,
) {
	const action = createViewsAction({
		client: clientFor(views),
		hasOwnerAccess: vi.fn(async () => true),
	});
	const callback = vi.fn();
	const result = await action.handler(
		{ agentId: "agent-1" } as never,
		message(text) as never,
		undefined,
		{ action: "show", ...options },
		callback,
	);
	return { result, callback };
}

describe("view switching — VIEWS action resolver", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("does not reinterpret an explicit read capability as a top placement", async () => {
		const requests: string[] = [];
		vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
			requests.push(String(input));
			return new Response(
				JSON.stringify({
					success: true,
					result: "General\nDisplay\nHome\nBackground",
				}),
				{ status: 200 },
			);
		});
		const action = createViewsAction({
			client: clientFor(REGISTRY),
			hasOwnerAccess: vi.fn(async () => true),
		});
		const callback = vi.fn();
		const result = await action.handler(
			{ agentId: "agent-1" } as never,
			message(
				"Read the title displayed at the top of this settings screen.",
			) as never,
			undefined,
			{ action: "interact", view: "settings", capability: "get-text" },
			callback,
		);
		expect(result?.success).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("/api/views/settings/interact");
		expect(result?.data).toMatchObject({
			viewId: "settings",
			capability: "get-text",
		});
		expect(callback).not.toHaveBeenCalled();
	});

	it("keeps inventory and navigation receipts internal through the public wrapper", async () => {
		const action = createViewsAction({
			client: clientFor(REGISTRY),
			hasOwnerAccess: vi.fn(async () => true),
		});
		const inventory = await action.handler(
			{ agentId: "agent-1" } as never,
			message("what views are available?") as never,
			undefined,
			{ action: "list" },
			vi.fn(),
		);

		expect(inventory).toMatchObject({
			success: true,
			text: expect.stringMatching(/^available_views:/),
			transcriptVisibility: "internal",
		});
		expect(inventory?.userFacingText).toBeUndefined();
		expect(inventory?.verifiedUserFacing).toBeUndefined();

		const { navigated } = installNavigateCapture();
		const navigation = await action.handler(
			{ agentId: "agent-1" } as never,
			message("open calendar") as never,
			undefined,
			{ action: "show", view: "calendar" },
			vi.fn(),
		);

		expect(navigated).toEqual(["calendar"]);
		expect(navigation?.transcriptVisibility).toBe("internal");
		expect(navigation?.userFacingText).toBeUndefined();
		expect(navigation?.verifiedUserFacing).toBeUndefined();
		expect(navigation?.modelReplyRequired).toBe(true);
		expect(navigation?.turnComplete).toBe(false);
	});

	describe("structured navigation — registered targets reach the requested view", () => {
		it("keeps a planner-selected show operation when the user says right now", async () => {
			const { navigated } = installNavigateCapture();
			const { result, callback } = await runShow(
				REGISTRY,
				"Which view is open right now? Then open Calendar and check for events on September 9, 2026 in America/New_York. Do not create, edit, or delete anything.",
				{ view: "calendar" },
			);
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["calendar"]);
			expect(result?.data).not.toHaveProperty("action", "split-view");
			expect(result?.continueChain).not.toBe(false);
			expect(result?.modelReplyRequired).toBe(true);
			expect(callback).not.toHaveBeenCalled();
		});

		// The planner supplies the view id; the accompanying utterance is context.
		const ACTIVE_CASES: ReadonlyArray<readonly [string, string]> = [
			["open the chat view", "chat"],
			["go to chat", "chat"],
			["open the character view", "character"],
			["show me the character page", "character"],
			["go to automations", "automations"],
			["open the plugins page", "plugins-page"],
			["open the plugin browser", "plugins-page"],
			["show settings", "settings"],
			["open settings", "settings"],
			["go to the settings view", "settings"],
			["show my wallet", "wallet"],
			["open the wallet view", "wallet"],
			["go to my wallet", "wallet"],
			["open the calendar", "calendar"],
			["go to calendar", "calendar"],
			["show the inbox", "inbox"],
			["open my inbox", "inbox"],
			["open the trajectories view", "trajectories"],
			["show me the memories view", "memories"],
			["open the database view", "database"],
			["show the logs view", "logs"],
		];

		it.each(ACTIVE_CASES)(
			'"%s" with planner target "%s" navigates to that view',
			async (phrase, expectedId) => {
				const { navigated } = installNavigateCapture();
				const { result } = await runShow(REGISTRY, phrase, {
					view: expectedId,
				});
				expect(result?.success).toBe(true);
				expect(result?.values?.viewId).toBe(expectedId);
				expect(navigated).toEqual([expectedId]);
			},
		);

		it("dispatches navigate to the exact /api/views/<id>/navigate endpoint", async () => {
			installNavigateCapture();
			await runShow(REGISTRY, "open the wallet view", { view: "wallet" });
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/views/wallet/navigate",
				expect.objectContaining({ method: "POST" }),
			);
		});

		it("routes realtime voice navigation back through the originating client", async () => {
			installNavigateCapture();
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});

			await action.handler(
				{ agentId: "agent-1" } as never,
				message(
					"open calendar",
					"room-1",
					REALTIME_VOICE_CLIENT_TRANSPORT,
				) as never,
				undefined,
				{ action: "show", view: "calendar" },
				vi.fn(),
			);

			const lastCall = vi.mocked(globalThis.fetch).mock.calls.at(-1);
			expect(lastCall).toBeDefined();
			if (!lastCall) {
				throw new Error("expected the view navigation request");
			}
			const [, init] = lastCall;
			expect(JSON.parse(String(init?.body))).toMatchObject({
				delivery: "originating-client",
			});
		});

		it("targets app-chat navigation to the client that sent the turn", async () => {
			installNavigateCapture();
			vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
				const requestBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;
				return {
					ok: true,
					status: 200,
					text: async () => "",
					json: async () => ({
						ok: true,
						completedActionDelivered: true,
						completedActionHandoffId: requestBody.completedActionHandoffId,
					}),
				} as Response;
			});
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});

			const result = await action.handler(
				{ agentId: "agent-1" } as never,
				{
					...message("open calendar"),
					content: {
						text: "open calendar",
						metadata: { viewClientId: "seeker-client" },
					},
				} as never,
				undefined,
				{ action: "show", view: "calendar" },
				vi.fn(),
			);

			const lastCall = vi.mocked(globalThis.fetch).mock.calls.at(-1);
			expect(lastCall).toBeDefined();
			if (!lastCall) throw new Error("expected the view navigation request");
			const [, init] = lastCall;
			const requestBody = JSON.parse(String(init?.body)) as Record<
				string,
				unknown
			>;
			expect(requestBody).toMatchObject({
				clientId: "seeker-client",
				delivery: "completed-action",
			});
			expect(requestBody.completedActionHandoffId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f-]{27}$/,
			);
			expect(result?.values).toMatchObject({
				completedActionDelivered: true,
				completedActionHandoffId: requestBody.completedActionHandoffId,
			});
		});

		it("keeps terminal fallback enabled when an older server does not echo the handoff id", async () => {
			installNavigateCapture();
			vi.mocked(globalThis.fetch).mockImplementation(async () => {
				return {
					ok: true,
					status: 200,
					text: async () => "",
					json: async () => ({
						ok: true,
						completedActionDelivered: true,
					}),
				} as Response;
			});
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});

			const result = await action.handler(
				{ agentId: "agent-1" } as never,
				{
					...message("open calendar"),
					content: {
						text: "open calendar",
						metadata: { viewClientId: "older-server-client" },
					},
				} as never,
				undefined,
				{ action: "show", view: "calendar" },
				vi.fn(),
			);

			expect(result?.values).not.toHaveProperty("completedActionDelivered");
			expect(result?.values).not.toHaveProperty("completedActionHandoffId");
		});

		it("keeps malformed delivery on the planner failure path", async () => {
			installNavigateCapture();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				new Response("{", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});

			const result = await action.handler(
				{ agentId: "agent-1" } as never,
				{
					...message("open calendar"),
					content: {
						text: "open calendar",
						metadata: { viewClientId: "seeker-client" },
					},
				} as never,
				undefined,
				{ action: "show", view: "calendar" },
				vi.fn(),
			);

			expect(result?.success).toBe(false);
			expect(result?.modelReplyRequired).toBeUndefined();
			expect(result?.turnComplete).toBe(false);
			expect(result?.values).not.toHaveProperty("completedActionDelivered");
		});

		it("does not misclassify a receipt body transport failure as malformed JSON", async () => {
			installNavigateCapture();
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => {
					throw new Error("receipt body stream failed");
				},
			} as Response);
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});

			const result = await action.handler(
				{ agentId: "agent-1" } as never,
				message("open calendar") as never,
				undefined,
				{ action: "show", view: "calendar" },
				vi.fn(),
			);

			expect(result?.success).toBe(false);
			expect(JSON.parse(result?.text ?? "{}")).toMatchObject({
				effect: "view_navigation",
				status: "transport-error",
				viewId: "calendar",
			});
		});

		it("does not accept a prototype-polluted delivery receipt", async () => {
			installNavigateCapture();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			const previousDescriptor = Object.getOwnPropertyDescriptor(
				Object.prototype,
				"completedActionDelivered",
			);
			Object.defineProperty(Object.prototype, "completedActionDelivered", {
				configurable: true,
				value: true,
			});

			try {
				const action = createViewsAction({
					client: clientFor(REGISTRY),
					hasOwnerAccess: vi.fn(async () => true),
				});
				const result = await action.handler(
					{ agentId: "agent-1" } as never,
					{
						...message("open calendar"),
						content: {
							text: "open calendar",
							metadata: { viewClientId: "seeker-client" },
						},
					} as never,
					undefined,
					{ action: "show", view: "calendar" },
					vi.fn(),
				);

				expect(result?.success).toBe(true);
				expect(
					Object.hasOwn(result?.values ?? {}, "completedActionDelivered"),
				).toBe(false);
				// The inherited value demonstrates why own-property validation is required
				// again when the UI consumes this transport result.
				expect(result?.values?.completedActionDelivered).toBe(true);
			} finally {
				if (previousDescriptor) {
					Object.defineProperty(
						Object.prototype,
						"completedActionDelivered",
						previousDescriptor,
					);
				} else {
					Reflect.deleteProperty(Object.prototype, "completedActionDelivered");
				}
			}
		});

		it("ignores a delivery marker when completed-action delivery was not requested", async () => {
			installNavigateCapture();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				new Response('{"completedActionDelivered":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

			const { result } = await runShow(REGISTRY, "open calendar", {
				action: "show",
				view: "calendar",
			});

			expect(result?.success).toBe(true);
			expect(result?.values).not.toHaveProperty("completedActionDelivered");
		});

		it("resolves an explicit view option without verb parsing", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "do it", {
				action: "show",
				view: "settings",
			});
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["settings"]);
		});

		it("leaves successful view-switch wording to one post-tool model reply", async () => {
			installNavigateCapture();

			const { result, callback } = await runShow(
				REGISTRY,
				"open the calendar",
				{
					view: "calendar",
				},
			);

			expect(callback).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				success: true,
				transcriptVisibility: "internal",
				modelReplyRequired: true,
				values: {
					mode: "show",
					viewId: "calendar",
					viewPath: "/calendar",
					viewType: "gui",
					label: "Calendar",
				},
			});
			expect(result).not.toHaveProperty("userFacingText");
			expect(result).not.toHaveProperty("verifiedUserFacing");
			expect(result?.turnComplete).toBe(false);
			expect(JSON.parse(result?.text ?? "{}")).toMatchObject({
				effect: "view_navigation",
				status: "accepted",
				viewId: "calendar",
			});
		});

		it.each([404, 501])(
			"does not acknowledge navigation when the shell returns unsupported status %s",
			async (status) => {
				vi.mocked(globalThis.fetch).mockResolvedValue(
					new Response(null, { status }),
				);

				const { result, callback } = await runShow(
					REGISTRY,
					"open the calendar",
					{ view: "calendar" },
				);

				expect(callback).not.toHaveBeenCalled();
				expect(result).toMatchObject({
					success: false,
					transcriptVisibility: "internal",
					turnComplete: false,
				});
				expect(result?.modelReplyRequired).toBe(true);
				expect(JSON.parse(result?.text ?? "{}")).toMatchObject({
					effect: "view_navigation",
					status: "unsupported-route",
					viewId: "calendar",
				});
			},
		);

		it("preserves Home and Messages labels in internal navigation receipts", async () => {
			installNavigateCapture();
			const messagesView = [
				{
					...REGISTRY[0],
					label: "Messages",
				},
			];

			const home = await runShow(messagesView, "go home", { view: "home" });
			expect(home.callback).not.toHaveBeenCalled();
			expect(home.result).toMatchObject({
				success: true,
				values: { viewId: "chat", label: "Home" },
			});
			expect(JSON.parse(home.result?.text ?? "{}")).toMatchObject({
				status: "accepted",
				label: "Home",
			});

			const messages = await runShow(messagesView, "open messages", {
				view: "messages",
			});
			expect(messages.callback).not.toHaveBeenCalled();
			expect(messages.result).toMatchObject({
				success: true,
				values: { viewId: "chat", label: "Messages" },
			});
			expect(JSON.parse(messages.result?.text ?? "{}")).toMatchObject({
				status: "accepted",
				label: "Messages",
			});
		});
	});

	describe("planner-selected Calendar variants", () => {
		it.each([
			{ phrase: "open calendar", kind: "explicit English command" },
			{ phrase: "muéstrame mi calendario", kind: "multilingual command" },
		])(
			"honors the Simple Calendar target beside a $kind when both variants are registered",
			async ({ phrase }) => {
				const { navigated } = installNavigateCapture();
				const { result } = await runShow(
					REGISTRY_WITH_SIMPLE_CALENDAR,
					phrase,
					{
						view: "simple-calendar",
					},
				);

				expect(result).toMatchObject({
					success: true,
					values: {
						viewId: "simple-calendar",
						label: "Calendar",
					},
				});
				expect(JSON.parse(result?.text ?? "{}")).toMatchObject({
					status: "accepted",
					viewId: "simple-calendar",
					label: "Calendar",
				});
				expect(navigated).toEqual(["simple-calendar"]);
			},
		);

		it("opens the selected connected Calendar when Simple Calendar is absent", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "open calendar", {
				view: "calendar",
			});

			expect(result).toMatchObject({
				success: true,
				values: { viewId: "calendar", label: "Calendar" },
			});
			expect(navigated).toEqual(["calendar"]);
		});

		it("opens the selected connected Calendar when Simple Calendar is unavailable", async () => {
			const { navigated } = installNavigateCapture();
			const unavailableRegistry = [
				...REGISTRY,
				{ ...SIMPLE_CALENDAR_VIEW, available: false },
			];
			const { result } = await runShow(
				unavailableRegistry,
				"muéstrame mi calendario",
				{ view: "calendar" },
			);

			expect(result).toMatchObject({
				success: true,
				values: { viewId: "calendar", label: "Calendar" },
			});
			expect(navigated).toEqual(["calendar"]);
		});

		it("keeps the connected Calendar addressable by exact id", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY_WITH_SIMPLE_CALENDAR, "do it", {
				action: "show",
				view: "calendar",
			});

			expect(result).toMatchObject({
				success: true,
				values: { viewId: "calendar", label: "Calendar" },
			});
			expect(navigated).toEqual(["calendar"]);
		});
	});

	describe("PASSIVE intent routing — intent-only phrases (planner supplies view id)", () => {
		// In production the LLM planner selects VIEWS action=show with a view id
		// for intent-only utterances. We assert the resolver honors that id end to
		// end (the navigate actually fires for the inferred view).
		const PASSIVE_PLANNER_CASES: ReadonlyArray<readonly [string, string]> = [
			["what's on my calendar", "calendar"],
			["I want to add a new feature to my app", "plugins-page"],
			["check my unread messages", "inbox"],
			["how much money do I have", "wallet"],
		];

		it.each(PASSIVE_PLANNER_CASES)(
			'planner-routed intent "%s" opens view "%s"',
			async (phrase, viewId) => {
				const { navigated } = installNavigateCapture();
				const { result } = await runShow(REGISTRY, phrase, {
					action: "show",
					view: viewId,
				});
				expect(result?.success).toBe(true);
				expect(result?.values?.viewId).toBe(viewId);
				expect(navigated).toEqual([viewId]);
			},
		);

		it("does not infer a missing planner target from an intent-only phrase", async () => {
			const { navigated } = installNavigateCapture();
			const { result, callback } = await runShow(
				REGISTRY,
				"show me what is on my calendar",
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				turnComplete: false,
			});
			expect(callback).not.toHaveBeenCalled();
			expect(navigated).toEqual([]);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it("does not infer a missing target from a trailing view label", async () => {
			const { navigated } = installNavigateCapture();
			const { result, callback } = await runShow(
				REGISTRY,
				"show me the calendar",
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				turnComplete: false,
			});
			expect(callback).not.toHaveBeenCalled();
			expect(navigated).toEqual([]);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});
	});

	describe("structured destination ownership — utterances cannot override the planner target", () => {
		const CONFLICTING_TEXT_CASES: ReadonlyArray<readonly [string, string]> = [
			["open my calendar", "wallet"],
			["check my messages", "calendar"],
			["show my wallet", "calendar"],
			["muéstrame mi calendario", "wallet"],
			["我的钱包", "calendar"],
		];
		it.each(CONFLICTING_TEXT_CASES)(
			'"%s" does not replace structured target "%s"',
			async (phrase, viewId) => {
				const { navigated } = installNavigateCapture();
				const { result } = await runShow(REGISTRY, phrase, {
					action: "show",
					view: viewId,
				});
				expect(result?.success).toBe(true);
				expect(result?.values?.viewId).toBe(viewId);
				expect(navigated).toEqual([viewId]);
			},
		);

		it("keeps a registered explicit target when the utterance mentions another capability", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(
				REGISTRY,
				"I want to add a new feature to my app",
				{ action: "show", view: "plugins-page" },
			);
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["plugins-page"]);
		});
	});

	describe("ambiguity + miss handling", () => {
		it("does not replace an unknown structured target with a view mentioned in the utterance", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "open calendar", {
				view: "spaceship",
			});
			expect(result?.success).toBe(false);
			expect(result?.text).toContain("No view matches");
			expect(navigated).toEqual([]);
		});

		it("does not fall back to Knowledge/Documents for standalone notes when no notes view is registered", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "open notes", {
				view: "notes",
			});
			expect(result?.success).toBe(false);
			expect(result?.text).toContain('No view matches "notes"');
			expect(navigated).toEqual([]);
		});

		it("opens a registered notes view for standalone notes requests", async () => {
			const withNotes: ViewSummary[] = [
				...REGISTRY,
				{
					id: "notes",
					label: "Notes",
					description: "Simple notes",
					path: "/notes",
					pluginName: "@elizaos/plugin-notes",
					available: true,
					viewType: "gui",
					tags: ["notes"],
					visibleInManager: true,
				},
			];
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(withNotes, "open notes", {
				view: "notes",
			});
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["notes"]);
		});

		it("does not navigate when an explicit target has equal-scoring registered matches", async () => {
			const ambiguousRegistry: ViewSummary[] = [
				{
					id: "notes-a",
					label: "Scratch A",
					description: "Sticky notes",
					pluginName: "a",
					available: true,
					viewType: "gui",
					tags: ["notes"],
				},
				{
					id: "notes-b",
					label: "Scratch B",
					description: "Advanced notes",
					pluginName: "b",
					available: true,
					viewType: "gui",
					tags: ["notes"],
				},
			];
			const { navigated } = installNavigateCapture();
			const { result, callback } = await runShow(
				ambiguousRegistry,
				"open the scratch view",
				{
					view: "Scratch",
				},
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
			});
			expect(result?.data?.candidates).toEqual(ambiguousRegistry);
			expect(callback).not.toHaveBeenCalled();
			expect(navigated).toEqual([]);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});
	});

	describe("planner-selected Inbox for an email request", () => {
		it("navigates to the supplied Inbox id", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "go to my email", {
				view: "inbox",
			});
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["inbox"]);
		});

		it("honors the registered Inbox label when the view also has email tags", async () => {
			const withEmailAlias = REGISTRY.map((v) =>
				v.id === "inbox"
					? { ...v, tags: [...(v.tags ?? []), "email", "mail"] }
					: v,
			);
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(withEmailAlias, "go to my email", {
				view: "Inbox",
			});
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["inbox"]);
		});
	});

	describe("missing structured target — no passive navigation fallback", () => {
		it("does not infer the coding view from a feature request even when it is registered", async () => {
			const codingRegistry: ViewSummary[] = [
				...REGISTRY,
				{
					id: "task-coordinator",
					label: "Task Coordinator",
					description: "Coding agent task threads, sessions, and controls",
					pluginName: "task-coordinator",
					available: true,
					viewType: "gui",
					tags: [
						"developer",
						"coding-agent",
						"coding",
						"build",
						"feature",
						"app builder",
						"tasks",
					],
				},
			];
			const { navigated } = installNavigateCapture();
			const { result, callback } = await runShow(
				codingRegistry,
				"I want to add a new feature to my app",
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				turnComplete: false,
			});
			expect(callback).not.toHaveBeenCalled();
			expect(navigated).toEqual([]);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it.each([
			"check my messages",
			"show me my balance",
			"give me an overview of my wallet",
			"muéstrame mi calendario",
			"我的钱包",
		])(
			'does not navigate from "%s" without a planner target',
			async (phrase) => {
				const { navigated } = installNavigateCapture();
				const { result, callback } = await runShow(REGISTRY, phrase);
				expect(result).toMatchObject({
					success: false,
					transcriptVisibility: "internal",
					turnComplete: false,
				});
				expect(callback).not.toHaveBeenCalled();
				expect(navigated).toEqual([]);
				expect(globalThis.fetch).not.toHaveBeenCalled();
			},
		);
	});

	describe("validate() gating", () => {
		it("allows read/navigation modes for any user", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => false),
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				message("open the wallet view") as never,
			);
			expect(ok).toBe(true);
		});

		it("owner-gates a structured delete operation", async () => {
			const owner = vi.fn(async () => false);
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: owner,
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				message("delete the wallet plugin view") as never,
				undefined as never,
				{ action: "delete", view: "wallet" } as never,
			);
			expect(ok).toBe(false);
			expect(owner).toHaveBeenCalled();
		});

		// Regression: the runtime calls validate(runtime, message, state, options)
		// with options.parameters carrying the planner's chosen action. A
		// destructive mode supplied via options whose text lacks a "view"/"plugin"
		// noun must STILL hit the owner gate — previously validate inferred the
		// mode from text only and let these through ungated.
		it.each([
			["delete", { action: "delete", view: "wallet" }, "remove wallet"],
			["create", { action: "create" }, "make me a habit tracker"],
			["edit", { action: "edit", view: "wallet" }, "change the wallet color"],
		])(
			"owner-gates %s supplied via planner options (text has no view noun)",
			async (_label, options, text) => {
				const owner = vi.fn(async () => false);
				const action = createViewsAction({
					client: clientFor(REGISTRY),
					hasOwnerAccess: owner,
				});
				const ok = await action.validate(
					{ agentId: "agent-1" } as never,
					message(text) as never,
					undefined as never,
					options as never,
				);
				expect(ok).toBe(false);
				expect(owner).toHaveBeenCalled();
			},
		);

		it("still allows read modes supplied via planner options for any user", async () => {
			const owner = vi.fn(async () => false);
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: owner,
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				message("wallet") as never,
				undefined as never,
				{ action: "show", view: "wallet" } as never,
			);
			expect(ok).toBe(true);
			expect(owner).not.toHaveBeenCalled();
		});

		// #8613: on a text connector with no view surface for the asker, a
		// desktop-only nav/layout op (show/open/close/split/…) is a silent
		// non-answer if chosen as the terminal action. validate() must drop it so
		// the turn falls back to a REPLY the connector actually delivers.
		function sourcedMessage(text: string, source: string) {
			return {
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text, source },
			};
		}

		it.each([
			["discord", { action: "show", view: "wallet" }, "show me my wallet"],
			["telegram", { action: "open", view: "calendar" }, "open my calendar"],
			["matrix", { action: "close" }, "close this view"],
			["slack", { action: "split", view: "wallet" }, "split the wallet view"],
			["whatsapp", { action: "tile" }, "tile my views"],
			["x", { action: "manager" }, "show the view manager"],
		])(
			"gates desktop-only mode off the %s connector (no view surface)",
			async (source, options, text) => {
				const action = createViewsAction({
					client: clientFor(REGISTRY),
					hasOwnerAccess: vi.fn(async () => true),
				});
				const ok = await action.validate(
					{ agentId: "agent-1" } as never,
					sourcedMessage(text, source) as never,
					undefined as never,
					options as never,
				);
				expect(ok).toBe(false);
			},
		);

		it("keeps text-producing read modes available on a text connector", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			for (const options of [
				{ action: "list" },
				{ action: "current" },
				{ action: "search", query: "wallet" },
			]) {
				const ok = await action.validate(
					{ agentId: "agent-1" } as never,
					sourcedMessage("list my views", "discord") as never,
					undefined as never,
					options as never,
				);
				expect(ok).toBe(true);
			}
		});

		it("keeps capability/content ops (interact) available on a text connector", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				sourcedMessage("add a calendar event", "discord") as never,
				undefined as never,
				{
					action: "interact",
					view: "calendar",
					capability: "create-calendar-event",
				} as never,
			);
			expect(ok).toBe(true);
		});

		it("still navigates on a local view-capable surface (no source / dashboard)", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			for (const source of [undefined, "chat", "user_chat", "app"]) {
				const ok = await action.validate(
					{ agentId: "agent-1" } as never,
					{
						entityId: "user-1",
						roomId: "room-1",
						agentId: "agent-1",
						content: { text: "show my wallet", ...(source ? { source } : {}) },
					} as never,
					undefined as never,
					{ action: "show", view: "wallet" } as never,
				);
				expect(ok).toBe(true);
			}
		});

		it("owner gate still applies to authoring ops on a text connector", async () => {
			const owner = vi.fn(async () => false);
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: owner,
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				sourcedMessage("delete the wallet plugin", "discord") as never,
				undefined as never,
				{ action: "delete", view: "wallet" } as never,
			);
			expect(ok).toBe(false);
			expect(owner).toHaveBeenCalled();
		});

		// A sub-agent completion relay carries content.source="sub_agent" (not the
		// origin connector). Its true origin is on metadata.originSource. The
		// desktop-mode gate must resolve the EFFECTIVE source so a Discord-triggered
		// build relay doesn't terminate on "Opening your Settings now." instead of
		// relaying the result.
		function relayMessage(text: string, metadata: Record<string, unknown>) {
			return {
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text, source: "sub_agent", metadata },
			};
		}

		it("gates desktop-only mode off a sub-agent relay that ORIGINATED on a text connector", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				relayMessage("Opening your Settings now.", {
					subAgent: true,
					originSource: "discord",
				}) as never,
				undefined as never,
				{ action: "open", view: "settings" } as never,
			);
			expect(ok).toBe(false);
		});

		it("gates desktop-only mode off a sub-agent relay with unknown/missing origin (a relay never navigates UI)", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				relayMessage("Opening your Settings now.", {
					subAgent: true,
				}) as never,
				undefined as never,
				{ action: "open", view: "settings" } as never,
			);
			expect(ok).toBe(false);
		});

		// Spawning a sub-agent from WITHIN the Eliza app: the dashboard sends
		// source="client_chat" (a view-capable local surface), so the relay's
		// originSource is view-capable and desktop navigation stays available — the
		// user is in the app and CAN see views. Only text connectors are restricted.
		it.each(["client_chat", "app", "chat", "user_chat"])(
			"keeps desktop navigation for a sub-agent relay that originated in the app (%s)",
			async (originSource) => {
				const action = createViewsAction({
					client: clientFor(REGISTRY),
					hasOwnerAccess: vi.fn(async () => true),
				});
				const ok = await action.validate(
					{ agentId: "agent-1" } as never,
					relayMessage("show my wallet", {
						subAgent: true,
						originSource,
					}) as never,
					undefined as never,
					{ action: "show", view: "wallet" } as never,
				);
				expect(ok).toBe(true);
			},
		);

		// The runtime composes the planner's action surface by calling validate
		// WITHOUT planner options: the mode is inferable from the message text
		// alone or not at all. On a text connector with no view surface, a turn
		// whose text carries no view intent must NOT expose VIEWS — the planner
		// otherwise sees a "view switching is a proactive default" tool it can
		// only hallucinate with ("Opening your Relationships now" into a Discord
		// channel that renders no views, observed live).
		function runtimeWithTasks(tasks: ReadonlyArray<Record<string, unknown>>) {
			return {
				agentId: "agent-1",
				getTasks: vi.fn(async ({ tags }: { tags?: string[] }) =>
					tasks.filter((task) =>
						(tags ?? []).some((tag) =>
							(task.tags as string[] | undefined)?.includes(tag),
						),
					),
				),
			};
		}

		it.each(["discord", "telegram", "slack", "whatsapp"])(
			"keeps VIEWS off the planner surface for a no-view-intent turn on %s (surface-composition validate: no options)",
			async (source) => {
				const action = createViewsAction({
					client: clientFor(REGISTRY),
					hasOwnerAccess: vi.fn(async () => true),
				});
				const ok = await action.validate(
					runtimeWithTasks([]) as never,
					sourcedMessage(
						"lol did you catch what happened on the server last night",
						source,
					) as never,
				);
				expect(ok).toBe(false);
			},
		);

		it("still exposes VIEWS for a no-view-intent turn on a local view-capable surface", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			for (const source of [undefined, "chat", "user_chat", "app"]) {
				const ok = await action.validate(
					runtimeWithTasks([]) as never,
					{
						entityId: "user-1",
						roomId: "room-1",
						agentId: "agent-1",
						content: {
							text: "lol did you catch what happened on the server last night",
							...(source ? { source } : {}),
						},
					} as never,
				);
				expect(ok).toBe(true);
			}
		});

		it("keeps a pending multi-turn create flow reachable on a text connector", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			const ok = await action.validate(
				runtimeWithTasks([
					{
						id: "task-1",
						agentId: "agent-1",
						tags: ["views-create-intent"],
						metadata: { roomId: "room-1", intent: "make a habit tracker" },
					},
				]) as never,
				sourcedMessage("yes go ahead", "discord") as never,
			);
			expect(ok).toBe(true);
		});

		it("keeps a pending delete confirmation reachable on a text connector (owner only)", async () => {
			const owner = vi.fn(async () => true);
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: owner,
			});
			const pendingDelete = [
				{
					id: "task-2",
					tags: ["views-delete-confirm"],
					metadata: {
						roomId: "room-1",
						viewId: "wallet",
						viewLabel: "Wallet",
						pluginName: "plugin-wallet:ui",
					},
				},
			];
			const ok = await action.validate(
				runtimeWithTasks(pendingDelete) as never,
				sourcedMessage("yes", "discord") as never,
			);
			expect(ok).toBe(true);
			expect(owner).toHaveBeenCalled();

			owner.mockResolvedValue(false);
			const denied = await action.validate(
				runtimeWithTasks(pendingDelete) as never,
				sourcedMessage("yes", "discord") as never,
			);
			expect(denied).toBe(false);
		});
	});

	describe("developer visibility remains owned by the registry route", () => {
		// listViews() in the show path is called WITHOUT developerMode, so the
		// route returns only non-developer views to a normal user — but the action
		// asks the client with no developerMode flag. We assert what the client is
		// actually queried with, to document that gating depends entirely on the
		// route filtering (the action does not pass developerMode=true).
		it("show path calls listViews without forcing developerMode", async () => {
			installNavigateCapture();
			const client = clientFor(REGISTRY);
			const action = createViewsAction({
				client,
				hasOwnerAccess: vi.fn(async () => true),
			});
			await action.handler(
				{ agentId: "agent-1" } as never,
				message("open the logs view") as never,
				undefined,
				{ action: "show", view: "logs" },
				vi.fn(),
			);
			expect(client.listViews).toHaveBeenCalled();
			const calls = (client.listViews as ReturnType<typeof vi.fn>).mock.calls;
			// Every listViews call must NOT request developerMode (the action relies
			// on the route's default visibility filtering, not its own escalation).
			for (const [opts] of calls) {
				expect(
					(opts as { developerMode?: boolean } | undefined)?.developerMode,
				).toBeFalsy();
			}
		});
	});
});

// Compatibility export only: the first-party show action does not use this
// pure helper to infer or override a structured navigation target.
describe("resolveIntentView compatibility export — expanded surfaces + multilingual", () => {
	describe("English: every domain surface routes to its view", () => {
		const EN_CASES: ReadonlyArray<readonly [string, string]> = [
			["what's on my calendar", "calendar"],
			["am I free this afternoon", "calendar"],
			["check my email", "inbox"],
			["any new messages", "inbox"],
			["show my wallet", "wallet"],
			["my portfolio", "wallet"],
			["how much did I spend this month", "finances"],
			["my subscriptions", "finances"],
			["I need to focus", "focus"],
			["block out distractions", "focus"],
			["my goals", "goals"],
			["my routines", "goals"],
			["my health", "health"],
			["how did I sleep", "health"],
			["what's on my to-do list", "todos"],
			["my tasks", "todos"],
			["pull up my documents", "documents"],
			["who do I know at Acme", "relationships"],
			["my contacts", "relationships"],
			["I want to add a new feature to my app", "task-coordinator"],
			["open the app builder", "task-coordinator"],
		];
		it.each(EN_CASES)('"%s" -> %s', (phrase, viewId) => {
			expect(resolveIntentView(phrase)).toBe(viewId);
		});

		it("routes notes to the Notes view instead of Knowledge/Documents", () => {
			expect(resolveIntentView("my notes")).toBe("notes");
			expect(resolveIntentView("pull up my notes")).toBe("notes");
		});
	});

	describe("Spanish (es)", () => {
		const ES_CASES: ReadonlyArray<readonly [string, string]> = [
			["muéstrame mi calendario", "calendar"],
			["mi calendario", "calendar"],
			["revisa mi correo", "inbox"],
			["mis mensajes", "inbox"],
			["abre mi cartera", "wallet"],
			["mi billetera", "wallet"],
			["cuánto gasté este mes", "finances"],
			["mis finanzas", "finances"],
			["necesito concentrarme", "focus"],
			["mis metas", "goals"],
			["mis objetivos", "goals"],
			["mi salud", "health"],
			["mis tareas", "todos"],
			["mis documentos", "documents"],
			["mis contactos", "relationships"],
		];
		it.each(ES_CASES)('"%s" -> %s', (phrase, viewId) => {
			expect(resolveIntentView(phrase)).toBe(viewId);
		});
	});

	describe("French (fr)", () => {
		const FR_CASES: ReadonlyArray<readonly [string, string]> = [
			["montre-moi mon calendrier", "calendar"],
			["mon agenda", "calendar"],
			["mon courrier", "inbox"],
			["mes messages", "inbox"],
			["mon portefeuille", "wallet"],
			["mes finances", "finances"],
			["mes objectifs", "goals"],
			["ma santé", "health"],
			["mes tâches", "todos"],
			["mes documents", "documents"],
			["mes contacts", "relationships"],
			["mode concentration", "focus"],
		];
		it.each(FR_CASES)('"%s" -> %s', (phrase, viewId) => {
			expect(resolveIntentView(phrase)).toBe(viewId);
		});
	});

	describe("German (de)", () => {
		const DE_CASES: ReadonlyArray<readonly [string, string]> = [
			["mein kalender", "calendar"],
			["meine nachrichten", "inbox"],
			["mein postfach", "inbox"],
			["meine brieftasche", "wallet"],
			["meine finanzen", "finances"],
			["meine ziele", "goals"],
			["meine gesundheit", "health"],
			["meine aufgaben", "todos"],
			["meine dokumente", "documents"],
			["meine kontakte", "relationships"],
		];
		it.each(DE_CASES)('"%s" -> %s', (phrase, viewId) => {
			expect(resolveIntentView(phrase)).toBe(viewId);
		});
	});

	describe("Chinese (zh)", () => {
		const ZH_CASES: ReadonlyArray<readonly [string, string]> = [
			["我的日历", "calendar"],
			["我的邮件", "inbox"],
			["我的消息", "inbox"],
			["我的钱包", "wallet"],
			["我的财务", "finances"],
			["我的目标", "goals"],
			["我的健康", "health"],
			["我的待办", "todos"],
			["我的文档", "documents"],
			["我的联系人", "relationships"],
		];
		it.each(ZH_CASES)('"%s" -> %s', (phrase, viewId) => {
			expect(resolveIntentView(phrase)).toBe(viewId);
		});
	});

	// Japanese/Korean/Vietnamese/Tagalog/Portuguese parity, driven directly off
	// the shared CURATED_MULTILINGUAL fixture so this block can never drift from
	// the canonical view-matrix data. Each curated phrase must resolve to its
	// view id under the deterministic intent fallback.
	describe.each(["ja", "ko", "vi", "tl", "pt"] as const)(
		"%s (from CURATED_MULTILINGUAL fixture)",
		(lang) => {
			const cases = CURATED_MULTILINGUAL.filter((c) => c.lang === lang);

			it("has curated coverage for this language", () => {
				expect(cases.length).toBeGreaterThan(0);
			});

			it.each(cases.map((c) => [c.phrase, c.viewId] as const))(
				'"%s" -> %s',
				(phrase, viewId) => {
					expect(resolveIntentView(phrase)).toBe(viewId);
				},
			);
		},
	);

	it("returns null for non-navigational text (no false routing)", () => {
		expect(resolveIntentView("thanks, that's all for now")).toBeNull();
		expect(resolveIntentView("what's the weather like")).toBeNull();
		expect(resolveIntentView("")).toBeNull();
		expect(resolveIntentView(undefined)).toBeNull();
	});
});
