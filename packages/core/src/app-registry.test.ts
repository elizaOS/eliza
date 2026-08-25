/**
 * Unit tests for curated Eliza app registry singleton.
 * Consolidated from colocated and __tests__/app-registry suites.
 * Preserves all unique assertions from both sources: defensive copy (not.toBe),
 * mutation isolation (push), and slug replacement semantics.
 */

import { describe, expect, it, vi } from "vitest";

const store: { entries: unknown[] } = { entries: [] };
vi.mock("./ambient-context", () => ({
	getAmbientSingleton: (_key: symbol, factory: () => unknown) => {
		if (!store.entries.length && factory) factory();
		return store;
	},
}));

import {
	type ElizaCuratedAppDefinition,
	getRegisteredCuratedApps,
	registerCuratedApp,
} from "./app-registry.js";

describe("app-registry", () => {
	it("registers and retrieves curated app definitions", () => {
		store.entries = [];
		const appDef: ElizaCuratedAppDefinition = {
			slug: "discord-bot",
			canonicalName: "@elizaos/plugin-discord",
			aliases: ["discord", "discord-app"],
		};

		registerCuratedApp(appDef);

		const apps = getRegisteredCuratedApps();
		const found = apps.find((app) => app.slug === "discord-bot");

		expect(found).toEqual(appDef);
	});

	it("updates existing app definition when registering with same slug", () => {
		store.entries = [];
		const originalDef: ElizaCuratedAppDefinition = {
			slug: "telegram-bot",
			canonicalName: "@elizaos/plugin-telegram",
			aliases: ["telegram"],
		};
		const updatedDef: ElizaCuratedAppDefinition = {
			slug: "telegram-bot",
			canonicalName: "@elizaos/plugin-telegram-v2",
			aliases: ["telegram", "tg"],
		};

		registerCuratedApp(originalDef);
		registerCuratedApp(updatedDef);

		const apps = getRegisteredCuratedApps();
		const matching = apps.filter((app) => app.slug === "telegram-bot");

		expect(matching).toHaveLength(1);
		expect(matching[0]).toEqual(updatedDef);
	});

	it("returns a defensive copy of the registered entries array", () => {
		store.entries = [];
		registerCuratedApp({ slug: "a", canonicalName: "A", aliases: [] });
		const apps1 = getRegisteredCuratedApps();
		const apps2 = getRegisteredCuratedApps();

		expect(apps1).not.toBe(apps2);
		expect(apps1).toEqual(apps2);
	});

	it("returns a copy so callers cannot mutate the store", () => {
		store.entries = [];
		registerCuratedApp({ slug: "chat", canonicalName: "Chat", aliases: [] });
		const apps = getRegisteredCuratedApps();
		apps.push({
			slug: "x",
			canonicalName: "X",
			aliases: [],
		} as ElizaCuratedAppDefinition);
		expect(getRegisteredCuratedApps()).toHaveLength(1);
		expect(getRegisteredCuratedApps().map((a) => a.slug)).toEqual(["chat"]);
	});

	it("replaces an existing slug on re-registration (canonicalName update)", () => {
		store.entries = [];
		registerCuratedApp({ slug: "chat", canonicalName: "Chat", aliases: [] });
		registerCuratedApp({
			slug: "chat",
			canonicalName: "Chat v2",
			aliases: ["c"],
		});
		const apps = getRegisteredCuratedApps();
		expect(apps).toHaveLength(1);
		expect(apps[0].canonicalName).toBe("Chat v2");
	});
});
