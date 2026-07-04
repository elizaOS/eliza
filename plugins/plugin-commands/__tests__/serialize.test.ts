/**
 * Unit tests for command serialization: projecting a CommandDefinition to its
 * wire shape (auth flags, dynamic-choice tagging, source labels) and the
 * per-surface visibility predicate.
 */
import { describe, expect, it } from "vitest";
import { getCatalogCommands } from "../src/connector-catalog";
import {
	findCommandByKey,
	initForRuntime,
	registerCommand,
	useRuntime,
} from "../src/registry";
import { commandVisibleForSurface, serializeCommand } from "../src/serialize";
import type { CommandDefinition } from "../src/types";

/**
 * serializeCommand is the single projection the route serves — it must carry
 * every field from the definition and fabricate nothing (#8790).
 */
describe("serializeCommand", () => {
	const def: CommandDefinition = {
		key: "model",
		nativeName: "model",
		description: "Set or show current model",
		textAliases: ["/model", "/m"],
		scope: "both",
		category: "options",
		acceptsArgs: true,
		args: [
			{
				name: "model",
				description: "provider/model or alias",
				dynamicChoices: "models",
			},
		],
		requiresAuth: false,
		surfaces: ["gui", "tui"],
		icon: "cpu",
	};

	it("projects every field from the definition, defaulting target to agent", () => {
		const wire = serializeCommand(def);
		expect(wire.key).toBe("model");
		expect(wire.nativeName).toBe("model");
		expect(wire.textAliases).toEqual(["/model", "/m"]);
		expect(wire.category).toBe("options");
		expect(wire.surfaces).toEqual(["gui", "tui"]);
		expect(wire.icon).toBe("cpu");
		expect(wire.target).toEqual({ kind: "agent" });
		expect(wire.source).toBe("builtin");
		expect(wire.acceptsArgs).toBe(true);
		expect(wire.args[0]?.dynamicChoices).toBe("models");
	});

	it("preserves requiresAuth / requiresElevated rather than hardcoding false", () => {
		const auth = serializeCommand({
			...def,
			key: "restart",
			requiresAuth: true,
			requiresElevated: true,
		});
		expect(auth.requiresAuth).toBe(true);
		expect(auth.requiresElevated).toBe(true);
	});

	it("drops function-valued choices but keeps the dynamic source tag", () => {
		const wire = serializeCommand({
			...def,
			args: [
				{
					name: "section",
					description: "section",
					choices: () => ["a", "b"],
					dynamicChoices: "settings-sections",
				},
			],
		});
		expect(wire.args[0]?.choices).toBeUndefined();
		expect(wire.args[0]?.dynamicChoices).toBe("settings-sections");
	});

	it("labels a custom source when asked", () => {
		expect(serializeCommand(def, { source: "saved" }).source).toBe("saved");
	});
});

describe("commandVisibleForSurface", () => {
	it("treats an undefined/empty surfaces list as all-surfaces", () => {
		expect(commandVisibleForSurface(undefined, "discord")).toBe(true);
		expect(commandVisibleForSurface([], "telegram")).toBe(true);
	});
	it("includes a command only on its declared surfaces", () => {
		expect(commandVisibleForSurface(["gui", "tui"], "gui")).toBe(true);
		expect(commandVisibleForSurface(["gui", "tui"], "discord")).toBe(false);
	});
	it("does not filter when surface is null/undefined", () => {
		expect(commandVisibleForSurface(["gui"], null)).toBe(true);
		expect(commandVisibleForSurface(["gui"], undefined)).toBe(true);
	});
});

/**
 * The catalog the route serves is the unified, surface-filtered, serialized
 * projection — agent + navigation + client commands in one shape.
 */
describe("getCatalogCommands (the route's projection)", () => {
	it("emits serialized agent commands with auth + category intact", () => {
		const gui = getCatalogCommands("gui");
		const restart = gui.find((c) => c.key === "restart");
		expect(restart?.requiresAuth).toBe(true);
		expect(restart?.target.kind).toBe("agent");
		const compact = gui.find((c) => c.key === "compact");
		expect(compact?.requiresAuth).toBe(true);
		const status = gui.find((c) => c.key === "status");
		expect(status?.category).toBe("status");
		expect(status?.source).toBe("builtin");
	});

	it("emits model dynamic choices from the registry definition", () => {
		const model = getCatalogCommands("gui").find((c) => c.key === "model");
		expect(model?.args[0]?.dynamicChoices).toBe("models");
	});

	it("emits navigation commands with a navigate target + deep link", () => {
		const settings = getCatalogCommands("gui").find(
			(c) => c.key === "settings",
		);
		expect(settings?.target.kind).toBe("navigate");
		expect(
			settings?.target.kind === "navigate" ? settings.target.path : null,
		).toBe("/settings");
		expect(settings?.args[0]?.dynamicChoices).toBe("settings-sections");
	});

	it("filters client commands off chat connectors by surface", () => {
		for (const surface of ["discord", "telegram"]) {
			const keys = new Set(getCatalogCommands(surface).map((c) => c.key));
			expect(keys.has("clear")).toBe(false);
			expect(keys.has("fullscreen")).toBe(false);
		}
		for (const surface of ["gui", "tui"]) {
			const keys = new Set(getCatalogCommands(surface).map((c) => c.key));
			expect(keys.has("clear")).toBe(true);
		}
	});

	it("never fabricates a hardcoded source/auth literal across the catalog", () => {
		const gui = getCatalogCommands("gui");
		// Every item has a concrete target kind and a source; auth reflects the def.
		for (const cmd of gui) {
			expect(["agent", "navigate", "client"]).toContain(cmd.target.kind);
			expect(cmd.source).toBe("builtin");
		}
		// The auth-required built-ins keep their flags (not all-false).
		expect(gui.some((c) => c.requiresAuth)).toBe(true);
	});

	it("projects the runtime-scoped command store, including toggles and custom commands", () => {
		initForRuntime("catalog-agent-a");
		useRuntime("catalog-agent-a");
		const restart = findCommandByKey("restart");
		if (!restart) throw new Error("missing restart command");
		restart.enabled = false;
		registerCommand({
			key: "skill-weather",
			description: "Answer weather questions with the weather skill",
			textAliases: ["/weather"],
			scope: "both",
			category: "skills",
			acceptsArgs: true,
		});

		const keys = new Set(
			getCatalogCommands("gui", { agentId: "catalog-agent-a" }).map(
				(command) => command.key,
			),
		);
		expect(keys.has("restart")).toBe(false);
		expect(keys.has("skill-weather")).toBe(true);

		initForRuntime("catalog-agent-b");
		const otherKeys = new Set(
			getCatalogCommands("gui", { agentId: "catalog-agent-b" }).map(
				(command) => command.key,
			),
		);
		expect(otherKeys.has("restart")).toBe(true);
		expect(otherKeys.has("skill-weather")).toBe(false);
	});
});
