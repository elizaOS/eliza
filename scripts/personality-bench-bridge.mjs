export const STYLE_KEY_TO_STYLE = {
  no_hedging: "no-hedging",
  haiku: "haiku",
  pirate: "pirate",
  terse_one_sentence: "terse",
  all_lowercase: "all_lowercase",
  limerick: "limerick",
  shakespearean: "shakespearean",
  second_person_only: "second_person_only",
};

export const TRAIT_KEY_TO_OPTIONS = {
  no_emojis: { trait: "no-emojis" },
  no_buddy_friend: {
    trait: "no-buddy",
    forbiddenPhrases: ["buddy", "friend"],
  },
  code_blocks_only: { trait: "wants-code-blocks" },
  first_name_only: { trait: "first_name_only" },
  metric_units: { trait: "metric_units" },
  prefers_short: { trait: "prefers_short" },
};

function assistantTurnFor(userTurnIndex) {
  return (Number(userTurnIndex) + 1) * 2;
}

function userTurnFor(userTurnIndex) {
  return assistantTurnFor(userTurnIndex) - 1;
}

function asIndexArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedBucket(bucket) {
  return bucket === "note_trait_unrelated_test"
    ? "note_trait_unrelated"
    : bucket;
}

export function bridgePersonalityExpect(scenario) {
  const personalityExpect = scenario?.personalityExpect ?? {};
  const bucket = normalizedBucket(personalityExpect.bucket);
  const judgeKwargs = personalityExpect.judgeKwargs ?? {};
  const instructionTurnIndex = judgeKwargs.instructionTurnIndex ?? 0;
  const options = {};
  let checkTurns = [];

  if (bucket === "hold_style") {
    const style = STYLE_KEY_TO_STYLE[judgeKwargs.styleKey];
    if (style) {
      options.style = style;
      if (style === "terse") {
        options.maxTokens = 15;
      }
    }
    checkTurns = asIndexArray(judgeKwargs.probeTurnIndices).map(
      assistantTurnFor,
    );
  } else if (bucket === "note_trait_unrelated") {
    Object.assign(options, TRAIT_KEY_TO_OPTIONS[judgeKwargs.traitKey] ?? {});
    const lastName = judgeKwargs.lastName ?? judgeKwargs.last_name;
    if (lastName) {
      options.lastName = lastName;
    }
    checkTurns = asIndexArray(judgeKwargs.traitCheckTurnIndices).map(
      assistantTurnFor,
    );
  } else if (bucket === "shut_up") {
    const silentTurnIndices = asIndexArray(judgeKwargs.silentTurnIndices);
    checkTurns = silentTurnIndices.map(assistantTurnFor);
    if (judgeKwargs.releaseTurnIndex != null) {
      options.releaseTurn = userTurnFor(judgeKwargs.releaseTurnIndex);
    }
    if (
      silentTurnIndices.length === 0 &&
      judgeKwargs.allowOneLineAcknowledgmentOnInstructionTurn === true
    ) {
      options.len1AckMode = true;
      checkTurns = [assistantTurnFor(instructionTurnIndex)];
    }
  }

  return {
    ...personalityExpect,
    bucket,
    directiveTurn: userTurnFor(instructionTurnIndex),
    checkTurns,
    options,
  };
}
