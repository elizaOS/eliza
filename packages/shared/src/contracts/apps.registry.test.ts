/** Exercises registration, replacement and defensive reads through the real ambient registry. */
import { expect, it } from "vitest";
import {
	type ElizaCuratedAppDefinition,
	getRegisteredCuratedApps,
	registerCuratedApp,
} from "./apps.js";

it("replaces a registered slug without changing other apps or exposing its entries array", () => {
	const original: ElizaCuratedAppDefinition = {
		slug: "registry-test-chat",
		canonicalName: "Chat",
		aliases: ["chat"],
	};
	const unrelated = { ...original, slug: "registry-test-calendar" };
	registerCuratedApp(original);
	registerCuratedApp(unrelated);
	expect(getRegisteredCuratedApps()).toEqual(
		expect.arrayContaining([original, unrelated]),
	);

	const replacement = { ...original, canonicalName: "Chat v2", aliases: ["c"] };
	registerCuratedApp(replacement);
	const snapshot = getRegisteredCuratedApps();
	expect(snapshot.filter((app) => app.slug === original.slug)).toEqual([
		replacement,
	]);
	expect(snapshot).toContainEqual(unrelated);
	snapshot.splice(0);
	expect(getRegisteredCuratedApps()).toEqual(
		expect.arrayContaining([replacement, unrelated]),
	);
});
