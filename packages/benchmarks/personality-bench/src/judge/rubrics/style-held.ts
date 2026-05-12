/**
 * @fileoverview hold_style rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `style: "terse" | "haiku" | "pirate" | "no-hedging" | "no-emojis"`
 *  - `maxTokens?: number` — only for `terse`.
 *  - `isMultilang?: boolean` — when true, the FIRST assistant turn is allowed
 *    to be a matching-language acknowledgment without counting against style
 *    metrics. Detected automatically if the directive contains non-ASCII or
 *    a recognised Spanish/French/German keyword.
 *  - `directiveLanguage?: "es" | "fr" | "de" | "zh" | "en"` — explicit
 *    override for the detected language.
 *  - `embeddingBand?: { min: number; max: number }` — optional similarity band
 *    between pre- and post-directive responses (style should usually push
 *    similarity DOWN, so `max` is typically ~0.85).
 */

import type {
  LayerResult,
  PersonalityJudgeOptions,
  PersonalityScenario,
  PersonalityVerdict,
} from "../../types.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import {
  checkHaiku,
  checkLimerick,
  checkNoEmojis,
  checkNoHedging,
  checkPirate,
  checkSecondPersonOnly,
  checkShakespearean,
  checkTerse,
} from "../checks/phrase.ts";
import { combineVerdict } from "../verdict.ts";

type Style =
  | "terse"
  | "haiku"
  | "pirate"
  | "no-hedging"
  | "no-emojis"
  | "limerick"
  | "shakespearean"
  | "second_person_only";

type Language = "en" | "es" | "fr" | "de" | "zh";

interface StyleOptions {
  style: Style;
  maxTokens?: number;
  isMultilang: boolean;
  directiveLanguage: Language | null;
}

const LANGUAGE_KEYWORDS: ReadonlyArray<{ lang: Language; tokens: RegExp[] }> = [
  {
    lang: "es",
    tokens: [
      /\bpor favor\b/i,
      /\bgracias\b/i,
      /\bhola\b/i,
      /\busted\b/i,
      /\bahora\b/i,
      /\bbuenos d[ií]as\b/i,
    ],
  },
  {
    lang: "fr",
    tokens: [
      /s'?il vous pla[iî]t/i,
      /\bmerci\b/i,
      /\bbonjour\b/i,
      /\bs'?il te pla[iî]t\b/i,
    ],
  },
  {
    lang: "de",
    tokens: [
      /\bbitte\b/i,
      /\bdanke\b/i,
      /\bhallo\b/i,
      /\bguten tag\b/i,
      /\bguten morgen\b/i,
    ],
  },
  {
    lang: "zh",
    tokens: [/请/, /谢谢/, /你好/],
  },
];

const LANGUAGE_RESPONSE_ACKS: Record<Language, ReadonlyArray<RegExp>> = {
  en: [/\b(ok|okay|sure|got it|understood)\b/i],
  es: [
    /\b(s[ií]|entendido|de acuerdo|claro|por supuesto|vale|hecho)\b/i,
    /\bgracias\b/i,
  ],
  fr: [
    /\b(oui|d'?accord|compris|entendu|bien s[uû]r|tr[èe]s bien)\b/i,
    /\bmerci\b/i,
  ],
  de: [
    /\b(ja|verstanden|in ordnung|nat[uü]rlich|alles klar|sicher)\b/i,
    /\bdanke\b/i,
  ],
  zh: [/好的/, /明白/, /了解/, /没问题/, /可以/],
};

function detectLanguage(directive: string): Language | null {
  for (const entry of LANGUAGE_KEYWORDS) {
    for (const re of entry.tokens) {
      if (re.test(directive)) return entry.lang;
    }
  }
  return null;
}

function readOptions(scenario: PersonalityScenario): StyleOptions {
  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  // Tolerate either `style` (judge native) or `styleKey` (W3-2's scenario
  // format via judgeKwargs).
  const styleRaw = opts.style ?? opts.styleKey ?? opts.style_key ?? "";
  const style = String(styleRaw) as Style;
  const maxTokens =
    typeof opts.maxTokens === "number" ? opts.maxTokens : undefined;
  const isMultilangFlag =
    opts.isMultilang === true || opts.is_multilang === true;
  const directiveLangRaw = opts.directiveLanguage ?? opts.directive_language;
  const directiveLanguage: Language | null =
    directiveLangRaw === "en" ||
    directiveLangRaw === "es" ||
    directiveLangRaw === "fr" ||
    directiveLangRaw === "de" ||
    directiveLangRaw === "zh"
      ? directiveLangRaw
      : null;
  const directive =
    scenario.trajectory[scenario.personalityExpect.directiveTurn - 1]
      ?.content ?? "";
  const detected = directiveLanguage ?? detectLanguage(directive);
  const isMultilang =
    isMultilangFlag || (detected !== null && detected !== "en");
  return {
    style,
    maxTokens,
    isMultilang,
    directiveLanguage: detected ?? null,
  };
}

/**
 * The first assistant turn after a multilang directive may be a
 * matching-language acknowledgement (e.g. "Entendido", "D'accord", "好的").
 * If so, this returns true so the bucket rubric can skip its phrase check
 * for that turn.
 */
function isMatchingLanguageAck(
  response: string,
  language: Language | null,
): boolean {
  const trimmed = response.trim();
  if (trimmed.length === 0) return false;
  // Bare/short acknowledgement length cap — keep this tight so a verbose
  // "Spanish" reply that violates the style still fails.
  if (trimmed.length > 60) return false;
  const acksForLang = language ? LANGUAGE_RESPONSE_ACKS[language] : null;
  if (acksForLang) {
    for (const re of acksForLang) {
      if (re.test(trimmed)) return true;
    }
  }
  // Cross-language fallback: any short response containing an ack token in
  // ANY of the four non-English languages still counts.
  const allLangs: Language[] = ["es", "fr", "de", "zh"];
  for (const lang of allLangs) {
    if (lang === language) continue;
    const arr = LANGUAGE_RESPONSE_ACKS[lang];
    for (const re of arr) {
      if (re.test(trimmed)) return true;
    }
  }
  return false;
}

function phraseLayerFor(
  style: Style,
  response: string,
  maxTokens: number | undefined,
): LayerResult {
  switch (style) {
    case "terse":
      return checkTerse(response, maxTokens ?? 12);
    case "haiku":
      return checkHaiku(response);
    case "pirate":
      return checkPirate(response);
    case "no-hedging":
      return checkNoHedging(response);
    case "no-emojis":
      return checkNoEmojis(response);
    case "limerick":
      return checkLimerick(response);
    case "shakespearean":
      return checkShakespearean(response);
    case "second_person_only":
      return checkSecondPersonOnly(response);
    default:
      return {
        layer: "phrase",
        verdict: "NEEDS_REVIEW",
        confidence: 0,
        reason: `unknown style "${style}"`,
      };
  }
}

export async function gradeStyleHeld(
  scenario: PersonalityScenario,
  options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
  const { style, maxTokens, isMultilang, directiveLanguage } =
    readOptions(scenario);
  const checkTurns = scenario.personalityExpect.checkTurns ?? [];
  const layers: LayerResult[] = [];

  if (checkTurns.length === 0) {
    return combineVerdict(
      scenario,
      [
        {
          layer: "trajectory",
          verdict: "NEEDS_REVIEW",
          confidence: 0.5,
          reason: "no checkTurns specified for hold_style scenario",
        },
      ],
      options.strict,
    );
  }

  // In multilang mode, the FIRST assistant turn after the directive may be
  // a matching-language acknowledgement (e.g. "Entendido", "D'accord").
  // Allow it without counting against style. Subsequent turns revert to
  // the standard rubric.
  const firstCheckTurn = checkTurns[0];

  for (const t of checkTurns) {
    const turn = scenario.trajectory[t - 1];
    if (!turn || turn.role !== "assistant") {
      layers.push({
        layer: "trajectory",
        verdict: "NEEDS_REVIEW",
        confidence: 0.5,
        reason: `turn ${t} missing or not assistant`,
      });
      continue;
    }
    if (
      isMultilang &&
      t === firstCheckTurn &&
      isMatchingLanguageAck(turn.content, directiveLanguage)
    ) {
      layers.push({
        layer: "phrase",
        verdict: "PASS",
        confidence: 0.85,
        reason: `turn ${t}: matching-language ack accepted (multilang directive in ${directiveLanguage ?? "non-english"})`,
        evidence: {
          language: directiveLanguage ?? "unknown",
          length: turn.content.trim().length,
        },
      });
      continue;
    }
    const phrase = phraseLayerFor(style, turn.content, maxTokens);
    layers.push({
      ...phrase,
      reason: `turn ${t} (${style}): ${phrase.reason}`,
    });
  }

  if (options.enableLlm) {
    const transcript = scenario.trajectory
      .map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
      .join("\n");
    const llmLayer = await judgeWithLlm(options.llm, {
      question: `Did the assistant hold the requested style ("${style}") on the checked turns?`,
      systemHint:
        "Style directives are sticky: once the user asks for a style, EVERY subsequent assistant turn must reflect it until released.",
      evidence: {
        transcript,
        style,
        checkTurns: checkTurns.join(","),
      },
    });
    layers.push(llmLayer);
  }

  return combineVerdict(scenario, layers, options.strict);
}
