/**
 * Unit tests for action search keyword extraction, stem conversion, and term matching.
 */

import { describe, expect, it } from "vitest";
import {
	actionNameToKeywordStem,
	countActionSearchKeywordMatches,
	getActionSearchKeywordSources,
	getActionSearchKeywordTerms,
} from "./action-search-keywords.js";

describe("action-search-keywords", () => {
	it("converts action names to camelCase keyword stems", () => {
		expect(actionNameToKeywordStem("SEND_MESSAGE")).toBe("sendMessage");
		expect(actionNameToKeywordStem("CREATE_TASK")).toBe("createTask");
		expect(actionNameToKeywordStem("webSearch")).toBe("webSearch");
		expect(actionNameToKeywordStem("   ")).toBe("");
	});

	it("extracts keyword sources for actions and associated contexts", () => {
		const sources = getActionSearchKeywordSources({
			name: "CREATE_TASK",
			contexts: ["tasks", "productivity"],
		});

		expect(Array.isArray(sources)).toBe(true);
		expect(sources.length).toBeGreaterThan(0);

		const keys = sources.map((s) => s.key);
		expect(
			keys.some(
				(k) =>
					k.includes("action.createTask") || k.includes("contextSignal.tasks"),
			),
		).toBe(true);

		for (const source of sources) {
			expect(typeof source.key).toBe("string");
			expect(Array.isArray(source.terms)).toBe(true);
			expect(source.terms.length).toBeGreaterThan(0);
		}
	});

	it("extracts deduplicated keyword terms", () => {
		const terms = getActionSearchKeywordTerms({
			name: "SEND_MESSAGE",
			contexts: ["messaging"],
		});

		expect(Array.isArray(terms)).toBe(true);
		expect(terms.length).toBeGreaterThan(0);

		const lowerTerms = terms.map((t) => t.toLowerCase());
		const unique = new Set(lowerTerms);
		expect(lowerTerms.length).toBe(unique.size);
	});

	it("counts keyword term matches against candidate texts", () => {
		const texts = ["Can you send a message to Alice?", "Check my email"];
		const terms = ["send", "message", "nonexistent"];

		const matchCount = countActionSearchKeywordMatches(texts, terms);
		expect(matchCount).toBe(2);
	});
});

describe("action-search-keywords resolution edge cases", () => {
	it("normalizes digit- and separator-delimited action names to keyword stems", () => {
		expect(actionNameToKeywordStem("send2FA-code")).toBe("send2FaCode");
		expect(actionNameToKeywordStem("-__ create--task __-")).toBe("createTask");
		expect(actionNameToKeywordStem("CREATE")).toBe("create");
		expect(actionNameToKeywordStem("")).toBe("");
	});

	it("returns no sources when neither the action name nor any context resolves", () => {
		expect(
			getActionSearchKeywordSources({ name: "definitelyNotARealActionXyz" }),
		).toEqual([]);
		expect(getActionSearchKeywordSources({ name: "" })).toEqual([]);
	});

	it("emits dotted source keys by recursing into nested keyword documents", () => {
		const sources = getActionSearchKeywordSources({ name: "create_task" });
		expect(sources.map((s) => s.key)).toContain("action.createTask.request");
	});

	it("lists the action stem's sources before context-derived sources", () => {
		const keys = getActionSearchKeywordSources({
			name: "CREATE_TASK",
			contexts: ["tasks"],
		}).map((s) => s.key);
		expect(keys.indexOf("action.createTask.request")).toBeGreaterThanOrEqual(0);
		expect(keys.indexOf("contextSignal.tasks.strong")).toBeGreaterThan(
			keys.indexOf("action.createTask.request"),
		);
	});

	it("deduplicates stems contributed by both the action name and multiple contexts", () => {
		const sources = getActionSearchKeywordSources({
			name: "CREATE_TASK",
			contexts: ["automation", "productivity", "tasks"],
		});
		expect(
			sources.filter((s) => s.key === "action.createTask.request").length,
		).toBe(1);
		expect(sources.map((s) => s.key)).toContain("contextSignal.tasks.strong");
	});

	it("normalizes context entries and ignores non-string or unknown values", () => {
		const keys = getActionSearchKeywordSources({
			name: "",
			contexts: ["  TASKS ", 42, null, "", false, "unknownContext"],
		}).map((s) => s.key);
		expect(keys).toEqual([
			"contextSignal.tasks.strong",
			"action.createTask.request",
			"action.manageTasks.request",
		]);
	});

	it("treats non-array context values as no contexts", () => {
		expect(
			getActionSearchKeywordSources({ name: "", contexts: "tasks" }),
		).toEqual([]);
		expect(
			getActionSearchKeywordSources({ name: "", contexts: { tasks: true } }),
		).toEqual([]);
	});

	it("includes locale terms by default and omits them when includeAllLocales is false", () => {
		const all = getActionSearchKeywordTerms({ name: "", contexts: ["tasks"] });
		expect(all[0]).toBe("task");
		expect(all).toContain("tarea");

		const baseOnly = getActionSearchKeywordTerms({
			name: "",
			contexts: ["tasks"],
			includeAllLocales: false,
		});
		expect(baseOnly).toContain("task");
		expect(baseOnly).not.toContain("tarea");
		expect(baseOnly.length).toBeLessThan(all.length);
	});

	it("merges a stem shared by multiple contexts into one set of sources", () => {
		const sendMessageKeys = getActionSearchKeywordSources({
			name: "",
			contexts: ["phone", "messaging"],
		})
			.map((s) => s.key)
			.filter((key) => key.startsWith("contextSignal.send_message."))
			.sort();
		expect(sendMessageKeys).toEqual([
			"contextSignal.send_message.strong",
			"contextSignal.send_message.weak",
		]);
	});

	it("deduplicates terms repeated across different sources case-insensitively", () => {
		const terms = getActionSearchKeywordTerms({
			name: "",
			contexts: ["tasks"],
		});
		expect(terms.filter((t) => t.toLowerCase() === "reminder").length).toBe(1);
	});

	it("counts unique matched terms and respects word boundaries", () => {
		expect(
			countActionSearchKeywordMatches(["buy milk"], ["milk", "milk"]),
		).toBe(1);
		expect(countActionSearchKeywordMatches([], ["milk"])).toBe(0);
		expect(countActionSearchKeywordMatches(["buy milk"], [])).toBe(0);
		expect(
			countActionSearchKeywordMatches(["PLEASE REPLY SOON"], ["reply"]),
		).toBe(1);
		expect(
			countActionSearchKeywordMatches(["forwarding this along"], ["forward"]),
		).toBe(0);
	});
});
