/**
 * Covers context-signal-lexicon: per-key context-window limits (including the
 * default when a spec omits `contextLimit`), locale normalization, strong/weak
 * term resolution against the real shared keyword registry, includeAllLocales
 * union, and the empty-weak fallback for signals that have no weak terms.
 */
import { getValidationKeywordTerms } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  type ContextSignalKey,
  getContextSignalTerms,
  resolveContextSignalSpec,
} from "./context-signal-lexicon.ts";

const DEFAULT_CONTEXT_LIMIT = 8;

/** Explicit per-key windows from CONTEXT_SIGNAL_SPECS; omitted keys use 8. */
const CONTEXT_LIMITS = {
  affirmative: 4,
  calendar: 12,
  draft_edit: 4,
  gmail: 12,
  link_entity: 8,
  lifeops: 12,
  lifeops_cadence: 12,
  lifeops_complete: 12,
  lifeops_delete: 12,
  lifeops_escalation: 12,
  lifeops_goal: 12,
  lifeops_overview: 12,
  lifeops_phone: 12,
  lifeops_reminder_pref: 12,
  lifeops_review: 12,
  lifeops_skip: 12,
  lifeops_snooze: 12,
  lifeops_update: 12,
  negative: 4,
  read_channel: DEFAULT_CONTEXT_LIMIT,
  read_messages: DEFAULT_CONTEXT_LIMIT,
  search_conversations: DEFAULT_CONTEXT_LIMIT,
  search_entity: DEFAULT_CONTEXT_LIMIT,
  send_message: DEFAULT_CONTEXT_LIMIT,
  stream_control: DEFAULT_CONTEXT_LIMIT,
  temporal_followup: 6,
  temporal_next: 6,
  web_search: 6,
} as const satisfies Record<ContextSignalKey, number>;

const ALL_KEYS = Object.keys(CONTEXT_LIMITS) as ContextSignalKey[];

const KEYS_WITH_WEAK_TERMS = new Set<ContextSignalKey>([
  "calendar",
  "gmail",
  "lifeops",
  "read_channel",
  "read_messages",
  "search_conversations",
  "search_entity",
  "send_message",
  "stream_control",
  "web_search",
]);

describe("resolveContextSignalSpec", () => {
  it("returns the documented contextLimit for every signal key", () => {
    for (const key of ALL_KEYS) {
      expect(resolveContextSignalSpec(key).contextLimit).toBe(
        CONTEXT_LIMITS[key],
      );
    }
  });

  it("defaults contextLimit to 8 when the spec omits it", () => {
    expect(resolveContextSignalSpec("send_message").contextLimit).toBe(8);
    expect(resolveContextSignalSpec("search_conversations").contextLimit).toBe(
      8,
    );
    expect(resolveContextSignalSpec("read_channel").contextLimit).toBe(8);
    expect(resolveContextSignalSpec("read_messages").contextLimit).toBe(8);
    expect(resolveContextSignalSpec("stream_control").contextLimit).toBe(8);
    expect(resolveContextSignalSpec("search_entity").contextLimit).toBe(8);
  });

  it("keeps an explicit contextLimit of 8 for link_entity", () => {
    expect(resolveContextSignalSpec("link_entity").contextLimit).toBe(8);
  });

  it("normalizes missing, blank, and unknown locales to en", () => {
    expect(resolveContextSignalSpec("gmail").locale).toBe("en");
    expect(resolveContextSignalSpec("gmail", undefined).locale).toBe("en");
    expect(resolveContextSignalSpec("gmail", "").locale).toBe("en");
    expect(resolveContextSignalSpec("gmail", "   ").locale).toBe("en");
    expect(resolveContextSignalSpec("gmail", 12).locale).toBe("en");
    expect(resolveContextSignalSpec("gmail", null).locale).toBe("en");
    expect(resolveContextSignalSpec("gmail", "fr").locale).toBe("en");
  });

  it("maps locale aliases onto CharacterLanguage values", () => {
    expect(resolveContextSignalSpec("gmail", "zh").locale).toBe("zh-CN");
    expect(resolveContextSignalSpec("gmail", "zh-cn").locale).toBe("zh-CN");
    expect(resolveContextSignalSpec("gmail", "zh-Hans").locale).toBe("zh-CN");
    expect(resolveContextSignalSpec("gmail", "ko-KR").locale).toBe("ko");
    expect(resolveContextSignalSpec("gmail", "es-MX").locale).toBe("es");
    expect(resolveContextSignalSpec("gmail", "pt-BR").locale).toBe("pt");
    expect(resolveContextSignalSpec("gmail", "vi-VN").locale).toBe("vi");
    expect(resolveContextSignalSpec("gmail", "fil").locale).toBe("tl");
    expect(resolveContextSignalSpec("gmail", "tl").locale).toBe("tl");
  });

  it("loads English gmail terms from the real keyword registry", () => {
    const spec = resolveContextSignalSpec("gmail");
    expect(spec.strongTerms).toEqual(
      expect.arrayContaining(["gmail", "inbox", "email", "mailbox"]),
    );
    expect(spec.weakTerms).toEqual(
      expect.arrayContaining(["send", "reply", "attachment"]),
    );
    expect(spec.strongTerms).not.toContain("邮件");
    expect(spec.weakTerms).not.toContain("发送");
  });

  it("loads locale-specific terms for zh-CN without dropping the English base", () => {
    const spec = resolveContextSignalSpec("gmail", "zh-CN");
    expect(spec.locale).toBe("zh-CN");
    expect(spec.strongTerms).toEqual(
      expect.arrayContaining(["gmail", "邮件", "收件箱"]),
    );
    expect(spec.weakTerms).toEqual(expect.arrayContaining(["send", "发送"]));
  });

  it("returns an empty weak list for signals that only declare strong terms", () => {
    for (const key of ALL_KEYS) {
      if (KEYS_WITH_WEAK_TERMS.has(key)) {
        continue;
      }
      const spec = resolveContextSignalSpec(key);
      expect(spec.weakTerms).toEqual([]);
      expect(spec.strongTerms.length).toBeGreaterThan(0);
    }
  });

  it("returns a non-empty weak list for every signal that declares weak terms", () => {
    for (const key of KEYS_WITH_WEAK_TERMS) {
      expect(resolveContextSignalSpec(key).weakTerms.length).toBeGreaterThan(0);
      expect(resolveContextSignalSpec(key).strongTerms.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("unions every locale when includeAllLocales is true", () => {
    const english = resolveContextSignalSpec("gmail");
    const all = resolveContextSignalSpec("gmail", "en", {
      includeAllLocales: true,
    });
    expect(all.locale).toBe("en");
    expect(all.strongTerms).toEqual(
      expect.arrayContaining(["gmail", "邮件", "이메일", "correo"]),
    );
    expect(all.weakTerms).toEqual(
      expect.arrayContaining(["send", "发送", "보내기"]),
    );
    expect(all.strongTerms.length).toBeGreaterThan(english.strongTerms.length);
    expect(all.weakTerms.length).toBeGreaterThan(english.weakTerms.length);
  });

  it("defaults includeAllLocales to false", () => {
    expect(resolveContextSignalSpec("gmail").strongTerms).toEqual(
      resolveContextSignalSpec("gmail", undefined, {
        includeAllLocales: false,
      }).strongTerms,
    );
  });

  it("wires each key's strong terms to the matching validation-keyword path", () => {
    for (const key of ALL_KEYS) {
      expect(resolveContextSignalSpec(key).strongTerms).toEqual(
        getValidationKeywordTerms(`contextSignal.${key}.strong`),
      );
    }
  });

  it("throws when the signal key is not in the lexicon", () => {
    expect(() =>
      resolveContextSignalSpec("not_a_signal" as ContextSignalKey),
    ).toThrow();
  });
});

describe("getContextSignalTerms", () => {
  it("returns the same strong terms as resolveContextSignalSpec", () => {
    for (const key of ALL_KEYS) {
      expect(getContextSignalTerms(key, "strong")).toEqual(
        resolveContextSignalSpec(key).strongTerms,
      );
    }
  });

  it("returns the same weak terms as resolveContextSignalSpec", () => {
    for (const key of ALL_KEYS) {
      expect(getContextSignalTerms(key, "weak")).toEqual(
        resolveContextSignalSpec(key).weakTerms,
      );
    }
  });

  it("returns [] for weak strength when the spec has no weak keyword key", () => {
    expect(getContextSignalTerms("affirmative", "weak")).toEqual([]);
    expect(getContextSignalTerms("negative", "weak")).toEqual([]);
    expect(getContextSignalTerms("draft_edit", "weak")).toEqual([]);
    expect(getContextSignalTerms("temporal_next", "weak")).toEqual([]);
    expect(getContextSignalTerms("lifeops_complete", "weak")).toEqual([]);
  });

  it("honors locale and includeAllLocales on the real registry", () => {
    const zh = getContextSignalTerms("send_message", "strong", {
      locale: "zh",
    });
    expect(zh).toEqual(
      expect.arrayContaining(["send message", "dm", "发消息"]),
    );

    const all = getContextSignalTerms("send_message", "strong", {
      includeAllLocales: true,
    });
    expect(all).toEqual(
      expect.arrayContaining([
        "send message",
        "发消息",
        "메시지 보내",
        "enviar mensaje",
      ]),
    );
    expect(all.length).toBeGreaterThan(zh.length);
  });

  it("defaults includeAllLocales to false when options are omitted", () => {
    expect(getContextSignalTerms("gmail", "strong")).toEqual(
      getContextSignalTerms("gmail", "strong", { includeAllLocales: false }),
    );
  });
});
