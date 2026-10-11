/**
 * Covers `retrieveCapabilities` intent tokenization for text outside ASCII:
 * accented Latin, Cyrillic and CJK intents must match catalog keywords in the
 * same script, and an ASCII intent must keep its existing ranking.
 */

import { describe, expect, it } from "vitest";
import {
	type CapabilityCatalogEntry,
	retrieveCapabilities,
	tokenizeCapabilityIntent,
} from "../src/capabilities/retrieval.ts";

const catalog: CapabilityCatalogEntry[] = [
	{
		capabilityId: "calendar.create_event",
		domain: "calendar",
		summary: "Create a calendar event",
		keywords: ["calendar", "événement", "календарь", "日历"],
		operations: ["create"],
		promptTokenEstimate: 10,
	},
	{
		capabilityId: "mail.send",
		domain: "mail",
		summary: "Send an email",
		keywords: ["email"],
		operations: ["send"],
		promptTokenEstimate: 10,
	},
];

function topIds(intentText: string): string[] {
	return retrieveCapabilities({ catalog, intentText }).results.map(
		(match) => match.entry.capabilityId,
	);
}

describe("capability retrieval tokenization outside ASCII", () => {
	it("keeps accented words whole", () => {
		expect(tokenizeCapabilityIntent("Créer un événement")).toEqual([
			"créer",
			"un",
			"événement",
		]);
	});

	it("matches accented, Cyrillic and CJK keywords", () => {
		expect(topIds("créer un événement")).toEqual(["calendar.create_event"]);
		expect(topIds("открой календарь")).toEqual(["calendar.create_event"]);
		expect(topIds("日历")).toEqual(["calendar.create_event"]);
	});

	it("matches a decomposed accent against a composed keyword", () => {
		expect(topIds("e\u0301ve\u0301nement")).toEqual(["calendar.create_event"]);
	});

	it("keeps the ASCII ranking unchanged", () => {
		expect(topIds("create calendar event")).toEqual(["calendar.create_event"]);
		expect(topIds("send an email")).toEqual(["mail.send"]);
	});
});
