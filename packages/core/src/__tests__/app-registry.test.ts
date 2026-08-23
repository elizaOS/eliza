import { describe, expect, it, vi } from "vitest";

const store: { entries: unknown[] } = { entries: [] };
vi.mock("./ambient-context", () => ({
	getAmbientSingleton: (_key: symbol, factory: () => unknown) => {
		if (!store.entries.length && factory) factory();
		return store;
	},
}));

import {
	getRegisteredCuratedApps,
	registerCuratedApp,
} from "./app-registry.ts";

describe("app-registry", () => {
	it("registers and returns curated apps", () => {
		registerCuratedApp({ slug: "chat", canonicalName: "Chat", aliases: [] });
		const apps = getRegisteredCuratedApps();
		expect(apps.map((a) => a.slug)).toEqual(["chat"]);
	});

	it("replaces an existing slug on re-registration", () => {
		registerCuratedApp({
			slug: "chat",
			canonicalName: "Chat v2",
			aliases: ["c"],
		});
		const apps = getRegisteredCuratedApps();
		expect(apps).toHaveLength(1);
		expect(apps[0].canonicalName).toBe("Chat v2");
	});

	it("returns a copy so callers cannot mutate the store", () => {
		const apps = getRegisteredCuratedApps();
		apps.push({ slug: "x", canonicalName: "X", aliases: [] });
		expect(getRegisteredCuratedApps()).toHaveLength(1);
	});
});
