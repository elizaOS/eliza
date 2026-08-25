/**
 * Covers context-signal locale normalization, strong/weak term resolution
 * against the real shared keyword registry, includeAllLocales union, and the
 * empty-weak fallback for signals that have no weak terms.
 */
import { getValidationKeywordTerms } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  type ContextSignalKey,
  getContextSignalTerms,
  resolveContextSignalSpec,
} from "./context-signal-lexicon.ts";

const ALL_KEYS = [
  "affirmative",
  "calendar",
  "draft_edit",
  "gmail",
  "link_entity",
  "lifeops",
  "lifeops_cadence",
  "lifeops_complete",
  "lifeops_delete",
  "lifeops_escalation",
  "lifeops_goal",
  "lifeops_overview",
  "lifeops_phone",
  "lifeops_reminder_pref",
  "lifeops_review",
  "lifeops_skip",
  "lifeops_snooze",
  "lifeops_update",
  "negative",
  "read_channel",
  "read_messages",
  "search_conversations",
  "search_entity",
  "send_message",
  "stream_control",
  "temporal_followup",
  "temporal_next",
  "web_search",
] as const satisfies readonly ContextSignalKey[];

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
