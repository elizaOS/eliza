/**
 * Unit tests for the connector source registry: canonicalization of raw
 * source tags through owner-scoped alias/metadata registration, merge and
 * teardown semantics across owners (including the legacy Discord backstop),
 * passive classification, identity/world-id projection sanitization, and
 * source-filter expansion. Real module state, no mocks.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	expandConnectorSourceFilter,
	getConnectorIdentityMetadataMapping,
	getConnectorSourceAliases,
	getConnectorSourceMetadata,
	getConnectorWorldIdMetadataKeys,
	isPassiveConnectorSource,
	normalizeConnectorSource,
	registerConnectorSourceAliases,
	registerConnectorSourceDefinitions,
	registerConnectorSourceMetadata,
	unregisterConnectorSourceMetadataOwner,
} from "./connectors.ts";

const createdOwners: string[] = [];

function registerForOwner(
	owner: string,
	canonical: string,
	metadata: Parameters<typeof registerConnectorSourceMetadata>[1],
): void {
	if (!createdOwners.includes(owner)) {
		createdOwners.push(owner);
	}
	registerConnectorSourceMetadata(canonical, metadata, owner);
}

afterEach(() => {
	for (const owner of createdOwners.splice(0)) {
		unregisterConnectorSourceMetadataOwner(owner);
	}
});

describe("normalizeConnectorSource", () => {
	it("returns empty for nullish, non-string, blank, and whitespace input", () => {
		expect(normalizeConnectorSource(null)).toBe("");
		expect(normalizeConnectorSource(undefined)).toBe("");
		expect(normalizeConnectorSource(123 as unknown as string)).toBe("");
		expect(normalizeConnectorSource("")).toBe("");
		expect(normalizeConnectorSource("   ")).toBe("");
	});

	it("returns the trimmed lowercase value for unregistered sources", () => {
		expect(normalizeConnectorSource("  Slack ")).toBe("slack");
	});

	it("resolves registered aliases to their canonical source", () => {
		registerForOwner("lane-test:normalize", "lanesrca", {
			aliases: ["LaneA"],
		});
		expect(normalizeConnectorSource("lanea")).toBe("lanesrca");
		expect(normalizeConnectorSource("LANESRCA")).toBe("lanesrca");
		expect(normalizeConnectorSource("  LaneA  ")).toBe("lanesrca");
	});

	it("maps discord to its canonical form via the module-load backstop", () => {
		expect(normalizeConnectorSource("discord")).toBe("discord");
	});
});

describe("legacy Discord default registration", () => {
	it("exposes the documented identity projection without manual registration", () => {
		expect(getConnectorIdentityMetadataMapping("discord")).toEqual({
			userIdField: "fromId",
			nameField: "entityName",
		});
	});

	it("exposes the ordered world-id derivation keys", () => {
		expect(getConnectorWorldIdMetadataKeys("discord")).toEqual([
			"discordServerId",
			"discordChannelId",
		]);
	});

	it("is restored when an overriding plugin owner unregisters", () => {
		registerForOwner("lane-test:discord-plugin", "discord", {
			identityMetadataMapping: { userIdField: "pluginUserId" },
			worldIdMetadataKeys: ["pluginGuildId"],
		});
		expect(getConnectorIdentityMetadataMapping("discord")).toEqual({
			userIdField: "pluginUserId",
		});

		unregisterConnectorSourceMetadataOwner("lane-test:discord-plugin");

		expect(getConnectorIdentityMetadataMapping("discord")).toEqual({
			userIdField: "fromId",
			nameField: "entityName",
		});
		expect(getConnectorWorldIdMetadataKeys("discord")).toEqual([
			"discordServerId",
			"discordChannelId",
		]);
	});
});

describe("registerConnectorSourceMetadata", () => {
	it("always includes the canonical key in the alias set", () => {
		registerForOwner("lane-test:aliases", "lanesrcb", {
			aliases: ["Bee"],
		});
		const aliases = getConnectorSourceAliases("lanesrcb");
		expect(aliases).toContain("lanesrcb");
		expect(aliases).toContain("bee");
		expect(aliases).toHaveLength(2);
	});

	it("accumulates aliases across repeated registrations instead of replacing them", () => {
		registerForOwner("lane-test:accumulate", "lanesrcc", {
			aliases: ["first"],
		});
		registerConnectorSourceMetadata(
			"lanesrcc",
			{ aliases: ["second"] },
			"lane-test:accumulate",
		);
		const aliases = getConnectorSourceAliases("lanesrcc");
		expect(aliases).toHaveLength(3);
		expect(aliases).toEqual(
			expect.arrayContaining(["lanesrcc", "first", "second"]),
		);
	});

	it("normalizes and dedupes incoming aliases", () => {
		registerForOwner("lane-test:dedupe", "lanesrcd", {
			aliases: ["  Foo ", "foo", "BAR"],
		});
		expect(getConnectorSourceAliases("lanesrcd")).toEqual([
			"lanesrcd",
			"foo",
			"bar",
		]);
	});

	it("ignores registrations with a blank canonical key", () => {
		registerConnectorSourceMetadata("   ", { aliases: ["ghost"] });
		expect(normalizeConnectorSource("ghost")).toBe("ghost");
		expect(getConnectorSourceMetadata("ghost")?.aliases).toEqual([]);
	});

	it("defaults a whitespace-only owner to the manual owner scope", () => {
		registerConnectorSourceMetadata(
			"lanesrce",
			{ sourceKind: "passive" },
			"  ",
		);
		expect(isPassiveConnectorSource("lanesrce")).toBe(true);
		unregisterConnectorSourceMetadataOwner("manual");
		expect(isPassiveConnectorSource("lanesrce")).toBe(false);
	});

	it("preserves fields omitted by a same-owner re-registration", () => {
		registerForOwner("lane-test:update", "lanesrcf", {
			sourceKind: "active",
			isPassive: false,
			aliases: ["old"],
		});
		registerConnectorSourceMetadata(
			"lanesrcf",
			{ aliases: ["new"] },
			"lane-test:update",
		);
		expect(getConnectorSourceAliases("lanesrcf")).toEqual([
			"lanesrcf",
			"old",
			"new",
		]);
		expect(isPassiveConnectorSource("lanesrcf")).toBe(false);
	});
});

describe("owner-scoped merge semantics", () => {
	it("unions aliases contributed by different owners of one canonical", () => {
		registerForOwner("lane-test:merge-a", "lanesrcg", { aliases: ["from-a"] });
		registerForOwner("lane-test:merge-b", "lanesrcg", { aliases: ["from-b"] });
		expect(getConnectorSourceAliases("lanesrcg")).toEqual([
			"lanesrcg",
			"from-a",
			"from-b",
		]);
	});

	it("lets the later-registered owner override scalar fields, with fallback on teardown", () => {
		registerForOwner("lane-test:scalar-a", "lanesrch", {
			sourceKind: "active",
		});
		expect(isPassiveConnectorSource("lanesrch")).toBe(false);

		registerForOwner("lane-test:scalar-b", "lanesrch", {
			sourceKind: "passive",
		});
		expect(isPassiveConnectorSource("lanesrch")).toBe(true);

		unregisterConnectorSourceMetadataOwner("lane-test:scalar-b");
		expect(isPassiveConnectorSource("lanesrch")).toBe(false);
	});
});

describe("unregisterConnectorSourceMetadataOwner", () => {
	it("removes only the named owner's contributions", () => {
		registerForOwner("lane-test:teardown-a", "lanesrci", {
			aliases: ["i-one"],
		});
		registerForOwner("lane-test:teardown-b", "lanesrcj", {
			aliases: ["j-one"],
		});

		unregisterConnectorSourceMetadataOwner("lane-test:teardown-a");

		expect(getConnectorSourceAliases("i-one")).toEqual(["i-one"]);
		expect(normalizeConnectorSource("i-one")).toBe("i-one");
		expect(normalizeConnectorSource("j-one")).toBe("lanesrcj");
	});

	it("ignores blank owners and unknown owners without throwing", () => {
		expect(() => unregisterConnectorSourceMetadataOwner("   ")).not.toThrow();
		expect(() =>
			unregisterConnectorSourceMetadataOwner("lane-test:never-registered"),
		).not.toThrow();
	});
});

describe("registerConnectorSourceDefinitions", () => {
	it("registers each definition with its metadata under the given owner", () => {
		registerForOwner("lane-test:defs", "__placeholder__", {});
		registerConnectorSourceDefinitions(
			[
				{
					source: "lanesrck",
					sourceKind: "passive",
					identityMetadataMapping: { userIdField: "kUserId" },
				},
				{ source: "LanesrcL ", worldIdMetadataKeys: [" lKey "] },
			],
			"lane-test:defs",
		);
		expect(isPassiveConnectorSource("lanesrck")).toBe(true);
		expect(getConnectorIdentityMetadataMapping("lanesrck")).toEqual({
			userIdField: "kUserId",
		});
		expect(normalizeConnectorSource("lanesrcl")).toBe("lanesrcl");
		expect(getConnectorWorldIdMetadataKeys("lanesrcl")).toEqual(["lKey"]);
	});

	it("treats null, undefined, and empty batches as no-ops", () => {
		expect(() =>
			registerConnectorSourceDefinitions(null, "lane-test:null"),
		).not.toThrow();
		expect(() =>
			registerConnectorSourceDefinitions(undefined, "lane-test:null"),
		).not.toThrow();
		expect(() =>
			registerConnectorSourceDefinitions([], "lane-test:null"),
		).not.toThrow();
		expect(getConnectorSourceMetadata("lane-test:null")?.aliases).toEqual([]);
	});
});

describe("registerConnectorSourceAliases", () => {
	it("registers aliases through the metadata path under the default owner", () => {
		registerConnectorSourceAliases("lanesrcu", ["UOne"]);
		expect(normalizeConnectorSource("uone")).toBe("lanesrcu");
		expect(getConnectorSourceAliases("LANESRCU")).toEqual(["lanesrcu", "uone"]);
		unregisterConnectorSourceMetadataOwner("manual");
		expect(normalizeConnectorSource("uone")).toBe("uone");
	});
});

describe("getConnectorSourceAliases", () => {
	it("returns empty for missing input and itself for unknown sources", () => {
		expect(getConnectorSourceAliases(null)).toEqual([]);
		expect(getConnectorSourceAliases(undefined)).toEqual([]);
		expect(getConnectorSourceAliases("   ")).toEqual([]);
		expect(getConnectorSourceAliases("unknownsrc")).toEqual(["unknownsrc"]);
	});
});

describe("getConnectorSourceMetadata", () => {
	it("returns null for missing input and an empty metadata shell for unknown sources", () => {
		expect(getConnectorSourceMetadata(null)).toBeNull();
		expect(getConnectorSourceMetadata(undefined)).toBeNull();
		expect(getConnectorSourceMetadata("never-registered-src")).toEqual({
			aliases: [],
			sourceKind: undefined,
			isPassive: undefined,
			identityMetadataMapping: undefined,
			worldIdMetadataKeys: undefined,
		});
	});

	it("returns the merged metadata for a registered source", () => {
		registerForOwner("lane-test:meta", "lanesrcm", {
			sourceKind: "passive",
			worldIdMetadataKeys: ["mKey"],
		});
		expect(getConnectorSourceMetadata("LANESRCM")).toEqual({
			aliases: ["lanesrcm"],
			sourceKind: "passive",
			isPassive: undefined,
			identityMetadataMapping: undefined,
			worldIdMetadataKeys: ["mKey"],
		});
	});
});

describe("isPassiveConnectorSource", () => {
	it("classifies passive via either isPassive or sourceKind", () => {
		registerForOwner("lane-test:passive", "lanesrcn", { isPassive: true });
		registerForOwner("lane-test:kind", "lanesrco", { sourceKind: "passive" });
		registerForOwner("lane-test:active", "lanesrcp", {
			isPassive: false,
			sourceKind: "active",
		});
		expect(isPassiveConnectorSource("lanesrcn")).toBe(true);
		expect(isPassiveConnectorSource("lanesrco")).toBe(true);
		expect(isPassiveConnectorSource("lanesrcp")).toBe(false);
		expect(isPassiveConnectorSource("unknown-passive-src")).toBe(false);
		expect(isPassiveConnectorSource(null)).toBe(false);
	});
});

describe("getConnectorIdentityMetadataMapping", () => {
	it("returns null when nothing was registered", () => {
		expect(getConnectorIdentityMetadataMapping("no-mapping-src")).toBeNull();
	});

	it("returns null when userIdField is missing, blank, or not a string", () => {
		registerForOwner("lane-test:idmap", "lanesrcq", {
			identityMetadataMapping: { userIdField: "   " },
		});
		expect(getConnectorIdentityMetadataMapping("lanesrcq")).toBeNull();

		registerConnectorSourceMetadata(
			"lanesrcq",
			{
				identityMetadataMapping: {
					userIdField: 42 as unknown as string,
				},
			},
			"lane-test:idmap",
		);
		expect(getConnectorIdentityMetadataMapping("lanesrcq")).toBeNull();
	});

	it("trims declared fields and omits a blank nameField from the result", () => {
		registerForOwner("lane-test:idmap-trim", "lanesrcr", {
			identityMetadataMapping: {
				userIdField: " rUserId ",
				nameField: "  ",
			},
		});
		expect(getConnectorIdentityMetadataMapping("lanesrcr")).toEqual({
			userIdField: "rUserId",
		});

		registerConnectorSourceMetadata(
			"lanesrcr",
			{
				identityMetadataMapping: {
					userIdField: "rUserId",
					nameField: " rName ",
				},
			},
			"lane-test:idmap-trim",
		);
		expect(getConnectorIdentityMetadataMapping("lanesrcr")).toEqual({
			userIdField: "rUserId",
			nameField: "rName",
		});
	});
});

describe("getConnectorWorldIdMetadataKeys", () => {
	it("returns an empty array when none were declared", () => {
		expect(getConnectorWorldIdMetadataKeys("no-worldid-src")).toEqual([]);
	});

	it("drops non-string and blank entries while preserving declaration order", () => {
		registerForOwner("lane-test:worldid", "lanesrcs", {
			worldIdMetadataKeys: [
				" sOne ",
				42 as unknown as string,
				"",
				"sTwo",
				null as unknown as string,
			],
		});
		expect(getConnectorWorldIdMetadataKeys("lanesrcs")).toEqual([
			"sOne",
			"sTwo",
		]);
	});
});

describe("expandConnectorSourceFilter", () => {
	it("returns an empty set for nullish input", () => {
		expect(expandConnectorSourceFilter(null).size).toBe(0);
		expect(expandConnectorSourceFilter(undefined).size).toBe(0);
	});

	it("expands every entry to its canonical plus aliases, deduped across entries", () => {
		registerForOwner("lane-test:expand", "lanesrct", { aliases: ["Tee"] });
		const expanded = expandConnectorSourceFilter([
			"LanesrcT",
			"tee",
			"unknownsrc",
		]);
		expect([...expanded].sort()).toEqual(["lanesrct", "tee", "unknownsrc"]);
	});
});
