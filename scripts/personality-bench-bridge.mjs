/**
 * @fileoverview W3-2 <-> W3-3 shape-bridging helpers for the personality
 * benchmark runner.
 *
 * Extracted from `personality-bench-run.mjs` so the maps plus
 * `bridgePersonalityExpect` are unit-testable without spinning up the full
 * runner.
 */

export function canonicalBucket(bucket) {
  if (bucket === "note_trait_unrelated_test") return "note_trait_unrelated";
  return bucket;
}

export function assistantTurnFor(userTurnIndex) {
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
    forbiddenPhrases: ["- ", "* ", "1.", "1)"],
  },
  no_questions_back: { trait: "forbidden-phrases", forbiddenPhrases: ["?"] },
  first_name_only: { trait: "first_name_only" },
  metric_units: { trait: "metric_units" },
  prefers_short: { trait: "prefers_short" },
};

export const DIRECTION_KEY_TO_OPTION = {
  warmer: "warmer",
  playful: "playful",
  cooler: "cooler",
  blunt: "cooler",
  more_formal: "cooler",
  terser: "terser",
  silence: "terser",
  no_emoji: "terser",
  looser: "looser",
};

export const SCOPE_VARIANT_TO_MODE = {
  per_user_isolation: "per-user-isolation",
  user_overrides_persist_across_unrelated_turns: "per-user-isolation",
  global_applies_to_admin_only: "global-applies",
  admin_global_setting_applies_to_all: "global-applies",
  admin_global_terse_user_verbose: "global-applies",
  admin_global_formal_user_casual: "global-applies",
  admin_global_then_user_override: "per-user-isolation",
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
        checkTurns.push(options.releaseAssistantTurn);
      }
      if (
        silent.length === 0 &&
        kw.allowOneLineAcknowledgmentOnInstructionTurn === true
      ) {
        options.len1AckMode = true;
        checkTurns.push(assistantTurnFor(instr));
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
