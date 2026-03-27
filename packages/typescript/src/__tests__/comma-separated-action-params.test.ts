/**
 * Regression test: action params must be extracted from standalone XML blocks
 * when the LLM outputs actions as a comma-separated list.
 *
 * The LLM may respond with:
 *   <actions>REPLY,START_CODING_TASK</actions>
 *   <START_CODING_TASK>
 *     <repo>https://github.com/org/repo</repo>
 *     <agents>claude:Fix auth | codex:Write tests</agents>
 *   </START_CODING_TASK>
 *
 * The XML parser puts "START_CODING_TASK" as a top-level key on parsedXml.
 * extractStandaloneActionParams collects these into the legacy flat format
 * that parseActionParams can consume downstream.
 */

import { describe, expect, it } from "vitest";
import { parseActionParams } from "../actions";
import {
	extractStandaloneActionParams,
	RESERVED_XML_KEYS,
} from "../services/message";

// ---------------------------------------------------------------------------
// extractStandaloneActionParams
// ---------------------------------------------------------------------------

describe("extractStandaloneActionParams", () => {
	it("extracts params from a matching parsedXml key", () => {
		const parsedXml = {
			actions: "REPLY,START_CODING_TASK",
			thought: "Spawning agents",
			START_CODING_TASK:
				"<repo>https://github.com/org/repo</repo><task>Fix it</task>",
		};
		const result = extractStandaloneActionParams(
			["REPLY", "START_CODING_TASK"],
			parsedXml,
		);
		expect(result).toContain("<START_CODING_TASK>");
		expect(result).toContain("<repo>https://github.com/org/repo</repo>");
		expect(result).toContain("<task>Fix it</task>");
	});

	it("matches action names case-insensitively", () => {
		const parsedXml = {
			start_coding_task: "<task>Fix</task>",
		};
		const result = extractStandaloneActionParams(
			["START_CODING_TASK"],
			parsedXml,
		);
		expect(result).toContain("<START_CODING_TASK>");
		expect(result).toContain("<task>Fix</task>");
	});

	it("skips reserved keys even if they match action names", () => {
		const parsedXml = {
			actions: "REPLY",
			thought: "something",
			text: "<bold>hello</bold>",
		};
		const result = extractStandaloneActionParams(
			["actions", "thought", "text"],
			parsedXml,
		);
		expect(result).toBe("");
	});

	it("skips keys that do not contain XML (plain text values)", () => {
		const parsedXml = {
			MY_ACTION: "just a plain string without XML",
		};
		const result = extractStandaloneActionParams(["MY_ACTION"], parsedXml);
		expect(result).toBe("");
	});

	it("handles multiple actions with params", () => {
		const parsedXml = {
			START_CODING_TASK: "<repo>https://github.com/org/repo</repo>",
			FINALIZE_WORKSPACE: "<workspaceId>ws-123</workspaceId>",
		};
		const result = extractStandaloneActionParams(
			["START_CODING_TASK", "FINALIZE_WORKSPACE"],
			parsedXml,
		);
		expect(result).toContain("<START_CODING_TASK>");
		expect(result).toContain("<FINALIZE_WORKSPACE>");
	});

	it("returns empty string when no matches found", () => {
		const result = extractStandaloneActionParams(["REPLY", "NONE"], {});
		expect(result).toBe("");
	});
});

// ---------------------------------------------------------------------------
// RESERVED_XML_KEYS
// ---------------------------------------------------------------------------

describe("RESERVED_XML_KEYS", () => {
	it("includes standard response schema fields", () => {
		expect(RESERVED_XML_KEYS.has("actions")).toBe(true);
		expect(RESERVED_XML_KEYS.has("thought")).toBe(true);
		expect(RESERVED_XML_KEYS.has("text")).toBe(true);
		expect(RESERVED_XML_KEYS.has("simple")).toBe(true);
		expect(RESERVED_XML_KEYS.has("providers")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseActionParams integration (end-to-end with the assembled format)
// ---------------------------------------------------------------------------

describe("parseActionParams with standalone action block format", () => {
	it("extracts params from assembled <ACTION_NAME>...</ACTION_NAME> format", () => {
		// This is the format that extractStandaloneActionParams produces
		const paramsXml = `<START_CODING_TASK>
			<repo>https://github.com/org/repo</repo>
			<agents>claude:Fix auth | codex:Write tests</agents>
			<task>Fix the login bug</task>
		</START_CODING_TASK>`;

		const result = parseActionParams(paramsXml);
		expect(result.has("START_CODING_TASK")).toBe(true);

		const params = result.get("START_CODING_TASK");
		expect(params).toBeTruthy();
		expect(params?.repo).toBe("https://github.com/org/repo");
		expect(params?.agents).toBe("claude:Fix auth | codex:Write tests");
		expect(params?.task).toBe("Fix the login bug");
	});

	it("handles multiple action blocks", () => {
		const paramsXml = `<START_CODING_TASK>
			<repo>https://github.com/org/repo</repo>
			<task>Fix bugs</task>
		</START_CODING_TASK>
		<FINALIZE_WORKSPACE>
			<workspaceId>ws-123</workspaceId>
		</FINALIZE_WORKSPACE>`;

		const result = parseActionParams(paramsXml);
		expect(result.has("START_CODING_TASK")).toBe(true);
		expect(result.has("FINALIZE_WORKSPACE")).toBe(true);
		expect(result.get("START_CODING_TASK")?.task).toBe("Fix bugs");
		expect(result.get("FINALIZE_WORKSPACE")?.workspaceId).toBe("ws-123");
	});

	it("returns empty map for empty input", () => {
		expect(parseActionParams("").size).toBe(0);
		expect(parseActionParams(undefined).size).toBe(0);
		expect(parseActionParams(null).size).toBe(0);
	});
});
