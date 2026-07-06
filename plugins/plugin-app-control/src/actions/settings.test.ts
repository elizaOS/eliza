/**
 * Unit coverage for the SETTINGS action (#14364): param routing, boolean-value
 * parsing, section-token resolution, the delegate/route/readonly/unwired write
 * paths, and the completeness invariant that every built-in settings section has
 * a registry entry. The backend route is exercised through an injected fetch
 * (`SettingsRouteFetch`) so `set` dispatch is asserted without a live server.
 */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { APPEARANCE_APPLY_EVENT } from "@elizaos/shared";
import {
	SETTINGS_NON_CATALOG_SECTION_META,
	SETTINGS_SECTION_META,
} from "@elizaos/ui/components/settings/settings-section-meta";
import { describe, expect, it, vi } from "vitest";
import {
	createSettingsAction,
	parseBooleanValue,
	parseSettingsRequest,
	resolveSectionId,
	SETTINGS_NON_CATALOG_SECTION_AUDIT,
	SETTINGS_WRITE_REGISTRY,
	type SettingsRouteFetch,
} from "./settings.ts";

const runtime = {} as IAgentRuntime;
const message = { content: { text: "" } } as Memory;

/** Collect callback replies so we can assert what the user is told. */
function makeCallback(): { cb: HandlerCallback; texts: string[] } {
	const texts: string[] = [];
	const cb: HandlerCallback = async (content) => {
		if (typeof content.text === "string") texts.push(content.text);
		return [];
	};
	return { cb, texts };
}

/** Invoke the handler with structured options nested the way the planner sends them. */
async function invoke(
	options: Record<string, unknown>,
	routeFetch?: SettingsRouteFetch,
) {
	const action = createSettingsAction(routeFetch ? { routeFetch } : {});
	const { cb, texts } = makeCallback();
	const result = await action.handler(
		runtime,
		message,
		undefined,
		{ parameters: options },
		cb,
	);
	return { result, texts };
}

describe("parseBooleanValue", () => {
	it.each([
		["on", true],
		["ON", true],
		["enable", true],
		["true", true],
		["yes", true],
		["1", true],
		["off", false],
		["disable", false],
		["false", false],
		["no", false],
		["0", false],
	])("parses %s -> %s", (input, expected) => {
		expect(parseBooleanValue(input)).toBe(expected);
	});

	it("returns null for non-boolean tokens and empty", () => {
		expect(parseBooleanValue("maybe")).toBeNull();
		expect(parseBooleanValue("")).toBeNull();
		expect(parseBooleanValue(null)).toBeNull();
	});
});

describe("resolveSectionId", () => {
	it("resolves canonical ids and declared aliases", () => {
		expect(resolveSectionId("permissions")).toBe("permissions");
		expect(resolveSectionId("perms")).toBe("permissions");
		expect(resolveSectionId("model")).toBe("ai-model");
		expect(resolveSectionId("wallet")).toBe("wallet-rpc");
		expect(resolveSectionId("  Theme ")).toBe("appearance");
	});

	it("returns null for unknown tokens", () => {
		expect(resolveSectionId("nonsense")).toBeNull();
		expect(resolveSectionId(null)).toBeNull();
	});
});

describe("parseSettingsRequest", () => {
	it("reads explicit verb + section + key + value", () => {
		expect(
			parseSettingsRequest({
				action: "set",
				section: "permissions",
				key: "shell",
				value: "off",
			}),
		).toEqual({
			verb: "set",
			sectionId: "permissions",
			key: "shell",
			value: "off",
			fileName: null,
			confirm: null,
			app: null,
			namespace: null,
			permission: null,
			provider: null,
			chain: null,
			network: null,
			evm: null,
			bsc: null,
			solana: null,
		});
	});

	it("maps verb synonyms to canonical verbs", () => {
		expect(parseSettingsRequest({ action: "toggle" })?.verb).toBe("set");
		expect(parseSettingsRequest({ action: "show" })?.verb).toBe("get");
		expect(parseSettingsRequest({ action: "sections" })?.verb).toBe("list");
	});

	it("infers set/get when a section is given without a verb", () => {
		expect(
			parseSettingsRequest({ section: "permissions", value: "off" })?.verb,
		).toBe("set");
		expect(parseSettingsRequest({ section: "permissions" })?.verb).toBe("get");
	});

	it("returns null when neither verb nor section is present", () => {
		expect(parseSettingsRequest({ value: "off" })).toBeNull();
		expect(parseSettingsRequest(undefined)).toBeNull();
	});

	it("reads backup command parameters", () => {
		expect(
			parseSettingsRequest({
				action: "set",
				section: "advanced",
				key: "restore-backup",
				fileName: "agent-2026.agent-backup.json",
				confirm: "true",
			}),
		).toMatchObject({
			verb: "set",
			sectionId: "advanced",
			key: "restore-backup",
			fileName: "agent-2026.agent-backup.json",
			confirm: "true",
		});
	});

	it("reads app and namespace options for app-permissions writes", () => {
		expect(
			parseSettingsRequest({
				action: "set",
				section: "app-permissions",
				app: "weather",
				namespace: "network",
				value: "off",
			}),
		).toMatchObject({
			verb: "set",
			sectionId: "app-permissions",
			app: "weather",
			namespace: "network",
			value: "off",
		});
	});

	it("reads permission/id options for OS permission requests", () => {
		expect(
			parseSettingsRequest({
				action: "set",
				section: "permissions",
				key: "request",
				id: "microphone",
			}),
		).toMatchObject({
			verb: "set",
			sectionId: "permissions",
			key: "request",
			permission: "microphone",
		});
	});

	it("reads wallet RPC provider options", () => {
		expect(
			parseSettingsRequest({
				action: "set",
				section: "wallet-rpc",
				chain: "evm",
				provider: "alchemy",
				network: "testnet",
			}),
		).toMatchObject({
			verb: "set",
			sectionId: "wallet-rpc",
			chain: "evm",
			provider: "alchemy",
			network: "testnet",
		});
	});
});

describe("registry completeness", () => {
	it("has an entry for every built-in settings section", () => {
		const metaIds = SETTINGS_SECTION_META.map((m) => m.id).sort();
		const registryIds = Object.keys(SETTINGS_WRITE_REGISTRY).sort();
		expect(registryIds).toEqual(metaIds);
	});

	it("pins audit records for non-catalog settings sections", () => {
		const nonCatalogIds = SETTINGS_NON_CATALOG_SECTION_META.map(
			(meta) => meta.id,
		).sort();
		expect(Object.keys(SETTINGS_NON_CATALOG_SECTION_AUDIT).sort()).toEqual(
			nonCatalogIds,
		);
		for (const [id, entry] of Object.entries(
			SETTINGS_NON_CATALOG_SECTION_AUDIT,
		)) {
			expect(
				entry.reason.trim().length,
				`non-catalog section "${id}" needs a durable audit reason`,
			).toBeGreaterThan(20);
			expect(
				entry.coveredBy || entry.trackingIssue,
				`non-catalog section "${id}" needs coverage or an issue`,
			).toBeTruthy();
			expect(SETTINGS_WRITE_REGISTRY[id]).toBeUndefined();
		}
	});

	it("requires every unwired catalog section to be tracked or explicitly exempt", () => {
		for (const [id, cap] of Object.entries(SETTINGS_WRITE_REGISTRY)) {
			if (cap.kind !== "unwired") continue;
			expect(
				cap.trackingIssue || cap.exemptionReason,
				`unwired section "${id}" needs a tracking issue or exemption`,
			).toBeTruthy();
		}
		expect(SETTINGS_WRITE_REGISTRY.voice).toMatchObject({
			kind: "route",
		});
		expect(SETTINGS_WRITE_REGISTRY["wallet-rpc"]).toMatchObject({
			kind: "route",
		});
	});

	it("names only real dedicated actions for delegated sections", () => {
		const allowed = new Set([
			"CHARACTER",
			"MODEL_SWITCH",
			"BACKGROUND",
			"PLUGIN",
			"SECRETS",
		]);
		for (const cap of Object.values(SETTINGS_WRITE_REGISTRY)) {
			if (cap.kind === "delegate") expect(allowed.has(cap.action)).toBe(true);
		}
		expect(SETTINGS_WRITE_REGISTRY.connectors).toMatchObject({
			kind: "delegate",
			action: "PLUGIN",
		});
		expect(SETTINGS_WRITE_REGISTRY.secrets).toMatchObject({
			kind: "delegate",
			action: "SECRETS",
		});
	});
});

describe("SETTINGS action: list", () => {
	it("lists writable sections with how each is written", async () => {
		const { result } = await invoke({ action: "list" });
		expect(result?.success).toBe(true);
		const sections = (
			result?.data as { sections: Array<Record<string, unknown>> }
		).sections;
		expect(sections).toHaveLength(SETTINGS_SECTION_META.length);
		const model = sections.find((s) => s.id === "ai-model");
		expect(model).toMatchObject({ writable: true, via: "MODEL_SWITCH" });
		const permissions = sections.find((s) => s.id === "permissions");
		expect(permissions).toMatchObject({ writable: true, via: "SETTINGS" });
		const appearance = sections.find((s) => s.id === "appearance");
		expect(appearance).toMatchObject({ writable: true, via: "SETTINGS" });
		const voice = sections.find((s) => s.id === "voice");
		expect(voice).toMatchObject({ writable: true, via: "SETTINGS" });
		const capabilities = sections.find((s) => s.id === "capabilities");
		expect(capabilities).toMatchObject({ writable: true, via: "SETTINGS" });
		const walletRpc = sections.find((s) => s.id === "wallet-rpc");
		expect(walletRpc).toMatchObject({ writable: true, via: "SETTINGS" });
		const advanced = sections.find((s) => s.id === "advanced");
		expect(advanced).toMatchObject({ writable: true, via: "SETTINGS" });
		const appPermissions = sections.find((s) => s.id === "app-permissions");
		expect(appPermissions).toMatchObject({
			writable: true,
			via: "SETTINGS",
		});
		const updates = sections.find((s) => s.id === "updates");
		expect(updates).toMatchObject({ writable: true, via: "SETTINGS" });
	});
});

describe("SETTINGS action: set on an owned route section", () => {
	it("dispatches appearance theme mode through the view event broadcast route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "appearance", key: "theme", value: "dark" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/views/events/broadcast",
			body: {
				type: APPEARANCE_APPLY_EVENT,
				payload: { themeMode: "dark" },
			},
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "appearance",
			key: "theme",
		});
		expect(texts.join(" ")).toContain("Theme mode is dark");
	});

	it("dispatches appearance accent aliases through the view event broadcast route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result } = await invoke(
			{ action: "set", section: "appearance", key: "accent", value: "orange" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/views/events/broadcast",
			body: {
				type: APPEARANCE_APPLY_EVENT,
				payload: { accentId: "default" },
			},
		});
		expect(result?.success).toBe(true);
	});

	it("dispatches appearance UI language through the view event broadcast route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result } = await invoke(
			{
				action: "set",
				section: "theme",
				key: "language",
				value: "spanish",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/views/events/broadcast",
			body: {
				type: APPEARANCE_APPLY_EVENT,
				payload: { language: "es" },
			},
		});
		expect(result?.success).toBe(true);
	});

	it("dispatches the home time/date widget visibility as the persisted hidden flag", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result } = await invoke(
			{
				action: "set",
				section: "appearance",
				key: "home-time-widget",
				value: "off",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/views/events/broadcast",
			body: {
				type: APPEARANCE_APPLY_EVENT,
				payload: { homeTimeWidgetHidden: true },
			},
		});
		expect(result?.success).toBe(true);
	});

	it("rejects unsupported appearance values without broadcasting", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "appearance", key: "theme", value: "sepia" },
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("supported appearance value");
	});

	it("updates voice continuous-chat mode through the config route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						messages: {
							existing: { keep: true },
							voice: {
								continuous: "off",
								vadAutoStop: {
									silenceMs: 900,
									speechRmsThreshold: 0.006,
								},
							},
						},
					},
				};
			}
			return { ok: true };
		});
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "voice",
				key: "continuous",
				value: "always-on",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(1, {
			method: "GET",
			path: "/api/config",
		});
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/config",
			body: {
				messages: {
					existing: { keep: true },
					voice: {
						continuous: "always-on",
						vadAutoStop: {
							silenceMs: 900,
							speechRmsThreshold: 0.006,
						},
					},
				},
			},
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "voice",
			key: "continuous",
		});
		expect(texts.join(" ")).toContain("continuous chat is always-on");
	});

	it("updates voice VAD silence while preserving existing voice prefs", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						messages: {
							voice: {
								continuous: "vad-gated",
								vadAutoStop: {
									silenceMs: 900,
									speechRmsThreshold: 0.006,
								},
							},
						},
					},
				};
			}
			return { ok: true };
		});
		const { result } = await invoke(
			{
				action: "set",
				section: "voice",
				key: "silence-ms",
				value: "1200",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/config",
			body: {
				messages: {
					voice: {
						continuous: "vad-gated",
						vadAutoStop: {
							silenceMs: 1200,
							speechRmsThreshold: 0.006,
						},
					},
				},
			},
		});
		expect(result?.success).toBe(true);
	});

	it("rejects out-of-range voice VAD values before writing", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: { messages: { voice: { continuous: "off" } } },
		}));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "voice",
				key: "rms",
				value: "0.2",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledTimes(1);
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("between 0.001 and 0.02");
	});

	it("surfaces voice config backend failures instead of fabricating success", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return { ok: true, data: { messages: {} } };
			}
			return { ok: false, detail: "config save failed" };
		});
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "voice",
				key: "continuous-chat",
				value: "vad",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledTimes(2);
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("config save failed");
	});

	it("dispatches permissions shell off through the backend route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "permissions", key: "shell", value: "off" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "PUT",
			path: "/api/permissions/shell",
			body: { enabled: false },
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "permissions",
			key: "shell",
			value: false,
		});
		expect(texts.join(" ")).toContain("off");
	});

	it("requests an OS permission then opens the permissions section when handoff is needed", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.path === "/api/permissions/microphone/request") {
				return {
					ok: true,
					data: {
						id: "microphone",
						status: "not-determined",
						canRequest: true,
					},
				};
			}
			return { ok: true };
		});
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "permissions",
				key: "request",
				permission: "microphone",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(1, {
			method: "POST",
			path: "/api/permissions/microphone/request",
		});
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "POST",
			path: "/api/views/settings/navigate",
			body: {
				path: "/settings",
				subview: "permissions",
				source: "settings-action",
				payload: { permissionRequest: { permission: "microphone" } },
			},
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "permissions",
			key: "request",
			permission: "microphone",
		});
		expect(texts.join(" ")).toContain("Settings > Permissions");
	});

	it("accepts common OS permission aliases as keys", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: { id: "microphone", status: "granted" },
		}));
		const { result } = await invoke(
			{ action: "set", section: "permissions", key: "mic" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledTimes(1);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/permissions/microphone/request",
		});
		expect(result?.values).toMatchObject({
			key: "mic",
			permission: "microphone",
		});
	});

	it("does not open the permissions section when the request returns granted", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: { id: "camera", status: "granted" },
		}));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "permissions",
				key: "request",
				permission: "camera",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledTimes(1);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/permissions/camera/request",
		});
		expect(result?.success).toBe(true);
		expect(texts.join(" ")).not.toContain("Settings > Permissions");
	});

	it("uses permission=<id> as an implicit request key", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: { id: "notifications", status: "not-applicable" },
		}));
		const { result } = await invoke(
			{ action: "set", section: "permissions", permission: "notifications" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/permissions/notifications/request",
		});
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/views/settings/navigate",
			body: {
				path: "/settings",
				subview: "permissions",
				source: "settings-action",
				payload: { permissionRequest: { permission: "notifications" } },
			},
		});
		expect(result?.values).toMatchObject({
			key: "request",
			permission: "notifications",
		});
	});

	it("rejects unknown OS permission requests without calling a route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "permissions",
				key: "request",
				permission: "telepathy",
			},
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("provide permission=<id>");
	});

	it("defaults to the section's primary key when key is omitted", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		await invoke(
			{ action: "set", section: "permissions", value: "on" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "PUT",
			path: "/api/permissions/shell",
			body: { enabled: true },
		});
	});

	it("dispatches capabilities auto-training through the training config route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "capabilities",
				key: "auto-training",
				value: "on",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/training/auto/config",
			body: { autoTrain: true },
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "capabilities",
			key: "auto-training",
			value: true,
		});
		expect(texts.join(" ")).toContain("Auto-training is on");
	});

	it("defaults capabilities to auto-training when key is omitted", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		await invoke(
			{ action: "set", section: "capabilities", value: "off" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/training/auto/config",
			body: { autoTrain: false },
		});
	});

	it("dispatches capabilities wallet through the config route (#14703 residual)", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "capabilities", key: "wallet", value: "false" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "PUT",
			path: "/api/config",
			body: { ui: { capabilities: { wallet: false } } },
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "capabilities",
			key: "wallet",
			value: false,
		});
		expect(texts.join(" ")).toContain("wallet capability is off");
	});

	it("dispatches capabilities browser on through the config route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result } = await invoke(
			{ action: "set", section: "capabilities", key: "browser", value: "on" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "PUT",
			path: "/api/config",
			body: { ui: { capabilities: { browser: true } } },
		});
		expect(result?.success).toBe(true);
	});

	it.each([
		"computerUse",
		"computer-use",
	])("accepts %s as the computer-use capability key", async (key) => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result } = await invoke(
			{ action: "set", section: "capabilities", key, value: "off" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "PUT",
			path: "/api/config",
			body: { ui: { capabilities: { computerUse: false } } },
		});
		expect(result?.success).toBe(true);
	});

	it("updates one wallet RPC provider through the wallet config route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						selectedRpcProviders: {
							evm: "eliza-cloud",
							bsc: "eliza-cloud",
							solana: "eliza-cloud",
						},
						walletNetwork: "mainnet",
						legacyCustomChains: [],
					},
				};
			}
			return { ok: true };
		});
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "wallet-rpc",
				key: "evm",
				value: "alchemy",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(1, {
			method: "GET",
			path: "/api/wallet/config",
		});
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/wallet/config",
			body: {
				selections: {
					evm: "alchemy",
					bsc: "eliza-cloud",
					solana: "eliza-cloud",
				},
				walletNetwork: "mainnet",
				credentials: {},
			},
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "wallet-rpc",
			key: "evm",
		});
		expect(texts.join(" ")).toContain("EVM=alchemy");
		expect(texts.join(" ")).toContain("Secrets/Vault");
	});

	it("scopes chain/provider wallet RPC requests to the requested chain", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						selectedRpcProviders: {
							evm: "eliza-cloud",
							bsc: "ankr",
							solana: "helius-birdeye",
						},
						walletNetwork: "mainnet",
						legacyCustomChains: [],
					},
				};
			}
			return { ok: true };
		});
		const { result } = await invoke(
			{
				action: "set",
				section: "wallet-rpc",
				chain: "evm",
				provider: "alchemy",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/wallet/config",
			body: {
				selections: {
					evm: "alchemy",
					bsc: "ankr",
					solana: "helius-birdeye",
				},
				walletNetwork: "mainnet",
				credentials: {},
			},
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "wallet-rpc",
			key: "evm",
		});
	});

	it("switches all wallet RPC providers to Eliza Cloud without exposing secrets", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						selectedRpcProviders: {
							evm: "alchemy",
							bsc: "nodereal",
							solana: "helius-birdeye",
						},
						walletNetwork: "mainnet",
						legacyCustomChains: ["evm"],
						alchemyKeySet: true,
						nodeRealBscRpcSet: true,
						heliusKeySet: true,
						birdeyeKeySet: true,
					},
				};
			}
			return { ok: true };
		});
		const { result } = await invoke(
			{ action: "set", section: "wallet-rpc", key: "cloud" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/wallet/config",
			body: expect.objectContaining({
				selections: {
					evm: "eliza-cloud",
					bsc: "eliza-cloud",
					solana: "eliza-cloud",
				},
				walletNetwork: "mainnet",
				credentials: expect.objectContaining({
					ALCHEMY_API_KEY: "",
					NODEREAL_BSC_RPC_URL: "",
					HELIUS_API_KEY: "",
					BIRDEYE_API_KEY: "",
				}),
			}),
		});
		expect(result?.success).toBe(true);
	});

	it("changes wallet network mode while preserving current RPC selections", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						selectedRpcProviders: {
							evm: "infura",
							bsc: "ankr",
							solana: "eliza-cloud",
						},
						walletNetwork: "mainnet",
						legacyCustomChains: [],
					},
				};
			}
			return { ok: true };
		});
		const { result } = await invoke(
			{
				action: "set",
				section: "wallet-rpc",
				key: "network",
				value: "testnet",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/wallet/config",
			body: {
				selections: {
					evm: "infura",
					bsc: "ankr",
					solana: "eliza-cloud",
				},
				walletNetwork: "testnet",
				credentials: {},
			},
		});
		expect(result?.success).toBe(true);
	});

	it("rejects invalid wallet RPC providers before writing", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						selectedRpcProviders: {
							evm: "eliza-cloud",
							bsc: "eliza-cloud",
							solana: "eliza-cloud",
						},
						walletNetwork: "mainnet",
						legacyCustomChains: [],
					},
				};
			}
			return { ok: true };
		});
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "wallet-rpc",
				key: "evm",
				value: "nodereal",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledTimes(1);
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("not a supported evm RPC provider");
	});

	it("surfaces wallet RPC backend failures instead of fabricating success", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						selectedRpcProviders: {
							evm: "eliza-cloud",
							bsc: "eliza-cloud",
							solana: "eliza-cloud",
						},
						walletNetwork: "mainnet",
						legacyCustomChains: [],
					},
				};
			}
			return { ok: false, detail: "wallet config save failed" };
		});
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "wallet-rpc",
				key: "solana",
				value: "helius",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledTimes(2);
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("wallet config save failed");
	});

	it("surfaces a backend failure instead of fabricating success", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: false,
			detail: "runtime restart refused",
		}));
		const { result, texts } = await invoke(
			{ action: "set", section: "permissions", key: "shell", value: "off" },
			routeFetch,
		);
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("runtime restart refused");
	});

	it("creates a local agent backup through the backup route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: { backup: { fileName: "agent-2026.agent-backup.json" } },
		}));
		const { result, texts } = await invoke(
			{ action: "set", section: "advanced", key: "create-backup" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/backups",
			body: {},
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "advanced",
			key: "create-backup",
		});
		expect(texts.join(" ")).toContain("agent-2026.agent-backup.json");
	});

	it("restores a local agent backup only with fileName and confirmation", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "advanced",
				key: "restore-backup",
				fileName: "agent-2026.agent-backup.json",
				confirm: "true",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "POST",
			path: "/api/backups/restore",
			body: { fileName: "agent-2026.agent-backup.json" },
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "advanced",
			key: "restore-backup",
			fileName: "agent-2026.agent-backup.json",
		});
		expect(texts.join(" ")).toContain("Restart the agent");
	});

	it("refuses restore without explicit confirmation", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "advanced",
				key: "restore-backup",
				fileName: "agent-2026.agent-backup.json",
			},
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("confirm=true");
	});

	it("refuses restore without a backup file name", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "advanced",
				key: "restore-backup",
				confirm: "true",
			},
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("fileName");
	});

	it("read-modify-writes app permission namespace grants through the app route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						slug: "weather",
						trust: "external",
						isolation: "worker",
						requestedPermissions: {
							fs: { read: ["state/weather/**"] },
							net: { outbound: ["https://api.weather.test"] },
						},
						recognisedNamespaces: ["fs", "net"],
						grantedNamespaces: ["fs", "net"],
						grantedAt: "2026-01-01T00:00:00.000Z",
					},
				};
			}
			return { ok: true };
		});
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "app-permissions",
				app: "weather",
				key: "net",
				value: "off",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(1, {
			method: "GET",
			path: "/api/apps/permissions/weather",
		});
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/apps/permissions/weather",
			body: { namespaces: ["fs"] },
		});
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			section: "app-permissions",
			key: "net",
			value: false,
			app: "weather",
		});
		expect(texts.join(" ")).toContain("weather net permission is revoked");
	});

	it("accepts namespace aliases for app permissions", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "GET") {
				return {
					ok: true,
					data: {
						slug: "weather",
						trust: "external",
						isolation: "worker",
						requestedPermissions: {
							fs: { read: ["state/weather/**"] },
							net: { outbound: ["https://api.weather.test"] },
						},
						recognisedNamespaces: ["fs", "net"],
						grantedNamespaces: ["fs"],
						grantedAt: "2026-01-01T00:00:00.000Z",
					},
				};
			}
			return { ok: true };
		});
		const { result } = await invoke(
			{
				action: "set",
				section: "app-permissions",
				app: "weather",
				namespace: "network",
				value: "on",
			},
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "PUT",
			path: "/api/apps/permissions/weather",
			body: { namespaces: ["fs", "net"] },
		});
		expect(result?.values).toMatchObject({ key: "net", value: true });
	});

	it("refuses app permission writes without an app slug", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "app-permissions",
				key: "net",
				value: "off",
			},
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("app=<slug>");
	});

	it("refuses app permission writes when the route shape is invalid", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: { slug: "weather" },
		}));
		const { result, texts } = await invoke(
			{
				action: "set",
				section: "app-permissions",
				app: "weather",
				key: "net",
				value: "off",
			},
			routeFetch,
		);
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("invalid permission view");
	});

	it("rejects a non-boolean value without calling the route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result } = await invoke(
			{
				action: "set",
				section: "permissions",
				key: "shell",
				value: "sometimes",
			},
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
	});

	it("rejects an unknown key on an owned section", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "permissions", key: "bogus", value: "off" },
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("shell");
	});

	it("reads update status through the Release Center backend status route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: {
				currentVersion: "1.0.0",
				channel: "stable",
				updateAvailable: false,
				latestVersion: "1.0.0",
			},
		}));
		const { result, texts } = await invoke(
			{ action: "set", section: "updates", key: "status" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "GET",
			path: "/api/update/status",
		});
		expect(result?.success).toBe(true);
		expect(texts.join(" ")).toContain("Current: 1.0.0 on stable");
	});

	it("forces an update check through the update status route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: {
				currentVersion: "1.0.0",
				channel: "beta",
				updateAvailable: true,
				latestVersion: "1.1.0-beta.1",
			},
		}));
		const { result, texts } = await invoke(
			{ action: "set", section: "updates", key: "check" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "GET",
			path: "/api/update/status?force=true",
		});
		expect(result?.success).toBe(true);
		expect(texts.join(" ")).toContain("Update available: 1.0.0");
	});

	it("changes the update channel then refreshes status", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async (request) => {
			if (request.method === "PUT")
				return { ok: true, data: { channel: "beta" } };
			return {
				ok: true,
				data: {
					currentVersion: "1.0.0",
					channel: "beta",
					updateAvailable: false,
					latestVersion: "1.0.0",
				},
			};
		});
		const { result, texts } = await invoke(
			{ action: "set", section: "updates", key: "channel", value: "beta" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenNthCalledWith(1, {
			method: "PUT",
			path: "/api/update/channel",
			body: { channel: "beta" },
		});
		expect(routeFetch).toHaveBeenNthCalledWith(2, {
			method: "GET",
			path: "/api/update/status?force=true",
		});
		expect(result?.success).toBe(true);
		expect(texts.join(" ")).toContain("Update channel is beta");
	});

	it("rejects invalid update channels before calling the route", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "updates", key: "channel", value: "canary" },
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("stable, beta, or nightly");
	});

	it("reports the update apply plan without fabricating a remote installer job", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({
			ok: true,
			data: {
				currentVersion: "1.0.0",
				channel: "stable",
				updateAvailable: true,
				latestVersion: "1.1.0",
				canExecuteUpdate: false,
				updateInstructions:
					'This is a remote status view. Run "npm install -g elizaos@latest" on the host; no remote execution endpoint is exposed.',
			},
		}));
		const { result, texts } = await invoke(
			{ action: "set", section: "updates", key: "apply" },
			routeFetch,
		);
		expect(routeFetch).toHaveBeenCalledWith({
			method: "GET",
			path: "/api/update/status?force=true",
		});
		expect(result?.success).toBe(true);
		expect(texts.join(" ")).toContain("chat cannot apply it directly");
		expect(texts.join(" ")).toContain("no remote execution endpoint");
	});
});

describe("SETTINGS action: set on delegated/readonly/unwired sections", () => {
	it("points a delegated section at its dedicated action without writing", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result } = await invoke(
			{ action: "set", section: "ai-model", value: "cloud" },
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({ delegateTo: "MODEL_SWITCH" });
	});

	it("delegates connector settings to the default PLUGIN action", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "connectors", value: "telegram" },
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({ delegateTo: "PLUGIN" });
		expect(texts.join(" ")).toContain("PLUGIN");
	});

	it("delegates vault settings to SECRETS, not the browser credential action", async () => {
		const routeFetch = vi.fn<SettingsRouteFetch>(async () => ({ ok: true }));
		const { result, texts } = await invoke(
			{ action: "set", section: "secrets", value: "openai" },
			routeFetch,
		);
		expect(routeFetch).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({ delegateTo: "SECRETS" });
		expect(texts.join(" ")).toContain("SECRETS");
	});

	it("refuses to write a read-only section", async () => {
		const { result, texts } = await invoke({
			action: "set",
			section: "runtime",
			value: "on",
		});
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("read-only");
	});

	it("refuses every unwired gap section with its stated reason", async () => {
		const unwiredEntries = Object.entries(SETTINGS_WRITE_REGISTRY).filter(
			(
				entry,
			): entry is [
				string,
				Extract<
					(typeof SETTINGS_WRITE_REGISTRY)[keyof typeof SETTINGS_WRITE_REGISTRY],
					{ kind: "unwired" }
				>,
			] => entry[1].kind === "unwired",
		);
		expect(unwiredEntries.length).toBeGreaterThan(0);

		for (const [section, cap] of unwiredEntries) {
			const { result, texts } = await invoke({
				action: "set",
				section,
				value: "on",
			});
			expect(result?.success).toBe(false);
			expect(texts.join(" ")).toContain(cap.reason);
		}
	});
});

describe("SETTINGS action: get and validate", () => {
	it("is owner-gated because it can mutate shell permission state", () => {
		expect(createSettingsAction().roleGate).toEqual({ minRole: "OWNER" });
	});

	it("reports a section's write capability on get", async () => {
		const { result } = await invoke({ action: "get", section: "permissions" });
		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			section: "permissions",
			capability: "route",
		});
	});

	it("validate is an availability gate: always true (params validated in the handler)", async () => {
		// The planner surface calls validate at EXPOSURE time with no options, so
		// gating on parsed params would hide SETTINGS from the planner entirely
		// (the #14461 bug: shell/permission writes routed to VIEWS). Availability is
		// unconditional; the handler validates the actual request.
		const action = createSettingsAction();
		expect(await action.validate(runtime, message)).toBe(true);
		expect(await action.validate(runtime, message, undefined, {})).toBe(true);
		expect(
			await action.validate(runtime, message, undefined, {
				parameters: { value: "off" },
			}),
		).toBe(true);
	});

	it("handler asks for clarification on an unparseable request (no verb/section)", async () => {
		const { result, texts } = await invoke({ value: "off" });
		expect(result?.success).toBe(false);
		expect(texts.join(" ").toLowerCase()).toContain("settings");
	});
});
