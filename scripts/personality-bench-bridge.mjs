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
  limerick: "limerick",
  shakespearean: "shakespearean",
  second_person_only: "second_person_only",
  // `all_lowercase` maps to its own rubric rather than `terse` — using `terse`
  // would enforce maxTokens=16 and fail any response that holds the casing
  // style correctly but exceeds the length constraint.
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
  // Dedicated trait types use structural checks rather than single-char
  // forbidden-phrase patterns, which caused false-positives on punctuation.
  no_exclamation: { trait: "no_exclamation" },
  no_lists: { trait: "no_lists" },
  no_questions_back: { trait: "no_questions_back" },
  // `first_name_only`: lastName is optional — the rubric skips the surname
  // check when absent but still enforces the honorific block-list.
  first_name_only: { trait: "first_name_only" },
  metric_units: { trait: "metric_units" },
  prefers_short: { trait: "prefers_short" },
};

export const DIRECTION_KEY_TO_OPTION = {
  warmer: "warmer",
  // `playful` maps to its own rubric rather than `warmer` — politeness markers
  // and playfulness markers are distinct axes and must not be conflated.
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
  // Refusal family — non-admin tries to apply a global directive, agent
  // must refuse AND offer a per-user alternative.
  user_tries_global_should_refuse: "refuse",
  global_rejected_for_non_admin: "refuse",

  // Override family — admin sets a global, then user overrides for their
  // own session. The agent must honour the per-user override in the user's
  // room while keeping the global directive elsewhere.
  admin_global_then_user_override: "user_overrides_global",

  // Conflict family — global and per-user styles conflict; the per-user
  // preference wins within the user's room.
  admin_global_terse_user_verbose: "user_wins_conflict",
  admin_global_formal_user_casual: "user_wins_conflict",

  // Global-scope family — admin global applies only to admin conversations,
  // not to regular users.
  global_applies_to_admin_only: "global_applies_to_admin_only",

  // Global-all family — admin global applies to every user's room.
  admin_global_setting_applies_to_all: "global_applies_to_all",

  // Persistence family — a per-user override must survive across unrelated
  // topic changes in the same conversation.
  user_overrides_persist_across_unrelated_turns: "persistence",

  // Isolation family — a per-user setting in room A must not influence room B.
  per_user_isolation: "isolation",
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
      // P2-12: len_1 scenarios have no silentTurnIndices (the user only sends
      // the single instruction message). The agent's response to that message
      // IS the only observable turn. Grade it with the lenient len-1 threshold
      // (≤5 words → PASS, ≤15 words → NEEDS_REVIEW, >15 words → FAIL) so
      // near-impossible silence expectations don't auto-fail single-turn tests.
      if (
        silent.length === 0 &&
        kw.allowOneLineAcknowledgmentOnInstructionTurn === true &&
        (typeof kw.releaseTurnIndex !== "number" ||
          kw.releaseTurnIndex === null)
      ) {
        checkTurns = [assistantTurnFor(instr)];
        options.len1AckMode = true;
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
      const directionKey = typeof kw.direction === "string" ? kw.direction : "";
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
      const variantKey = typeof kw.variantKey === "string" ? kw.variantKey : "";
      const mode = SCOPE_VARIANT_TO_MODE[variantKey];
      if (mode) options.mode = mode;
      if (kw.forbidGlobalChangeFromUser === true) {
        // Tighten the mode: a forbidGlobalChangeFromUser flag overrides
        // anything else — the regular user MUST be refused.
        options.mode = "refuse";
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
