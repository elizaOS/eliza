/**
 * Deterministic view-command matcher tests for explicit navigation phrases.
 */

import { describe, expect, it } from "vitest";
import {
	__matcherData,
	MATCHER_VIEW_IDS,
	matchViewCommand,
} from "./view-command-matcher.ts";

describe("matchViewCommand — explicit user examples", () => {
	const cases: Array<[string, string]> = [
		["open settings", "settings"],
		["go to settings", "settings"],
		["go to settings view", "settings"],
		["show me the settings page", "settings"],
		["take me to my settings", "settings"],
		["settings", "settings"],
		["go home", "chat"],
		["home", "chat"],
		["back to home", "chat"],
		["open the home dashboard", "chat"],
		["return to the main screen", "chat"],
		["open my calendar", "calendar"],
		["go to my inbox", "inbox"],
		["show my wallet", "wallet"],
		["open the todos view", "todos"],
		["open notes", "notes"],
		["show my notes", "notes"],
		["pull up my notes", "notes"],
		["open the sticky notes view", "notes"],
		["pull up my documents", "documents"],
		["open docs", "documents"],
		["show my files", "documents"],
		["switch to focus mode", "focus"],
		["open my goals", "goals"],
		// coding cockpit — wins over task-coordinator's bare "coding"
		["open the cockpit", "cockpit"],
		["open coding cockpit", "cockpit"],
		["show me my agents", "cockpit"],
		["go to my agents view", "cockpit"],
	];
	for (const [text, view] of cases) {
		it(`"${text}" → ${view}`, () => {
			expect(matchViewCommand(text)).toBe(view);
		});
	}
});

describe("matchViewCommand — multilingual", () => {
	const cases: Array<[string, string]> = [
		// es
		["abre ajustes", "settings"],
		["muéstrame mi calendario", "calendar"],
		["abre mi correo", "inbox"],
		["ir a mi cartera", "wallet"],
		// pt
		["abrir configurações", "settings"],
		["mostre meu calendário", "calendar"],
		// fr
		["ouvre les paramètres", "settings"],
		["montre-moi mon calendrier", "calendar"],
		// de
		["öffne die einstellungen", "settings"],
		// zh
		["打开设置", "settings"],
		["打开我的钱包", "wallet"],
		["显示日历", "calendar"],
		// ja
		["設定を開いて", "settings"],
		["カレンダーを表示して", "calendar"],
		// ko
		["설정 열어", "settings"],
		["내 캘린더 보여줘", "calendar"],
		["지갑 열어줘", "wallet"],
		// vi
		["mở cài đặt", "settings"],
		// tl
		["buksan ang settings", "settings"],
	];
	for (const [text, view] of cases) {
		it(`"${text}" → ${view}`, () => {
			expect(matchViewCommand(text)).toBe(view);
		});
	}
});

describe("matchViewCommand — generated verb×view coverage (English)", () => {
	const verbs = [
		"open",
		"go to",
		"show me",
		"take me to",
		"navigate to",
		"switch to",
	];
	for (const viewId of MATCHER_VIEW_IDS) {
		// Use the first English-ish noun (index 0 is the canonical English term).
		const noun = __matcherData.VIEW_NOUNS[viewId][0];
		for (const verb of verbs) {
			it(`"${verb} ${noun}" → ${viewId}`, () => {
				expect(matchViewCommand(`${verb} ${noun}`)).toBe(viewId);
			});
		}
	}
});

describe("matchViewCommand — precision (must NOT match)", () => {
	const negatives = [
		"what's the weather like today",
		"tell me a joke",
		"what is the capital of France",
		"thanks, that was helpful",
		"can you summarize this article",
		"i love using this app",
		"remind me to call mom", // a task, not a view command
		"how are you doing today",
		"",
		"   ",
	];
	for (const text of negatives) {
		it(`"${text}" → null`, () => {
			expect(matchViewCommand(text)).toBeNull();
		});
	}
});

describe("matchViewCommand — does not over-match very long text", () => {
	it("a long sentence merely mentioning a noun is rejected", () => {
		expect(
			matchViewCommand(
				"I was thinking earlier about how the configuration of modern software has become so complicated that nobody really understands all the options anymore and it makes me sad",
			),
		).toBeNull();
	});
});
