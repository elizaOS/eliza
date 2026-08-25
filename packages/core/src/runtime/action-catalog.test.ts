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
