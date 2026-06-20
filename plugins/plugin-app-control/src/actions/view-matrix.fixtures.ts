/**
 * @module plugin-app-control/actions/view-matrix.fixtures
 * @description Single source of truth for the view-switching test matrix (#8797).
 *
 * The exhaustive multilingual coverage is DERIVED from `__matcherData` so it can
 * never silently drift: adding a noun to `VIEW_NOUNS` (in any of the 10 matcher
 * languages) automatically adds it to the recall matrix; adding a navigable view
 * forces it to appear here. On top of that derived matrix, a small set of curated
 * fully-in-language phrases and per-language negative controls give the
 * renderer/scenario layers human-readable cells.
 *
 * Languages supported by the matcher: en, es, pt, fr, de, zh, ja, ko, vi, tl.
 */
import { __matcherData, MATCHER_VIEW_IDS } from "./view-command-matcher.js";

/** Matcher-supported languages (a superset of the shipped UI locales). */
export const MATRIX_LANGUAGES = [
	"en",
	"es",
	"pt",
	"fr",
	"de",
	"zh",
	"ja",
	"ko",
	"vi",
	"tl",
] as const;
export type MatrixLanguage = (typeof MATRIX_LANGUAGES)[number];

/** The trigger modalities every navigable view should be reachable through. */
export const MATRIX_MODALITIES = [
	"text",
	"voice-transcript",
	"slash",
	"deep-link",
] as const;
export type MatrixModality = (typeof MATRIX_MODALITIES)[number];

export interface NounRecallCase {
	viewId: string;
	noun: string;
	/** Phrases that must all resolve (recall) — verb, possessive, bare forms. */
	phrases: { verb: string; possessive: string; bare: string };
}

/**
 * Derive an exhaustive recall matrix from the matcher's own data: for every
 * navigable view and every one of its (multilingual) nouns, build a
 * verb+noun / possessive+noun / bare phrase. Every phrase must resolve to a
 * registered view — a noun that no longer resolves is a real recall regression.
 */
export function nounRecallCases(): NounRecallCase[] {
	const cases: NounRecallCase[] = [];
	for (const viewId of MATCHER_VIEW_IDS) {
		const nouns = __matcherData.VIEW_NOUNS[viewId] ?? [];
		for (const noun of nouns) {
			cases.push({
				viewId,
				noun,
				phrases: {
					verb: `open ${noun}`,
					possessive: `my ${noun}`,
					bare: noun,
				},
			});
		}
	}
	return cases;
}

/**
 * Curated, fully-in-language navigation phrases for the domain views the matcher
 * supports across all 10 languages. Each must resolve to `viewId`. These are the
 * human-readable cells the renderer e2e / scenario layers iterate; they
 * complement (do not replace) the exhaustive `nounRecallCases`.
 */
export interface CuratedCase {
	viewId: string;
	lang: MatrixLanguage;
	phrase: string;
}

export const CURATED_MULTILINGUAL: readonly CuratedCase[] = [
	// calendar
	{ viewId: "calendar", lang: "en", phrase: "open my calendar" },
	{ viewId: "calendar", lang: "es", phrase: "abre mi calendario" },
	{ viewId: "calendar", lang: "pt", phrase: "abra meu calendário" },
	{ viewId: "calendar", lang: "fr", phrase: "ouvre mon calendrier" },
	{ viewId: "calendar", lang: "de", phrase: "öffne meinen kalender" },
	{ viewId: "calendar", lang: "zh", phrase: "打开日历" },
	{ viewId: "calendar", lang: "ja", phrase: "カレンダーを開いて" },
	{ viewId: "calendar", lang: "ko", phrase: "캘린더 열어" },
	{ viewId: "calendar", lang: "vi", phrase: "mở lịch" },
	{ viewId: "calendar", lang: "tl", phrase: "buksan ang calendar" },
	// wallet
	{ viewId: "wallet", lang: "en", phrase: "open my wallet" },
	{ viewId: "wallet", lang: "es", phrase: "abre mi cartera" },
	{ viewId: "wallet", lang: "pt", phrase: "abra minha carteira" },
	{ viewId: "wallet", lang: "fr", phrase: "ouvre mon portefeuille" },
	{ viewId: "wallet", lang: "de", phrase: "öffne meine brieftasche" },
	{ viewId: "wallet", lang: "zh", phrase: "打开钱包" },
	{ viewId: "wallet", lang: "ja", phrase: "ウォレットを開いて" },
	{ viewId: "wallet", lang: "ko", phrase: "지갑 열어" },
	{ viewId: "wallet", lang: "vi", phrase: "mở ví" },
	{ viewId: "wallet", lang: "tl", phrase: "buksan ang wallet" },
	// inbox
	{ viewId: "inbox", lang: "en", phrase: "open my inbox" },
	{ viewId: "inbox", lang: "es", phrase: "abre mi correo" },
	{ viewId: "inbox", lang: "pt", phrase: "abra minhas mensagens" },
	{ viewId: "inbox", lang: "fr", phrase: "ouvre ma boîte de réception" },
	{ viewId: "inbox", lang: "de", phrase: "öffne meinen posteingang" },
	{ viewId: "inbox", lang: "zh", phrase: "打开收件箱" },
	{ viewId: "inbox", lang: "ja", phrase: "受信トレイを開いて" },
	{ viewId: "inbox", lang: "ko", phrase: "받은편지함 열어" },
	{ viewId: "inbox", lang: "vi", phrase: "mở hộp thư" },
	{ viewId: "inbox", lang: "tl", phrase: "buksan ang inbox" },
	// settings
	{ viewId: "settings", lang: "en", phrase: "open settings" },
	{ viewId: "settings", lang: "es", phrase: "abre ajustes" },
	{ viewId: "settings", lang: "pt", phrase: "abra configurações" },
	{ viewId: "settings", lang: "fr", phrase: "ouvre les paramètres" },
	{ viewId: "settings", lang: "de", phrase: "öffne einstellungen" },
	{ viewId: "settings", lang: "zh", phrase: "打开设置" },
	{ viewId: "settings", lang: "ja", phrase: "設定を開いて" },
	{ viewId: "settings", lang: "ko", phrase: "설정 열어" },
	{ viewId: "settings", lang: "vi", phrase: "mở cài đặt" },
	{ viewId: "settings", lang: "tl", phrase: "buksan ang mga setting" },
];

/**
 * Per-language phrases that must NEVER navigate (return null). Small talk,
 * trivia, and statements that merely mention a domain word without nav intent.
 */
export const NEGATIVE_CONTROLS: readonly {
	lang: MatrixLanguage;
	phrase: string;
}[] = [
	{ lang: "en", phrase: "what's the weather like today" },
	{ lang: "en", phrase: "tell me a joke" },
	{ lang: "es", phrase: "cuéntame un chiste" },
	{ lang: "pt", phrase: "como está o tempo hoje" },
	{ lang: "fr", phrase: "raconte-moi une blague" },
	{ lang: "de", phrase: "wie ist das wetter heute" },
	{ lang: "zh", phrase: "今天天气怎么样" },
	{ lang: "ja", phrase: "今日の天気はどう" },
	{ lang: "ko", phrase: "오늘 날씨 어때" },
	{ lang: "vi", phrase: "hôm nay thời tiết thế nào" },
	{ lang: "tl", phrase: "kumusta ang panahon ngayon" },
];
