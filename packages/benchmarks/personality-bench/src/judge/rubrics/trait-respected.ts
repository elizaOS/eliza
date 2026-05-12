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

type Trait =
  | "no-emojis"
  | "no-buddy"
  | "wants-code-blocks"
  | "forbidden-phrases"
  | "first_name_only"
  | "metric_units"
  | "prefers_short";

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
    const phrase = phraseLayerFor(trait, forbiddenPhrases, turn.content, {
      lastName,
      shortPassUpTo,
      shortFailOver,
    });
    layers.push({
      ...phrase,
      reason: `turn ${t} (${trait}): ${phrase.reason}`,
    });
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
