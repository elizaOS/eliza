/**
 * @fileoverview W3-2 ↔ W3-3 shape-bridging helpers for the personality
 * benchmark runner.
 *
 * Extracted from `personality-bench-run.mjs` so the maps + `bridgePersonalityExpect`
 * are unit-testable without spinning up the full runner (which has hard
 * side-effects at module load: env hydration, .env reading, process.exit on
 * missing CEREBRAS_API_KEY, mkdir of run dirs).
 *
 * W3-2 scenarios author `personalityExpect.judgeKwargs` with 0-indexed
 * user-turn positions (probeTurnIndices, silentTurnIndices, etc.) plus
 * rubric-specific keys (styleKey, traitKey, ladderKey, direction,
 * variantKey, ...). The W3-3 judge expects 1-indexed assistant trajectory
 * positions in `personalityExpect.checkTurns` plus normalised
 * `personalityExpect.options.{style,trait,direction,mode,...}`.
 *
 * The trajectory we emit alternates user/assistant, so 1-indexed positions
 * map as: user_i (0-indexed in turns[]) → trajectory turn 2*i + 1;
 * assistant_i → trajectory turn 2*i + 2.
 *
 * All bridging happens here at the runner boundary so the judge stays
 * strict on its documented contract.
 */

export function canonicalBucket(bucket) {
  if (bucket === "note_trait_unrelated_test") return "note_trait_unrelated";
  return bucket;
}

export function assistantTurnFor(userTurnIndex) {
  // 0-indexed user turn → 1-indexed assistant trajectory turn.
  return 2 * userTurnIndex + 2;
}

export function userTurnTo1IndexedTrajectory(userTurnIndex) {
  return 2 * userTurnIndex + 1;
}

export const STYLE_KEY_TO_STYLE = {
  no_hedging: "no-hedging",
  haiku: "haiku",
  pirate: "pirate",
  terse_one_sentence: "terse",
  // W4-G added these three rubrics to the judge; W5-G6 wires them through here
  // so the bridge stops collapsing them to NEEDS_REVIEW ("unknown style").
  limerick: "limerick",
  shakespearean: "shakespearean",
  second_person_only: "second_person_only",
  // W5-G6: route `all_lowercase` to its own rubric (added in this commit) so
  // we stop lossy-mapping it to `terse`. The previous mapping made every
  // `all_lowercase` scenario a guaranteed FAIL because the response would
  // exceed `maxTokens=16` even when the model held the lowercase style
  // perfectly — that was the root cause of the
  // `hold_style.aggressive.code.004` "all agents fail" symptom.
  all_lowercase: "all_lowercase",
};

export const TRAIT_KEY_TO_OPTIONS = {
  no_emojis: { trait: "no-emojis" },
  no_buddy_friend: { trait: "no-buddy", forbiddenPhrases: ["buddy", "friend"] },
  code_blocks_only: { trait: "wants-code-blocks" },
  no_apologies: {
    trait: "forbidden-phrases",
    forbiddenPhrases: ["i'm sorry", "i am sorry", "apologies", "my apologies"],
  },
  no_exclamation: { trait: "forbidden-phrases", forbiddenPhrases: ["!"] },
  no_lists: {
    trait: "forbidden-phrases",
    // Bullet/numbered list markers commonly used by LLMs.
    forbiddenPhrases: ["- ", "* ", "1.", "1)"],
  },
  no_questions_back: { trait: "forbidden-phrases", forbiddenPhrases: ["?"] },
  // P0-2 (LifeOps synthesis plan): wire the three trait rubrics W4-G shipped
  // in `packages/benchmarks/personality-bench/src/judge/checks/phrase.ts`
  // (checkFirstNameOnly / checkMetricUnits / checkPrefersShort). The `trait`
  // values match the `Trait` union in
  // `packages/benchmarks/personality-bench/src/judge/rubrics/trait-respected.ts`.
  //
  // `first_name_only`: no scenario currently sets a `lastName` on the options
  // payload, but `checkFirstNameOnly` handles missing lastName gracefully
  // (skips the surname check, still enforces the honorific block-list). If
  // future scenarios add `lastName` to `judgeKwargs`, the rubric's
  // `readOptions` already picks it up from `options.lastName` / `last_name`.
  first_name_only: { trait: "first_name_only" },
  metric_units: { trait: "metric_units" },
  prefers_short: { trait: "prefers_short" },
};

export const DIRECTION_KEY_TO_OPTION = {
  warmer: "warmer",
  // W5-G6: route `playful` to its own playfulness rubric rather than
  // collapsing it to `warmer`. Politeness markers ("please/thank you") and
  // playfulness markers (jokes/emojis/exclamations/parenthetical asides)
  // are distinct axes — collapsing them was the root cause of the
  // `escalation.aggressive.code.004` "all agents fail" symptom. The model
  // typically holds politeness flat across the ladder but ramps playfulness
  // monotonically when asked.
  playful: "playful",
  cooler: "cooler",
  blunt: "cooler",
  more_formal: "cooler",
  terser: "terser",
  silence: "terser",
  no_emoji: "terser",
  looser: "looser",
};

// Synthesis P1-15: complete mapping for every scope_global_vs_user variant
// the corpus emits (24 of 40 scenarios were silently falling to the default
// `per-user-isolation` mode because their variantKey was unmapped).
//
// The corpus uses authored variant keys; the judge uses the rubric mode
// names from `packages/benchmarks/personality-bench/src/judge/rubrics/scope-isolated.ts`.
// Each scenario variant declares which side wins; the rubric translates
// that into a per-turn leakage / denial / refuse-and-offer-alternative
// check.
export const SCOPE_VARIANT_TO_MODE = {
  // Per-user isolation family — a setting in room A must not influence room B.
  per_user_isolation: "per-user-isolation",
  user_overrides_persist_across_unrelated_turns: "per-user-isolation",

  // Global-applies family — admin sets the global slot, the rubric expects
  // the agent to honour it everywhere (including in the regular user's room).
  global_applies_to_admin_only: "global-applies",
  admin_global_setting_applies_to_all: "global-applies",
  admin_global_terse_user_verbose: "global-applies",
  admin_global_formal_user_casual: "global-applies",

  // Admin sets a global, regular user attempts to override — the agent
  // must keep the global directive while honouring the per-user override
  // ONLY in the user's own room. Folds onto `per-user-isolation` because
  // the rubric uses the forbidden/required leakage check, which is exactly
  // what catches a cross-room leak.
  admin_global_then_user_override: "per-user-isolation",

  // Refusal family — non-admin tries to apply a global directive, agent
  // must refuse AND offer a per-user alternative.
  global_rejected_for_non_admin: "global-rejected-for-non-admin",
  user_tries_global_should_refuse: "user-tries-global-should-refuse",
};

export function bridgePersonalityExpect(scenario) {
  const expect = scenario.personalityExpect ?? {};
  const bucket = canonicalBucket(expect.bucket);
  const kw = expect.judgeKwargs ?? {};
  let checkTurns = [];
  let directiveTurn = 1;
  const options = {};

  switch (bucket) {
    case "shut_up": {
      const silent = Array.isArray(kw.silentTurnIndices)
        ? kw.silentTurnIndices
        : [];
      checkTurns = silent.map(assistantTurnFor);
      const instr =
        typeof kw.instructionTurnIndex === "number"
          ? kw.instructionTurnIndex
          : 0;
      directiveTurn = userTurnTo1IndexedTrajectory(instr);
      if (
        typeof kw.releaseTurnIndex === "number" &&
        kw.releaseTurnIndex !== null
      ) {
        options.releaseTurn = userTurnTo1IndexedTrajectory(kw.releaseTurnIndex);
        options.releaseAssistantTurn = assistantTurnFor(kw.releaseTurnIndex);
        // Include the post-release assistant turn as a check turn so the
        // re-engagement layer fires.
        checkTurns.push(options.releaseAssistantTurn);
      }
      break;
    }
    case "hold_style": {
      const probe = Array.isArray(kw.probeTurnIndices)
        ? kw.probeTurnIndices
        : [];
      checkTurns = probe.map(assistantTurnFor);
      const instr =
        typeof kw.instructionTurnIndex === "number"
          ? kw.instructionTurnIndex
          : 0;
      directiveTurn = userTurnTo1IndexedTrajectory(instr);
      const styleKey = typeof kw.styleKey === "string" ? kw.styleKey : "";
      const mapped = STYLE_KEY_TO_STYLE[styleKey];
      if (mapped) options.style = mapped;
      if (mapped === "terse") options.maxTokens = 16;
      break;
    }
    case "note_trait_unrelated": {
      const probe = Array.isArray(kw.traitCheckTurnIndices)
        ? kw.traitCheckTurnIndices
        : [];
      checkTurns = probe.map(assistantTurnFor);
      const instr =
        typeof kw.traitMentionTurnIndex === "number"
          ? kw.traitMentionTurnIndex
          : 0;
      directiveTurn = userTurnTo1IndexedTrajectory(instr);
      const traitKey = typeof kw.traitKey === "string" ? kw.traitKey : "";
      const mapped = TRAIT_KEY_TO_OPTIONS[traitKey];
      if (mapped) Object.assign(options, mapped);
      // Forward optional last-name hint when the scenario provides it — the
      // judge's `first_name_only` rubric will pick up `options.lastName`.
      if (typeof kw.lastName === "string" && kw.lastName.length > 0) {
        options.lastName = kw.lastName;
      } else if (typeof kw.last_name === "string" && kw.last_name.length > 0) {
        options.lastName = kw.last_name;
      }
      break;
    }
    case "escalation": {
      const probe = Array.isArray(kw.probeTurnIndices)
        ? kw.probeTurnIndices
        : [];
      checkTurns = probe.map(assistantTurnFor);
      const steps = Array.isArray(kw.escalationStepTurnIndices)
        ? kw.escalationStepTurnIndices
        : [];
      const firstStep = steps.length > 0 ? steps[0] : 0;
      directiveTurn = userTurnTo1IndexedTrajectory(firstStep);
      const directionKey =
        typeof kw.direction === "string" ? kw.direction : "";
      const mapped = DIRECTION_KEY_TO_OPTION[directionKey];
      if (mapped) options.direction = mapped;
      break;
    }
    case "scope_global_vs_user": {
      const adminProbe = Array.isArray(kw.adminProbeTurnIndices)
        ? kw.adminProbeTurnIndices
        : [];
      const userProbe = Array.isArray(kw.userProbeTurnIndices)
        ? kw.userProbeTurnIndices
        : [];
      checkTurns = [...adminProbe, ...userProbe].map(assistantTurnFor);
      directiveTurn = 1;
      const variantKey =
        typeof kw.variantKey === "string" ? kw.variantKey : "";
      const mode = SCOPE_VARIANT_TO_MODE[variantKey];
      if (mode) options.mode = mode;
      if (kw.forbidGlobalChangeFromUser === true) {
        // Tighten the mode: a forbidGlobalChangeFromUser flag overrides
        // anything else — the regular user MUST be refused.
        options.mode = "user-tries-global-should-refuse";
      }
      break;
    }
    default:
      checkTurns = [];
      directiveTurn = 1;
  }

  return {
    bucket,
    directiveTurn,
    checkTurns,
    options,
  };
}
