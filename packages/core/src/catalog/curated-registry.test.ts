import { afterEach, describe, expect, it } from "vitest";
import * as catalog from "../index.js";
import {
	getElizaCuratedAppDefinition,
	getRegisteredCuratedApps,
	registerCuratedApp,
} from "./apps.js";

const key = Symbol.for("elizaos.curated-app-registry");
const slot = globalThis as Record<PropertyKey, unknown>;
const original = Object.getOwnPropertyDescriptor(slot, key);

afterEach(() => {
	if (original) Object.defineProperty(slot, key, original);
	else delete slot[key];
});

describe("canonical curated app registration", () => {
	it("shares registration, replacement, and lookup through the public barrel and catalog owner", () => {
		slot[key] = { entries: [] };
		expect(catalog.registerCuratedApp).toBe(registerCuratedApp);
		expect(catalog.getRegisteredCuratedApps).toBe(getRegisteredCuratedApps);
		const app = {
			slug: "catalog-root-fixture",
			canonicalName: "Catalog Root Fixture",
			aliases: ["catalog-root-alias"],
		};
		catalog.registerCuratedApp(app);
		expect(getRegisteredCuratedApps()).toEqual([app]);
		expect(getElizaCuratedAppDefinition("catalog-root-alias")).toBe(app);
		const replacement = { ...app, canonicalName: "Updated Catalog Fixture" };
		registerCuratedApp(replacement);
		expect(catalog.getRegisteredCuratedApps()).toEqual([replacement]);
		expect(getElizaCuratedAppDefinition(app.slug)).toBe(replacement);
		const snapshot = catalog.getRegisteredCuratedApps();
		snapshot.length = 0;
		expect(getRegisteredCuratedApps()).toEqual([replacement]);
	});
});
