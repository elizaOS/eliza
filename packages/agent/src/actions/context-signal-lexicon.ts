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
  contextLimit?: number;
  keywordKeys: {
    strong: string;
    weak?: string;
  };
};

export type ResolvedContextSignalSpec = {
  locale: CharacterLanguage;
  contextLimit: number;
  strongTerms: string[];
  weakTerms: string[];
};

const DEFAULT_CONTEXT_LIMIT = 8;

const CONTEXT_SIGNAL_SPECS: Record<ContextSignalKey, ContextSignalSpec> = {
  affirmative: {
    contextLimit: 4,
    keywordKeys: {
      strong: "contextSignal.affirmative.strong",
    },
  },
  draft_edit: {
    contextLimit: 4,
    keywordKeys: {
      strong: "contextSignal.draft_edit.strong",
    },
  },
  negative: {
    contextLimit: 4,
    keywordKeys: {
      strong: "contextSignal.negative.strong",
    },
  },
  temporal_followup: {
    contextLimit: 6,
    keywordKeys: {
      strong: "contextSignal.temporal_followup.strong",
    },
  },
  temporal_next: {
    contextLimit: 6,
    keywordKeys: {
      strong: "contextSignal.temporal_next.strong",
    },
  },
  gmail: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.gmail.strong",
      weak: "contextSignal.gmail.weak",
    },
  },
  lifeops: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops.strong",
      weak: "contextSignal.lifeops.weak",
    },
  },
  lifeops_cadence: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_cadence.strong",
    },
  },
  lifeops_complete: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_complete.strong",
    },
  },
  lifeops_delete: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_delete.strong",
    },
  },
  lifeops_overview: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_overview.strong",
    },
  },
  lifeops_reminder_pref: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_reminder_pref.strong",
    },
  },
  lifeops_skip: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_skip.strong",
    },
  },
  lifeops_snooze: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_snooze.strong",
    },
  },
  lifeops_escalation: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_escalation.strong",
    },
  },
  lifeops_goal: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_goal.strong",
    },
  },
  lifeops_phone: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_phone.strong",
    },
  },
  lifeops_review: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_review.strong",
    },
  },
  lifeops_update: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.lifeops_update.strong",
    },
  },
  link_entity: {
    contextLimit: 8,
    keywordKeys: {
      strong: "contextSignal.link_entity.strong",
    },
  },
  calendar: {
    contextLimit: 12,
    keywordKeys: {
      strong: "contextSignal.calendar.strong",
      weak: "contextSignal.calendar.weak",
    },
  },
  web_search: {
    contextLimit: 6,
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
    contextLimit: spec.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
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
