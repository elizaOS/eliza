/**
 * Unit tests for curated Eliza app registry singleton.
 */

import { describe, expect, it } from "vitest";
import {
	type ElizaCuratedAppDefinition,
	getRegisteredCuratedApps,
	registerCuratedApp,
} from "./app-registry.js";

describe("app-registry", () => {
	it("registers and retrieves curated app definitions", () => {
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
		const apps1 = getRegisteredCuratedApps();
		const apps2 = getRegisteredCuratedApps();

		expect(apps1).not.toBe(apps2);
		expect(apps1).toEqual(apps2);
	});
});
