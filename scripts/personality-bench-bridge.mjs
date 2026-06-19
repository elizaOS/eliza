export const STYLE_KEY_TO_STYLE = Object.freeze({
  no_hedging: "no-hedging",
  haiku: "haiku",
  pirate: "pirate",
  terse_one_sentence: "terse",
  all_lowercase: "all_lowercase",
  limerick: "limerick",
  shakespearean: "shakespearean",
  second_person_only: "second_person_only",
});

export const TRAIT_KEY_TO_OPTIONS = Object.freeze({
  no_emojis: { trait: "no-emojis" },
  no_buddy_friend: {
    trait: "no-buddy",
    forbiddenPhrases: ["buddy", "friend"],
  },
  code_blocks_only: { trait: "wants-code-blocks" },
  first_name_only: { trait: "first_name_only" },
  metric_units: { trait: "metric_units" },
  prefers_short: { trait: "prefers_short" },
});

export const SCOPE_VARIANT_TO_MODE = Object.freeze({
  user_tries_global_should_refuse: "refuse",
  user_overrides_global: "user_overrides_global",
  user_wins_conflict: "user_wins_conflict",
  global_applies_to_admin_only: "global_applies_to_admin_only",
  global_applies_to_all: "global_applies_to_all",
  persistence: "persistence",
  isolation: "isolation",
});

function assistantTurnFor(userTurnIndex) {
  return userTurnIndex * 2 + 2;
}

function arrayOfAssistantTurns(values) {
  return Array.isArray(values)
    ? values.filter(Number.isInteger).map(assistantTurnFor)
    : [];
}

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

function copyString(source, target, sourceKey, targetKey = sourceKey) {
  const value = source[sourceKey];
  if (typeof value === "string" && value.length > 0) {
    target[targetKey] = value;
  }
}

export function bridgePersonalityExpect(scenario) {
  const sourceExpect = objectValue(scenario?.personalityExpect);
  const judgeKwargs = objectValue(sourceExpect.judgeKwargs);
  const bucket = sourceExpect.bucket;
  const options = { ...objectValue(sourceExpect.options) };
  const bridged = {
    bucket,
    directiveTurn:
      Number.isInteger(sourceExpect.directiveTurn) &&
      sourceExpect.directiveTurn > 0
        ? sourceExpect.directiveTurn
        : 1,
    checkTurns: Array.isArray(sourceExpect.checkTurns)
      ? [...sourceExpect.checkTurns]
      : [],
    options,
  };

  switch (bucket) {
    case "hold_style": {
      const style = STYLE_KEY_TO_STYLE[judgeKwargs.styleKey];
      if (style) {
        options.style = style;
      }
      if (style === "terse") {
        options.maxTokens = options.maxTokens ?? 80;
      }
      if (Number.isInteger(judgeKwargs.instructionTurnIndex)) {
        bridged.directiveTurn = assistantTurnFor(
          judgeKwargs.instructionTurnIndex,
        );
      }
      bridged.checkTurns = arrayOfAssistantTurns(judgeKwargs.probeTurnIndices);
      break;
    }

    case "note_trait_unrelated": {
      Object.assign(options, TRAIT_KEY_TO_OPTIONS[judgeKwargs.traitKey] ?? {});
      copyString(judgeKwargs, options, "lastName");
      copyString(judgeKwargs, options, "last_name", "lastName");
      if (Number.isInteger(judgeKwargs.traitMentionTurnIndex)) {
        bridged.directiveTurn = assistantTurnFor(
          judgeKwargs.traitMentionTurnIndex,
        );
      }
      bridged.checkTurns = arrayOfAssistantTurns(
        judgeKwargs.traitCheckTurnIndices,
      );
      break;
    }

    case "shut_up": {
      if (Number.isInteger(judgeKwargs.instructionTurnIndex)) {
        bridged.directiveTurn = assistantTurnFor(
          judgeKwargs.instructionTurnIndex,
        );
      }
      const silentTurns = arrayOfAssistantTurns(judgeKwargs.silentTurnIndices);
      if (
        silentTurns.length === 0 &&
        judgeKwargs.allowOneLineAcknowledgmentOnInstructionTurn === true
      ) {
        options.len1AckMode = true;
        bridged.checkTurns = [bridged.directiveTurn];
      } else {
        bridged.checkTurns = silentTurns;
      }
      break;
    }

    case "scope_global_vs_user": {
      const mode =
        SCOPE_VARIANT_TO_MODE[judgeKwargs.scopeVariant] ??
        SCOPE_VARIANT_TO_MODE[judgeKwargs.variantKey];
      if (mode) {
        options.mode = mode;
      }
      copyString(judgeKwargs, options, "scopeVariant");
      bridged.checkTurns = arrayOfAssistantTurns(judgeKwargs.checkTurnIndices);
      break;
    }
  }

  return bridged;
}
