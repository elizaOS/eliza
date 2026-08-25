/**
 * Deterministic view-command matcher tests for explicit navigation phrases.
 */

import { DOCUMENTS_NAV_VOCABULARY } from "@elizaos/shared/views/shared-nav-targets";
import { describe, expect, it } from "vitest";
import {
	__matcherData,
	MATCHER_VIEW_IDS,
	matchViewCommand,
} from "./view-command-matcher.ts";

describe("matchViewCommand — explicit user examples", () => {
	const cases: Array<[string, string]> = [
		["open settings", "settings"],
		["open the vault", "vault"],
		["go to settings", "settings"],
		["go to settings view", "settings"],
		["show me the settings page", "settings"],
		["take me to my settings", "settings"],
		["settings", "settings"],
		["go home", "chat"],
		["home", "chat"],
		["go back", "chat"],
		["back to home", "chat"],
		["go back to notes", "notes"],
		["open the home dashboard", "chat"],
		["return to the main screen", "chat"],
		["open my calendar", "calendar"],
		["open calender", "calendar"],
		["could you switch to calender please", "calendar"],
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
		["open knowledge", "documents"],
		["open the knowledge base", "documents"],
		["show my knowledge hub", "documents"],
		["switch to focus mode", "focus"],
		["open my goals", "goals"],
		["open plugins", "plugins-page"],
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
		["abra aplicações na nuvem", "cloud-apps"],
		// fr
		["ouvre les paramètres", "settings"],
		["montre-moi mon calendrier", "calendar"],
		["ouvre applications cloud", "cloud-apps"],
		// de
		["öffne die einstellungen", "settings"],
		["öffne cloud-apps", "cloud-apps"],
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
		["클라우드 앱 열어줘", "cloud-apps"],
		// vi
		["mở cài đặt", "settings"],
		["mở ứng dụng đám mây", "cloud-apps"],
		// tl
		["buksan ang settings", "settings"],
	];
	for (const [text, view] of cases) {
		it(`"${text}" → ${view}`, () => {
			expect(matchViewCommand(text)).toBe(view);
		});
	}
});

describe("matchViewCommand — negated navigation", () => {
	const negatedCommands = [
		// English direct, indirect, punctuation, and typographic apostrophe forms.
		"do not open settings",
		"don't open settings",
		"don’t open settings",
		"I don't want to open settings",
		"don't try to open settings",
		"never ever open settings",
		"do not, under any circumstances, open settings",
		"do not open settings, open calendar",
		// The matcher is multilingual, so its side-effect guard must be too.
		"no abrir ajustes",
		"não abrir configurações",
		"ne pas ouvrir les paramètres",
		"n’ouvre pas les paramètres",
		"nicht öffnen die einstellungen",
		"öffne nicht die einstellungen",
		"不要打开设置",
		"別打開設定",
		"đừng mở cài đặt",
		"huwag buksan ang settings",
	] as const;

	it.each(negatedCommands)("%j stays in normal action planning", (text) => {
		expect(matchViewCommand(text)).toBeNull();
	});

	it("does not treat a negation prefix inside a word as negation", () => {
		expect(matchViewCommand("notable request: open settings")).toBe("settings");
	});

	it("does not carry negation across a sentence boundary", () => {
		expect(matchViewCommand("Never mind. Open settings")).toBe("settings");
	});

	it("does not confuse an unaccented Vietnamese noun with negation", () => {
		expect(matchViewCommand("open ung dung dam may")).toBe("cloud-apps");
	});
});

describe("matchViewCommand — localized Knowledge labels", () => {
	const cases = [
		["en", "Knowledge", "open Knowledge"],
		["es", "Conocimiento", "abre Conocimiento"],
		["pt", "Conhecimento", "abra Conhecimento"],
		["ja", "ナレッジ", "ナレッジを開いて"],
		["ko", "지식", "지식을 열어"],
		["vi", "Tri thức", "mở Tri thức"],
		["zh-CN", "知识", "打开知识"],
		["tl", "Kaalaman", "buksan ang Kaalaman"],
	] as const;

	it.each(cases)(
		"%s visible label %j routes to documents",
		(locale, label, text) => {
			expect(DOCUMENTS_NAV_VOCABULARY.localizedLabels[locale]).toBe(label);
			expect(matchViewCommand(text)).toBe("documents");
		},
	);
});

describe("matchViewCommand — Cloud Apps navigation arbitration", () => {
	const commands = [
		"open cloud apps",
		"please navigate to the cloud applications",
		"go to my deployed apps",
		"go to the app studio",
		"go to app deployments",
		"abre las aplicaciones en la nube",
		"abra aplicativos na nuvem",
		"ouvre les applications cloud",
		"öffne cloud-anwendungen",
		"打开云应用",
		"クラウドアプリを開いて",
		"클라우드 앱 열어",
		"mở ứng dụng đám mây",
	] as const;

	it.each(commands)("%j opens the Cloud Apps studio", (text) => {
		expect(matchViewCommand(text)).toBe("cloud-apps");
	});

	const inventoryOrNonNavigation = [
		"cloud apps",
		"my cloud apps",
		"list my cloud apps",
		"show my cloud apps",
		"list my deployed apps",
		"what cloud apps do I have?",
		"do not open cloud apps",
		"don't open cloud apps",
		"how do I open cloud apps?",
		"tell me how to open cloud apps",
		"if I open cloud apps, will I be charged?",
		"when I open cloud apps it crashes",
		"help me open cloud apps",
		"open cloud apps documentation",
		"open the cloud app Acme",
		"abre la documentación de aplicaciones en la nube",
		"云应用怎么打开",
	] as const;

	it.each(inventoryOrNonNavigation)(
		"%j stays in normal action planning",
		(text) => {
			expect(matchViewCommand(text)).toBeNull();
		},
	);
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
		if (viewId === "cloud-apps") continue;
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
		"open apps",
		"open my apps",
		"open applications",
		"showcase knowledge",
		"open knowledgebase",
		"open knowledgeable",
		"el conocimiento es poder",
		"abre conocimientos avanzados",
		"conhecimento é importante",
		"abra conhecimentos gerais",
		"ナレッジについて教えて",
		"ナレッジワーカーを開いて",
		"지식에 대해 설명해줘",
		"지식인을 열어",
		"tri thức rất quan trọng",
		"知识就是力量",
		"打开知识产权",
		"mahalaga ang kaalaman",
		"remind me to call mom", // a task, not a view command
		"how are you doing today",
		"back",
		"go back over the paragraph",
		"go back and explain what changed",
		"when I go back to school",
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
