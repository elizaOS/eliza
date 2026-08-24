/**
 * Covers chat message provenance helpers: the pluggable source-meta registry,
 * source-key normalization, the reaction-emoji renderer seam, and voice-speaker
 * label resolution.
 *
 * The registry is injected by the host app, so the contract that matters is
 * that lookups are normalization-insensitive (a source arriving as `"iMessage "`
 * from a connector must hit an entry registered as `"imessage"`) and that an
 * unregistered source still degrades to a readable label rather than an empty
 * badge.
 *
 * The registry is module-level state, so each test registers its own keys and
 * the renderer seam is reset afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChatSourceMeta,
  getChatSourceMeta,
  hasChatSourceMeta,
  normalizeChatSourceKey,
  registerChatReactionEmojiRenderer,
  registerChatSourceMetaEntries,
  renderChatReactionEmoji,
  resolveChatVoiceSpeakerLabel,
} from "./chat-source.helpers.ts";
import type { ChatVoiceSpeaker } from "./chat-types";

const meta = (label: string): ChatSourceMeta =>
  ({
    badgeClassName: "badge",
    borderClassName: "border",
    iconClassName: "icon",
    Icon: () => null,
    label,
  }) as ChatSourceMeta;

afterEach(() => {
  registerChatReactionEmojiRenderer(null);
});

describe("normalizeChatSourceKey", () => {
  it("trims and lowercases a usable key", () => {
    expect(normalizeChatSourceKey("  iMessage  ")).toBe("imessage");
    expect(normalizeChatSourceKey("TELEGRAM")).toBe("telegram");
  });

  it("returns null for blank or non-string input", () => {
    for (const value of ["", "   ", null, undefined, 42, {}, []]) {
      expect(
        normalizeChatSourceKey(value as string | null | undefined),
      ).toBeNull();
    }
  });
});

describe("source meta registry", () => {
  it("registers under the normalized key and looks up case-insensitively", () => {
    registerChatSourceMetaEntries({ "  RegTest_One  ": meta("Reg One") });
    expect(hasChatSourceMeta("regtest_one")).toBe(true);
    expect(hasChatSourceMeta("  REGTEST_ONE ")).toBe(true);
    expect(getChatSourceMeta("RegTest_One").label).toBe("Reg One");
  });

  it("skips entries whose key normalizes to nothing", () => {
    expect(() =>
      registerChatSourceMetaEntries({ "   ": meta("blank") }),
    ).not.toThrow();
    expect(hasChatSourceMeta("   ")).toBe(false);
  });

  it("lets a later registration replace an earlier one", () => {
    registerChatSourceMetaEntries({ regtesttwo: meta("first") });
    registerChatSourceMetaEntries({ RegTestTwo: meta("second") });
    expect(getChatSourceMeta("regtesttwo").label).toBe("second");
  });

  it("reports no meta for an unregistered source", () => {
    expect(hasChatSourceMeta("regtest-never-registered")).toBe(false);
  });
});

describe("getChatSourceMeta fallback", () => {
  it("title-cases an unregistered source instead of leaving it blank", () => {
    expect(getChatSourceMeta("google_workspace").label).toBe(
      "Google Workspace",
    );
    expect(getChatSourceMeta("bluebubbles").label).toBe("Bluebubbles");
    expect(getChatSourceMeta("some-mixed_source name").label).toBe(
      "Some Mixed Source Name",
    );
  });

  it("still returns a complete meta shape for an unregistered source", () => {
    const fallback = getChatSourceMeta("regtest-unknown-source");
    expect(fallback.badgeClassName).toBeTruthy();
    expect(fallback.borderClassName).toBeTruthy();
    expect(fallback.iconClassName).toBeTruthy();
    expect(fallback.Icon).toBeTruthy();
  });

  it("yields an empty label for a blank source rather than throwing", () => {
    expect(getChatSourceMeta("   ").label).toBe("");
  });
});

describe("reaction emoji renderer seam", () => {
  it("returns null when no renderer is installed", () => {
    expect(renderChatReactionEmoji("thumbsup")).toBeNull();
  });

  it("delegates to an installed renderer", () => {
    const seen: string[] = [];
    registerChatReactionEmojiRenderer((emoji) => {
      seen.push(emoji);
      return `rendered:${emoji}` as unknown as null;
    });
    expect(renderChatReactionEmoji("heart")).toBe(
      "rendered:heart" as unknown as null,
    );
    expect(seen).toEqual(["heart"]);
  });

  it("normalizes a renderer returning null or undefined to null", () => {
    registerChatReactionEmojiRenderer(() => null);
    expect(renderChatReactionEmoji("x")).toBeNull();
    registerChatReactionEmojiRenderer(() => undefined as unknown as null);
    expect(renderChatReactionEmoji("x")).toBeNull();
  });

  it("can be uninstalled again", () => {
    registerChatReactionEmojiRenderer(() => "x" as unknown as null);
    registerChatReactionEmojiRenderer(null);
    expect(renderChatReactionEmoji("x")).toBeNull();
  });
});

describe("resolveChatVoiceSpeakerLabel", () => {
  const speaker = (value: Partial<ChatVoiceSpeaker>) =>
    value as ChatVoiceSpeaker;

  it("returns null when there is no speaker block", () => {
    expect(resolveChatVoiceSpeakerLabel(null)).toBeNull();
    expect(resolveChatVoiceSpeakerLabel(undefined)).toBeNull();
  });

  it("prefers the name, then the userName", () => {
    expect(
      resolveChatVoiceSpeakerLabel(speaker({ name: "Ada", userName: "ada99" })),
    ).toBe("Ada");
    expect(resolveChatVoiceSpeakerLabel(speaker({ userName: "ada99" }))).toBe(
      "ada99",
    );
  });

  it("treats a whitespace-only value as absent and falls through", () => {
    expect(
      resolveChatVoiceSpeakerLabel(speaker({ name: "   ", userName: "ada99" })),
    ).toBe("ada99");
    expect(
      resolveChatVoiceSpeakerLabel(speaker({ name: "   ", userName: "  " })),
    ).toBeNull();
  });

  it("trims the value it returns", () => {
    expect(resolveChatVoiceSpeakerLabel(speaker({ name: "  Ada  " }))).toBe(
      "Ada",
    );
  });

  it("ignores non-string label fields", () => {
    expect(
      resolveChatVoiceSpeakerLabel(speaker({ name: 42 as unknown as string })),
    ).toBeNull();
  });
});
