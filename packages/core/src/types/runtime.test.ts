/**
 * Unit coverage for the runtime-value surface of `types/runtime.ts`: the
 * re-exported `SearchCategoryRegistryError` failure contract thrown by
 * `AgentRuntime.getSearchCategory` and matched by plugin catch sites, the
 * canonical message-target-kind list spread into action parameter schema
 * enums, and the connector account registries whose persisted token values
 * the connector account layer stores verbatim. Deterministic: pure module
 * imports, no runtime or database fixture.
 */
import { describe, expect, it } from "vitest";
import {
	CANONICAL_MESSAGE_TARGET_KINDS,
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
	SearchCategoryRegistryError,
} from "./runtime";

function assertCanonicalStringRegistry(
	label: string,
	registry: Record<string, string>,
): void {
	const entries = Object.entries(registry);
	expect(entries.length, `${label} exposes canonical entries`).toBeGreaterThan(
		0,
	);
	const values = entries.map(([, value]) => value);
	for (const value of values) {
		expect(
			typeof value === "string" && value.length > 0 && value.trim() === value,
			`${label} values are non-empty trimmed strings`,
		).toBe(true);
	}
	expect(new Set(values).size, `${label} values are unique`).toBe(
		values.length,
	);
}

describe("SearchCategoryRegistryError", () => {
	it("carries the not-found contract thrown by AgentRuntime.getSearchCategory", () => {
		const error = new SearchCategoryRegistryError(
			"SEARCH_CATEGORY_NOT_FOUND",
			"documents",
			"No search category registered for category: documents",
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(SearchCategoryRegistryError);
		expect(error.name).toBe("SearchCategoryRegistryError");
		expect(error.code).toBe("SEARCH_CATEGORY_NOT_FOUND");
		expect(error.category).toBe("documents");
		expect(error.message).toBe(
			"No search category registered for category: documents",
		);
	});

	it("carries the disabled contract including any disabled reason in the message", () => {
		const error = new SearchCategoryRegistryError(
			"SEARCH_CATEGORY_DISABLED",
			"archive",
			"Search category disabled: archive (migrated to knowledge graph)",
		);
		expect(error).toBeInstanceOf(SearchCategoryRegistryError);
		expect(error.name).toBe("SearchCategoryRegistryError");
		expect(error.code).toBe("SEARCH_CATEGORY_DISABLED");
		expect(error.category).toBe("archive");
		expect(error.message).toBe(
			"Search category disabled: archive (migrated to knowledge graph)",
		);
	});

	it("preserves code, category, and stack across a throw/catch round trip", () => {
		let caught: unknown;
		try {
			throw new SearchCategoryRegistryError(
				"SEARCH_CATEGORY_DISABLED",
				"news",
				"Search category disabled: news",
			);
		} catch (error) {
			caught = error;
		}
		if (!(caught instanceof SearchCategoryRegistryError)) {
			throw new Error("expected a SearchCategoryRegistryError instance");
		}
		expect(Object.hasOwn(caught, "code")).toBe(true);
		expect(Object.hasOwn(caught, "category")).toBe(true);
		expect(caught.code).toBe("SEARCH_CATEGORY_DISABLED");
		expect(caught.category).toBe("news");
		expect(typeof caught.stack).toBe("string");
		expect(caught.stack?.length ?? 0).toBeGreaterThan(0);
	});

	it("lets catch sites distinguish the two registry failure codes", () => {
		const notFound = new SearchCategoryRegistryError(
			"SEARCH_CATEGORY_NOT_FOUND",
			"transactions",
			"missing",
		);
		const disabled = new SearchCategoryRegistryError(
			"SEARCH_CATEGORY_DISABLED",
			"transactions",
			"off",
		);
		expect(notFound.code).not.toBe(disabled.code);
		expect(notFound.message).not.toBe(disabled.message);
		expect(notFound.category).toBe(disabled.category);
	});
});

describe("CANONICAL_MESSAGE_TARGET_KINDS", () => {
	it("is a duplicate-free list of trimmed non-empty kind tokens", () => {
		expect(CANONICAL_MESSAGE_TARGET_KINDS.length).toBeGreaterThan(0);
		for (const kind of CANONICAL_MESSAGE_TARGET_KINDS) {
			expect(
				kind.length > 0 && kind.trim() === kind,
				`kind ${JSON.stringify(kind)} is a trimmed non-empty token`,
			).toBe(true);
		}
		expect(new Set(CANONICAL_MESSAGE_TARGET_KINDS).size).toBe(
			CANONICAL_MESSAGE_TARGET_KINDS.length,
		);
	});

	it("spreads into an independent enum array for schema construction", () => {
		const spread = [...CANONICAL_MESSAGE_TARGET_KINDS];
		expect(spread).not.toBe(CANONICAL_MESSAGE_TARGET_KINDS);
		expect(spread).toEqual([...CANONICAL_MESSAGE_TARGET_KINDS]);
		expect(spread).toEqual(CANONICAL_MESSAGE_TARGET_KINDS);
	});

	it("pins the wire-stable kind taxonomy emitted into action parameter schemas", () => {
		expect([...CANONICAL_MESSAGE_TARGET_KINDS]).toEqual([
			"room",
			"channel",
			"thread",
			"user",
			"contact",
			"group",
			"server",
			"email",
			"phone",
		]);
	});
});

describe("connector account registries", () => {
	it("purpose persists lowercase machine tokens", () => {
		assertCanonicalStringRegistry(
			"ConnectorAccountPurpose",
			ConnectorAccountPurpose,
		);
		for (const value of Object.values(ConnectorAccountPurpose)) {
			expect(value).toBe(value.toLowerCase());
		}
	});

	it("role carries exactly the OWNER/AGENT/TEAM role model", () => {
		assertCanonicalStringRegistry("ConnectorAccountRole", ConnectorAccountRole);
		expect(Object.values(ConnectorAccountRole)).toEqual([
			"OWNER",
			"AGENT",
			"TEAM",
		]);
	});

	it("auth method carries the six supported credential mechanisms", () => {
		assertCanonicalStringRegistry("ConnectorAuthMethod", ConnectorAuthMethod);
		expect(Object.values(ConnectorAuthMethod)).toEqual([
			"OAUTH",
			"API_KEY",
			"BOT_TOKEN",
			"WEBHOOK",
			"SESSION",
			"NONE",
		]);
	});

	it("health carries the six account lifecycle states", () => {
		assertCanonicalStringRegistry(
			"ConnectorAccountHealth",
			ConnectorAccountHealth,
		);
		expect(Object.values(ConnectorAccountHealth)).toEqual([
			"UNKNOWN",
			"HEALTHY",
			"DEGRADED",
			"REAUTH_REQUIRED",
			"DISABLED",
			"ERROR",
		]);
	});
});
