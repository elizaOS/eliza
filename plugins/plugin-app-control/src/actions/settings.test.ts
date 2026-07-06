/**
 * Unit coverage for the SETTINGS action (#14364): param routing, boolean-value
 * parsing, section-token resolution, the delegate/route/readonly/unwired write
 * paths, and the completeness invariant that every built-in settings section has
 * a registry entry. The backend route is exercised through an injected fetch
 * (`SettingsRouteFetch`) so `set` dispatch is asserted without a live server.
 */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { SETTINGS_SECTION_META } from "@elizaos/ui/components/settings/settings-section-meta";
import { describe, expect, it, vi } from "vitest";
import {
	createSettingsAction,
	parseBooleanValue,
	parseSettingsRequest,
	resolveSectionId,
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
});

describe("registry completeness", () => {
	it("has an entry for every built-in settings section", () => {
		const metaIds = SETTINGS_SECTION_META.map((m) => m.id).sort();
		const registryIds = Object.keys(SETTINGS_WRITE_REGISTRY).sort();
		expect(registryIds).toEqual(metaIds);
	});

	it("names only real dedicated actions for delegated sections", () => {
		const allowed = new Set([
			"CHARACTER",
			"MODEL_SWITCH",
			"BACKGROUND",
			"CONNECTOR",
			"CREDENTIALS",
		]);
		for (const cap of Object.values(SETTINGS_WRITE_REGISTRY)) {
			if (cap.kind === "delegate") expect(allowed.has(cap.action)).toBe(true);
		}
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
		const capabilities = sections.find((s) => s.id === "capabilities");
		expect(capabilities).toMatchObject({ writable: true, via: "SETTINGS" });
		const updates = sections.find((s) => s.id === "updates");
		expect(updates).toMatchObject({ writable: false, via: "not-yet-wired" });
	});
});

describe("SETTINGS action: set on an owned route section", () => {
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

	it("refuses to write a read-only section", async () => {
		const { result, texts } = await invoke({
			action: "set",
			section: "runtime",
			value: "on",
		});
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("read-only");
	});

	it("refuses an unwired gap section with its stated reason", async () => {
		const { result, texts } = await invoke({
			action: "set",
			section: "updates",
			value: "on",
		});
		expect(result?.success).toBe(false);
		expect(texts.join(" ")).toContain("yet");
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
