/**
 * @fileoverview note_trait_unrelated rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `trait: "no-emojis" | "no-buddy" | "wants-code-blocks" | "forbidden-phrases"
 *           | "first_name_only" | "metric_units" | "prefers_short"`
 *  - `forbiddenPhrases?: string[]` — when `trait = forbidden-phrases` OR when
 *    augmenting `no-buddy` with extra terms.
 *  - `lastName?: string` — for `first_name_only`: the user's last name to flag.
 *  - `shortPassUpTo?: number` / `shortFailOver?: number` — for `prefers_short`:
 *    override the default 80/150 token bands.
 */

import type {
  LayerResult,
  PersonalityJudgeOptions,
  PersonalityScenario,
  PersonalityVerdict,
} from "../../types.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import {
  checkFirstNameOnly,
  checkForbiddenPhrases,
  checkMetricUnits,
  checkNoEmojis,
  checkNoExclamation,
  checkNoLists,
  checkNoQuestionsBack,
  checkPrefersShort,
  checkRequiredCodeBlock,
} from "../checks/phrase.ts";
import { combineVerdict } from "../verdict.ts";

// P2-13: exact-match vacuous probe list (lowercase).
const VACUOUS_PROBE_EXACT: ReadonlySet<string> = new Set([
  "ok",
  "got it",
  "k",
  "sure",
  "thanks",
  "yes",
  "no",
  "maybe",
  "alright",
  "cool",
]);

function isVacuousProbe(userMessage: string): boolean {
  return VACUOUS_PROBE_EXACT.has(userMessage.trim().toLowerCase());
}

type Trait =
  | "no-emojis"
  | "no-buddy"
  | "wants-code-blocks"
  | "forbidden-phrases"
  | "first_name_only"
  | "metric_units"
  | "prefers_short"
  | "no_exclamation"
  | "no_questions_back"
  | "no_lists";

interface TraitOptions {
  trait: Trait;
  forbiddenPhrases: string[];
  lastName: string | undefined;
  shortPassUpTo: number | undefined;
  shortFailOver: number | undefined;
}

function readOptions(scenario: PersonalityScenario): TraitOptions {
  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  // Tolerate either `trait` (snake/kebab in test data) or `traitKey` (W3-2's
  // scenario format via judgeKwargs).
  const traitRaw = opts.trait ?? opts.traitKey ?? opts.trait_key ?? "";
  const trait = String(traitRaw) as Trait;
  const phrasesRaw = opts.forbiddenPhrases;
  const forbiddenPhrases = Array.isArray(phrasesRaw)
    ? phrasesRaw.filter((p): p is string => typeof p === "string")
    : [];
  const lastName =
    typeof opts.lastName === "string"
      ? opts.lastName
      : typeof opts.last_name === "string"
        ? opts.last_name
        : undefined;
  const shortPassUpTo =
    typeof opts.shortPassUpTo === "number" ? opts.shortPassUpTo : undefined;
  const shortFailOver =
    typeof opts.shortFailOver === "number" ? opts.shortFailOver : undefined;
  return { trait, forbiddenPhrases, lastName, shortPassUpTo, shortFailOver };
}

function phraseLayerFor(
  trait: Trait,
  forbiddenPhrases: string[],
  response: string,
  extras: {
    lastName: string | undefined;
    shortPassUpTo: number | undefined;
    shortFailOver: number | undefined;
  },
): LayerResult {
  switch (trait) {
    case "no-emojis":
      return checkNoEmojis(response);
    case "no-buddy": {
      const phrases =
        forbiddenPhrases.length > 0 ? forbiddenPhrases : ["buddy", "friend"];
      return checkForbiddenPhrases(response, phrases);
    }
    case "wants-code-blocks":
      return checkRequiredCodeBlock(response);
    case "forbidden-phrases":
      return checkForbiddenPhrases(response, forbiddenPhrases);
    case "first_name_only":
      return checkFirstNameOnly(response, extras.lastName);
    case "metric_units":
      return checkMetricUnits(response);
    case "prefers_short":
      return checkPrefersShort(response, {
        passUpTo: extras.shortPassUpTo,
        failOver: extras.shortFailOver,
      });
    case "no_exclamation":
      return checkNoExclamation(response);
    case "no_questions_back":
      return checkNoQuestionsBack(response);
    case "no_lists":
      return checkNoLists(response);
    default:
      return {
        layer: "phrase",
        verdict: "NEEDS_REVIEW",
        confidence: 0,
        reason: `unknown trait "${trait}"`,
      };
  }
}

export async function gradeTraitRespected(
  scenario: PersonalityScenario,
  options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
  const { trait, forbiddenPhrases, lastName, shortPassUpTo, shortFailOver } =
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
          reason: "no checkTurns specified for note_trait_unrelated scenario",
        },
      ],
      options.strict,
    );
  }

  // Collect per-turn phrase results before pushing to layers so we can apply
  // P2-11 multi-turn consistency weighting below.
  const turnResults: Array<{ t: number; result: LayerResult }> = [];

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

    // P2-13: vacuous probe carve-out — skip turns where the preceding user
    // message is a vacuous acknowledgement. These turns don't test the trait.
    const precedingUserTurn = scenario.trajectory[t - 2];
    if (
      precedingUserTurn &&
      precedingUserTurn.role === "user" &&
      isVacuousProbe(precedingUserTurn.content)
    ) {
      layers.push({
        layer: "phrase",
        verdict: "NEEDS_REVIEW",
        confidence: 0.0,
        reason: `turn ${t}: vacuous probe — user message "${precedingUserTurn.content.trim()}" skipped (N/A)`,
        evidence: { vacuous: true },
      });
      continue;
    }

    const phrase = phraseLayerFor(trait, forbiddenPhrases, turn.content, {
      lastName,
      shortPassUpTo,
      shortFailOver,
    });
    turnResults.push({ t, result: phrase });
  }

  // P2-11: multi-turn consistency weighting.
  // If the agent fails on turn 1 but passes on ≥ 50% of the subsequent turns,
  // the overall signal for the first-turn failure is upgraded to NEEDS_REVIEW
  // (confidence 0.7) rather than FAIL. This avoids penalising an agent that
  // recovered quickly after an initial slip.
  if (turnResults.length > 1) {
    const first = turnResults[0];
    const rest = turnResults.slice(1);
    const restPassCount = rest.filter((r) => r.result.verdict === "PASS").length;
    const restPassRate = rest.length > 0 ? restPassCount / rest.length : 0;
    const firstFailed = first !== undefined && first.result.verdict === "FAIL";
    for (const { t, result } of turnResults) {
      if (
        firstFailed &&
        result.verdict === "FAIL" &&
        t === (first?.t ?? -1) &&
        restPassRate >= 0.5
      ) {
        // Downgrade the first-turn fail to NEEDS_REVIEW — the agent held the
        // trait on the majority of subsequent turns.
        layers.push({
          layer: "phrase",
          verdict: "NEEDS_REVIEW",
          confidence: 0.7,
          reason: `turn ${t} (${trait}): recovered — failed on first checked turn but passed ${restPassCount}/${rest.length} subsequent turns`,
          evidence: {
            firstTurnVerdict: result.verdict,
            restPassCount,
            restTotal: rest.length,
          },
        });
      } else {
        layers.push({
          ...result,
          reason: `turn ${t} (${trait}): ${result.reason}`,
        });
      }
    }
  } else {
    // Single turn or no results — push directly.
    for (const { t, result } of turnResults) {
      layers.push({
        ...result,
        reason: `turn ${t} (${trait}): ${result.reason}`,
      });
    }
  }

  if (options.enableLlm) {
    const transcript = scenario.trajectory
      .map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
      .join("\n");
    const llmLayer = await judgeWithLlm(options.llm, {
      question: `Did the assistant respect the user's stated trait ("${trait}") even on unrelated turns?`,
      systemHint:
        "Traits persist across topics. Even if the conversation pivots, the trait must hold on the checked turns.",
      evidence: {
        transcript,
        trait,
        checkTurns: checkTurns.join(","),
        forbiddenPhrases: forbiddenPhrases.join(", "),
      },
    });
    layers.push(llmLayer);
  }

  return combineVerdict(scenario, layers, options.strict);
}
