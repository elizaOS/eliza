/**
 * Central lexicon mapping each context-signal key (affirmative, negative, the
 * lifeops_* family, calendar, gmail, web_search, send_message, and so on) to
 * its localized strong/weak keyword terms.
 * `resolveContextSignalSpec` / `getContextSignalTerms` resolve a signal to
 * concrete terms for the requested character locale, drawing the raw phrase
 * lists from `@elizaos/shared`'s validation-keyword registry. Consumed by the
 * providers and action validators that decide whether a signal is present in
 * the complete available context.
 */
import {
  type CharacterLanguage,
  getValidationKeywordTerms,
  normalizeCharacterLanguage,
} from "@elizaos/shared";

export type ContextSignalKey =
  | "affirmative"
  | "calendar"
  | "draft_edit"
  | "gmail"
  | "link_entity"
  | "lifeops"
  | "lifeops_cadence"
  | "lifeops_complete"
  | "lifeops_delete"
  | "lifeops_escalation"
  | "lifeops_goal"
  | "lifeops_overview"
  | "lifeops_phone"
  | "lifeops_reminder_pref"
  | "lifeops_review"
  | "lifeops_skip"
  | "lifeops_snooze"
  | "lifeops_update"
  | "negative"
  | "read_channel"
  | "read_messages"
  | "search_conversations"
  | "search_entity"
  | "send_message"
  | "stream_control"
  | "temporal_followup"
  | "temporal_next"
  | "web_search";

export type ContextSignalStrength = "strong" | "weak";

type ContextSignalSpec = {
  keywordKeys: {
    strong: string;
    weak?: string;
  };
};

export type ResolvedContextSignalSpec = {
  locale: CharacterLanguage;
  strongTerms: string[];
  weakTerms: string[];
};

const CONTEXT_SIGNAL_SPECS: Record<ContextSignalKey, ContextSignalSpec> = {
  affirmative: {
    keywordKeys: {
      strong: "contextSignal.affirmative.strong",
    },
  },
  draft_edit: {
    keywordKeys: {
      strong: "contextSignal.draft_edit.strong",
    },
  },
  negative: {
    keywordKeys: {
      strong: "contextSignal.negative.strong",
    },
  },
  temporal_followup: {
    keywordKeys: {
      strong: "contextSignal.temporal_followup.strong",
    },
  },
  temporal_next: {
    keywordKeys: {
      strong: "contextSignal.temporal_next.strong",
    },
  },
  gmail: {
    keywordKeys: {
      strong: "contextSignal.gmail.strong",
      weak: "contextSignal.gmail.weak",
    },
  },
  lifeops: {
    keywordKeys: {
      strong: "contextSignal.lifeops.strong",
      weak: "contextSignal.lifeops.weak",
    },
  },
  lifeops_cadence: {
    keywordKeys: {
      strong: "contextSignal.lifeops_cadence.strong",
    },
  },
  lifeops_complete: {
    keywordKeys: {
      strong: "contextSignal.lifeops_complete.strong",
    },
  },
  lifeops_delete: {
    keywordKeys: {
      strong: "contextSignal.lifeops_delete.strong",
    },
  },
  lifeops_overview: {
    keywordKeys: {
      strong: "contextSignal.lifeops_overview.strong",
    },
  },
  lifeops_reminder_pref: {
    keywordKeys: {
      strong: "contextSignal.lifeops_reminder_pref.strong",
    },
  },
  lifeops_skip: {
    keywordKeys: {
      strong: "contextSignal.lifeops_skip.strong",
    },
  },
  lifeops_snooze: {
    keywordKeys: {
      strong: "contextSignal.lifeops_snooze.strong",
    },
  },
  lifeops_escalation: {
    keywordKeys: {
      strong: "contextSignal.lifeops_escalation.strong",
    },
  },
  lifeops_goal: {
    keywordKeys: {
      strong: "contextSignal.lifeops_goal.strong",
    },
  },
  lifeops_phone: {
    keywordKeys: {
      strong: "contextSignal.lifeops_phone.strong",
    },
  },
  lifeops_review: {
    keywordKeys: {
      strong: "contextSignal.lifeops_review.strong",
    },
  },
  lifeops_update: {
    keywordKeys: {
      strong: "contextSignal.lifeops_update.strong",
    },
  },
  link_entity: {
    keywordKeys: {
      strong: "contextSignal.link_entity.strong",
    },
  },
  calendar: {
    keywordKeys: {
      strong: "contextSignal.calendar.strong",
      weak: "contextSignal.calendar.weak",
    },
  },
  web_search: {
    keywordKeys: {
      strong: "contextSignal.web_search.strong",
      weak: "contextSignal.web_search.weak",
    },
  },
  send_message: {
    keywordKeys: {
      strong: "contextSignal.send_message.strong",
      weak: "contextSignal.send_message.weak",
    },
  },
  search_conversations: {
    keywordKeys: {
      strong: "contextSignal.search_conversations.strong",
      weak: "contextSignal.search_conversations.weak",
    },
  },
  read_channel: {
    keywordKeys: {
      strong: "contextSignal.read_channel.strong",
      weak: "contextSignal.read_channel.weak",
    },
  },
  read_messages: {
    keywordKeys: {
      strong: "contextSignal.read_messages.strong",
      weak: "contextSignal.read_messages.weak",
    },
  },
  stream_control: {
    keywordKeys: {
      strong: "contextSignal.stream_control.strong",
      weak: "contextSignal.stream_control.weak",
    },
  },
  search_entity: {
    keywordKeys: {
      strong: "contextSignal.search_entity.strong",
      weak: "contextSignal.search_entity.weak",
    },
  },
};

export function resolveContextSignalSpec(
  key: ContextSignalKey,
  localeInput?: unknown,
  options?: {
    includeAllLocales?: boolean;
  },
): ResolvedContextSignalSpec {
  const locale = normalizeCharacterLanguage(localeInput);
  const spec = CONTEXT_SIGNAL_SPECS[key];
  const includeAllLocales = options?.includeAllLocales ?? false;

  return {
    locale,
    strongTerms: getValidationKeywordTerms(spec.keywordKeys.strong, {
      includeAllLocales,
      locale,
    }),
    weakTerms: spec.keywordKeys.weak
      ? getValidationKeywordTerms(spec.keywordKeys.weak, {
          includeAllLocales,
          locale,
        })
      : [],
  };
}

export function getContextSignalTerms(
  key: ContextSignalKey,
  strength: ContextSignalStrength,
  options?: {
    includeAllLocales?: boolean;
    locale?: unknown;
  },
): string[] {
  const spec = CONTEXT_SIGNAL_SPECS[key];
  const keywordKey =
    strength === "strong" ? spec.keywordKeys.strong : spec.keywordKeys.weak;
  if (!keywordKey) {
    return [];
  }

  return getValidationKeywordTerms(keywordKey, {
    includeAllLocales: options?.includeAllLocales ?? false,
    locale: options?.locale,
  });
}
