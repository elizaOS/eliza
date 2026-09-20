/**
 * Unit tests for action catalog assembly, normalization, sub-action resolution, and search text extraction.
 */

import { describe, expect, it } from "vitest";
import {
	actionEntryKeywordText,
	actionEntrySearchText,
	buildActionCatalog,
	normalizeActionName,
	type RuntimeActionLike,
} from "./action-catalog.js";

describe("action-catalog", () => {
	it("can omit search-only work without changing discovery or localized examples", () => {
		let schemaTraversals = 0;
		const parameters = {
			get nested() {
				schemaTraversals++;
				return { description: "Complete schema stays available" };
			},
		};
		const actions: RuntimeActionLike[] = [
			{
				name: "NOTES",
				description: "  Complete notes description Ω\n",
				descriptionCompressed: "Find notes",
				routingHint: "  Read and write notes  ",
				subActions: ["NOTES_GET", "NOTES_GET", "MISSING", { name: "INLINE" }],
			},
			{
				name: "NOTES_GET",
				description: "Read exact original",
				contexts: ["notes"],
				similes: ["read note"],
				tags: ["read"],
				parameters,
				examples: [
					[
						{ name: "user", content: { text: "read" } },
						{ name: "agent", content: { text: "note" } },
					],
				],
			},
			{ name: "notes_get", description: "Ignored duplicate" },
		];
		const localizedExamples = () =>
			[
				{ name: "user", content: { text: "leer" } },
				{ name: "agent", content: { text: "nota" } },
			] as const;
		const discovery = buildActionCatalog(actions, {
			includeSearchMetadata: false,
			localizedExamples,
		});
		expect(schemaTraversals).toBe(0);
		const searchable = buildActionCatalog(actions, { localizedExamples });
		expect(schemaTraversals).toBeGreaterThan(0);
		expect(searchable.childByName.get("NOTES_GET")?.searchText).toContain(
			"Complete schema",
		);
		const omitSearch = (value: unknown) =>
			JSON.parse(
				JSON.stringify(value, (key, item) =>
					[
						"keywordKeys",
						"keywordText",
						"keywordSources",
						"searchText",
					].includes(key)
						? undefined
						: item,
				),
			);
		expect(omitSearch(discovery)).toEqual(omitSearch(searchable));
		expect([...discovery.parentByName.keys()]).toEqual([
			...searchable.parentByName.keys(),
		]);
		expect([...discovery.childByName.keys()]).toEqual([
			...searchable.childByName.keys(),
		]);
		const child = discovery.childByName.get("NOTES_GET");
		expect(child?.source).toBe(actions[1]);
		expect(child?.parameters).toBe(parameters);
		expect(child?.examples).toEqual([localizedExamples()]);
	});

	it("normalizes action names to uppercase underscore-delimited format", () => {
		expect(normalizeActionName("sendMessage")).toBe("SEND_MESSAGE");
		expect(normalizeActionName("send_message")).toBe("SEND_MESSAGE");
		expect(normalizeActionName("create-task")).toBe("CREATE_TASK");
		expect(normalizeActionName("   fooBarBaz   ")).toBe("FOO_BAR_BAZ");
	});

	it("builds an action catalog with parents and resolved sub-actions", () => {
		const subAction: RuntimeActionLike = {
			name: "SUB_TASK",
			description: "Sub task handler",
		};

		const parentAction: RuntimeActionLike = {
			name: "PARENT_TASK",
			description: "Parent orchestrator",
			subActions: [subAction],
			tags: ["orchestrator"],
		};

		const otherAction: RuntimeActionLike = {
			name: "OTHER_ACTION",
			description: "Standalone action",
		};

		const catalog = buildActionCatalog([parentAction, otherAction]);

		expect(catalog.parents.length).toBeGreaterThanOrEqual(2);
		const parent = catalog.parentByName.get("PARENT_TASK");
		expect(parent).toBeDefined();
		expect(parent?.children).toHaveLength(1);
		expect(parent?.children[0].name).toBe("SUB_TASK");

		expect(catalog.warnings).toHaveLength(0);
	});

	it("emits warnings for duplicate or missing sub-actions", () => {
		const invalidSubRefAction: RuntimeActionLike = {
			name: "BROKEN_PARENT",
			description: "References nonexistent child",
			subActions: ["NONEXISTENT_CHILD"],
		};

		const duplicateActions: RuntimeActionLike[] = [
			{ name: "DUPLICATE_NAME", description: "First" },
			{ name: "duplicate_name", description: "Second" },
		];

		const catalog = buildActionCatalog([
			invalidSubRefAction,
			...duplicateActions,
		]);

		expect(catalog.warnings.some((w) => w.code === "MISSING_SUB_ACTION")).toBe(
			true,
		);
		expect(catalog.warnings.some((w) => w.code === "DUPLICATE_ACTION")).toBe(
			true,
		);
	});

	it("extracts searchable text and keyword text for catalog entries", () => {
		const action: RuntimeActionLike = {
			name: "SEND_EMAIL",
			description: "Sends an email to recipient",
			tags: ["communication", "mail"],
			similes: ["dispatchEmail", "postMail"],
		};

		const searchText = actionEntrySearchText(action);
		expect(searchText).toContain("SEND_EMAIL");
		expect(searchText).toContain("Sends an email to recipient");
		expect(searchText).toContain("communication");
		expect(searchText).toContain("dispatchEmail");

		const keywordText = actionEntryKeywordText(action);
		expect(typeof keywordText).toBe("string");
	});
});
