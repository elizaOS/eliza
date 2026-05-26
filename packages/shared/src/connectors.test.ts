import { describe, expect, it } from "vitest";

import {
	expandConnectorSourceFilter,
	getConnectorSourceAliases,
	normalizeConnectorSource,
	registerConnectorSourceAliases,
} from "./connectors";

describe("connector source aliases", () => {
	it("normalizes built-in connector aliases", () => {
		expect(normalizeConnectorSource(" discord-local ")).toBe("discord");
		expect(normalizeConnectorSource("BlueBubbles")).toBe("imessage");
		expect(getConnectorSourceAliases("telegram")).toEqual([
			"telegram",
			"telegram-account",
			"telegramaccount",
		]);
	});

	it("expands registered aliases without depending on @elizaos/core", () => {
		registerConnectorSourceAliases("custom", ["CustomAccount"]);

		expect(normalizeConnectorSource("customaccount")).toBe("custom");
		expect([...expandConnectorSourceFilter(["custom"])]).toEqual([
			"customaccount",
		]);
	});
});
