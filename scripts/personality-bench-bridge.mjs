export const STYLE_KEY_TO_STYLE = {
  no_hedging: "no-hedging",
  no_emojis: "no-emojis",
  haiku: "haiku",
  pirate: "pirate",
  terse_one_sentence: "terse",
  terse: "terse",
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

function userTurnFor(index) {
  return index * 2 + 1;
}

function assistantTurnFor(index) {
  return (index + 1) * 2;
}

function numericArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => Number.isInteger(item) && item >= 0)
    : [];
}

function baseExpect(source, kwargs) {
  return {
    ...source,
    directiveTurn: Number.isInteger(kwargs.instructionTurnIndex)
      ? userTurnFor(kwargs.instructionTurnIndex)
      : (source.directiveTurn ?? 1),
    checkTurns: Array.isArray(source.checkTurns) ? source.checkTurns : [],
    options: { ...(source.options ?? {}) },
  };
}

function bridgeHoldStyle(expect, kwargs) {
  const bridged = baseExpect(expect, kwargs);
  const style =
    typeof kwargs.styleKey === "string"
      ? STYLE_KEY_TO_STYLE[kwargs.styleKey]
      : undefined;
  if (style !== undefined) {
    bridged.options.style = style;
  }
  if (style === "terse" && bridged.options.maxTokens === undefined) {
    bridged.options.maxTokens = 10;
  }
  const probeTurnIndices = numericArray(kwargs.probeTurnIndices);
  if (probeTurnIndices.length > 0) {
    bridged.checkTurns = probeTurnIndices.map(assistantTurnFor);
  }
  return bridged;
}

function bridgeNoteTrait(expect, kwargs) {
  const bridged = baseExpect(expect, kwargs);
  const traitOptions =
    typeof kwargs.traitKey === "string"
      ? TRAIT_KEY_TO_OPTIONS[kwargs.traitKey]
      : undefined;
  if (traitOptions !== undefined) {
    Object.assign(bridged.options, traitOptions);
  }
  const lastName = kwargs.lastName ?? kwargs.last_name;
  if (typeof lastName === "string" && lastName.length > 0) {
    bridged.options.lastName = lastName;
  }
  const traitCheckTurnIndices = numericArray(kwargs.traitCheckTurnIndices);
  if (traitCheckTurnIndices.length > 0) {
    bridged.checkTurns = traitCheckTurnIndices.map(assistantTurnFor);
  }
  return bridged;
}

function bridgeShutUp(expect, kwargs) {
  const bridged = baseExpect(expect, kwargs);
  const silentTurnIndices = numericArray(kwargs.silentTurnIndices);
  if (silentTurnIndices.length > 0) {
    bridged.checkTurns = silentTurnIndices.map(assistantTurnFor);
  } else if (kwargs.allowOneLineAcknowledgmentOnInstructionTurn === true) {
    const instructionTurnIndex = Number.isInteger(kwargs.instructionTurnIndex)
      ? kwargs.instructionTurnIndex
      : 0;
    bridged.checkTurns = [assistantTurnFor(instructionTurnIndex)];
    bridged.options.len1AckMode = true;
  }
  if (Number.isInteger(kwargs.releaseTurnIndex)) {
    bridged.options.releaseTurn = userTurnFor(kwargs.releaseTurnIndex);
  }
  return bridged;
}

export function bridgePersonalityExpect(scenario) {
  const expect = scenario.personalityExpect;
  const kwargs = expect.judgeKwargs ?? {};
  switch (expect.bucket) {
    case "hold_style":
      return bridgeHoldStyle(expect, kwargs);
    case "note_trait_unrelated":
      return bridgeNoteTrait(expect, kwargs);
    case "shut_up":
      return bridgeShutUp(expect, kwargs);
    default:
      return baseExpect(expect, kwargs);
  }
}
