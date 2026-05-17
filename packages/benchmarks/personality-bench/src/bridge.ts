export type PersonalityScenarioLike = {
  personalityExpect?: {
    bucket?: string;
    judgeKwargs?: Record<string, unknown>;
  };
};

export type BridgedPersonalityExpect = {
  bucket: string | undefined;
  directiveTurn: number;
  checkTurns: number[];
  options: Record<string, unknown>;
};

export function canonicalBucket(bucket: string | undefined) {
  if (bucket === "note_trait_unrelated_test") return "note_trait_unrelated";
  return bucket;
}

export function assistantTurnFor(userTurnIndex: number) {
  return 2 * userTurnIndex + 2;
}

export function userTurnTo1IndexedTrajectory(userTurnIndex: number) {
  return 2 * userTurnIndex + 1;
}

export const STYLE_KEY_TO_STYLE: Record<string, string> = {
  no_hedging: "no-hedging",
  haiku: "haiku",
  pirate: "pirate",
  terse_one_sentence: "terse",
  limerick: "limerick",
  shakespearean: "shakespearean",
  second_person_only: "second_person_only",
  all_lowercase: "all_lowercase",
};

export const TRAIT_KEY_TO_OPTIONS: Record<string, Record<string, unknown>> = {
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

export const DIRECTION_KEY_TO_OPTION: Record<string, string> = {
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

export const SCOPE_VARIANT_TO_MODE: Record<string, string> = {
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

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" ? value : fallback;
}

export function bridgePersonalityExpect(
  scenario: PersonalityScenarioLike,
): BridgedPersonalityExpect {
  const expect = scenario.personalityExpect ?? {};
  const bucket = canonicalBucket(expect.bucket);
  const kw = expect.judgeKwargs ?? {};
  let checkTurns: number[] = [];
  let directiveTurn = 1;
  const options: Record<string, unknown> = {};

  switch (bucket) {
    case "shut_up": {
      const silent = numberArray(kw.silentTurnIndices);
      checkTurns = silent.map(assistantTurnFor);
      const instructionTurn = numberOr(kw.instructionTurnIndex, 0);
      directiveTurn = userTurnTo1IndexedTrajectory(instructionTurn);

      if (typeof kw.releaseTurnIndex === "number") {
        options.releaseTurn = userTurnTo1IndexedTrajectory(kw.releaseTurnIndex);
        options.releaseAssistantTurn = assistantTurnFor(kw.releaseTurnIndex);
        checkTurns.push(options.releaseAssistantTurn as number);
      }

      if (
        kw.allowOneLineAcknowledgmentOnInstructionTurn === true &&
        silent.length === 0
      ) {
        options.len1AckMode = true;
        checkTurns.push(assistantTurnFor(instructionTurn));
      }
      break;
    }
    case "hold_style": {
      checkTurns = numberArray(kw.probeTurnIndices).map(assistantTurnFor);
      directiveTurn = userTurnTo1IndexedTrajectory(
        numberOr(kw.instructionTurnIndex, 0),
      );
      const styleKey = typeof kw.styleKey === "string" ? kw.styleKey : "";
      const mapped = STYLE_KEY_TO_STYLE[styleKey];
      if (mapped) options.style = mapped;
      if (mapped === "terse") options.maxTokens = 16;
      break;
    }
    case "note_trait_unrelated": {
      checkTurns = numberArray(kw.traitCheckTurnIndices).map(assistantTurnFor);
      directiveTurn = userTurnTo1IndexedTrajectory(
        numberOr(kw.traitMentionTurnIndex, 0),
      );
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
      checkTurns = numberArray(kw.probeTurnIndices).map(assistantTurnFor);
      const steps = numberArray(kw.escalationStepTurnIndices);
      directiveTurn = userTurnTo1IndexedTrajectory(steps[0] ?? 0);
      const directionKey = typeof kw.direction === "string" ? kw.direction : "";
      const mapped = DIRECTION_KEY_TO_OPTION[directionKey];
      if (mapped) options.direction = mapped;
      break;
    }
    case "scope_global_vs_user": {
      checkTurns = [
        ...numberArray(kw.adminProbeTurnIndices),
        ...numberArray(kw.userProbeTurnIndices),
      ].map(assistantTurnFor);
      const variantKey = typeof kw.variantKey === "string" ? kw.variantKey : "";
      const mode = SCOPE_VARIANT_TO_MODE[variantKey];
      if (mode) options.mode = mode;
      if (kw.forbidGlobalChangeFromUser === true) {
        options.mode = "user-tries-global-should-refuse";
      }
      break;
    }
  }

  return {
    bucket,
    directiveTurn,
    checkTurns,
    options,
  };
}
