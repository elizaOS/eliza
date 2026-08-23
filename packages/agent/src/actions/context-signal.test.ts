/**
 * Covers context-signal helpers against the real keyword matcher and routing
 * merge: messageText extraction, empty vs single-text queues, strong/weak
 * hits, ASCII word-boundary misses, lexicon keys (including locale), selected
 * action-context overlap (general/page filtered), and the async DB backfill
 * vs state-capacity gate. Runtime doubles only stand in for IAgentRuntime
 * getMemories — the module under test is not mocked.
 */
import type { AgentContext, IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  CONTEXT_ROUTING_METADATA_KEY,
  CONTEXT_ROUTING_STATE_KEY,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  collectKeywordTermMatches,
  hasContextSignal,
  hasContextSignalSync,
  hasContextSignalSyncForKey,
  hasSelectedActionContext,
  hasSelectedContextOrSignalSync,
  messageText,
  textIncludesKeywordTerm,
} from "./context-signal.ts";

function messageWith(text: string, extras: Partial<Memory> = {}): Memory {
  return { content: { text }, ...extras } as Memory;
}

function stateWithRecent(recentMessages: string): State {
  return { values: { recentMessages }, data: {}, text: "" } as State;
}

function stateWithRouting(
  primaryContext: string,
  secondaryContexts: string[] = [],
): State {
  return {
    values: {
      [CONTEXT_ROUTING_STATE_KEY]: {
        primaryContext,
        secondaryContexts,
      },
    },
    data: {},
    text: "",
  } as State;
}

function runtimeWithMemories(
  memories: Array<{ content?: { text?: string } | undefined }>,
  onGetMemories?: () => void,
): IAgentRuntime {
  return {
    getMemories: async () => {
      onGetMemories?.();
      return memories;
    },
  } as unknown as IAgentRuntime;
}

describe("messageText", () => {
  it("returns empty string when content is missing", () => {
    expect(messageText({} as Memory)).toBe("");
    expect(messageText({ content: undefined } as unknown as Memory)).toBe("");
  });

  it("returns string content as-is", () => {
    expect(messageText({ content: "plain body" } as unknown as Memory)).toBe(
      "plain body",
    );
  });

  it("returns content.text when it is a string", () => {
    expect(messageText(messageWith("hello there"))).toBe("hello there");
  });

  it("returns empty string when content.text is not a string", () => {
    expect(messageText({ content: { text: 42 } } as unknown as Memory)).toBe(
      "",
    );
    expect(messageText({ content: { text: undefined } } as Memory)).toBe("");
  });
});

describe("re-exported keyword matcher", () => {
  it("matches whole ASCII words, not substrings", () => {
    expect(textIncludesKeywordTerm("please mail this", "mail")).toBe(true);
    expect(textIncludesKeywordTerm("gmail inbox", "mail")).toBe(false);
    expect(
      [...collectKeywordTermMatches(["browse the category"], ["cat"])].length,
    ).toBe(0);
    expect([...collectKeywordTermMatches(["I have a cat"], ["cat"])]).toEqual([
      "cat",
    ]);
  });
});

describe("hasContextSignalSync", () => {
  it("returns false for an empty text queue", () => {
    expect(hasContextSignalSync(messageWith(""), undefined, ["calendar"])).toBe(
      false,
    );
    expect(
      hasContextSignalSync(messageWith("   "), {} as State, ["calendar"]),
    ).toBe(false);
  });

  it("returns false when texts exist but both term lists are empty", () => {
    expect(
      hasContextSignalSync(messageWith("calendar tomorrow"), undefined, [], []),
    ).toBe(false);
  });

  it("activates on a single strong term in the current message", () => {
    expect(
      hasContextSignalSync(messageWith("open the calendar"), undefined, [
        "calendar",
      ]),
    ).toBe(true);
  });

  it("activates on a weak term when strong terms miss", () => {
    expect(
      hasContextSignalSync(
        messageWith("please forward this later"),
        undefined,
        ["calendar"],
        ["forward"],
      ),
    ).toBe(true);
  });

  it("activates when the only match lives in recent conversation state", () => {
    expect(
      hasContextSignalSync(
        messageWith("ok"),
        stateWithRecent("Alice: check the calendar tomorrow"),
        ["calendar"],
      ),
    ).toBe(true);
  });

  it("does not activate on an ASCII substring / word-boundary miss", () => {
    expect(
      hasContextSignalSync(messageWith("browse the category"), undefined, [
        "cat",
      ]),
    ).toBe(false);
    expect(
      hasContextSignalSync(messageWith("gmail inbox"), undefined, ["mail"]),
    ).toBe(false);
  });

  it("inspects the full state even when the deprecated contextLimit is 0", () => {
    expect(
      hasContextSignalSync(
        messageWith(""),
        stateWithRecent("calendar reminder"),
        ["calendar"],
        [],
        0,
      ),
    ).toBe(true);
  });

  it("returns false when no term is present", () => {
    expect(
      hasContextSignalSync(messageWith("what is the weather"), undefined, [
        "calendar",
      ]),
    ).toBe(false);
  });
});

describe("hasContextSignalSyncForKey", () => {
  it("activates on a gmail lexicon strong term", () => {
    expect(
      hasContextSignalSyncForKey(
        messageWith("check my gmail inbox"),
        undefined,
        "gmail",
      ),
    ).toBe(true);
  });

  it("does not activate a gmail key on unrelated text", () => {
    expect(
      hasContextSignalSyncForKey(
        messageWith("what is the weather in tokyo"),
        undefined,
        "gmail",
      ),
    ).toBe(false);
  });

  it("includes localized terms by default and can restrict to a locale", () => {
    const chineseMail = messageWith("请查看邮件");
    expect(hasContextSignalSyncForKey(chineseMail, undefined, "gmail")).toBe(
      true,
    );
    expect(
      hasContextSignalSyncForKey(chineseMail, undefined, "gmail", {
        includeAllLocales: false,
        locale: "en",
      }),
    ).toBe(false);
    expect(
      hasContextSignalSyncForKey(chineseMail, undefined, "gmail", {
        includeAllLocales: false,
        locale: "zh-CN",
      }),
    ).toBe(true);
  });

  it("prefers options.locale over state preferredLanguage", () => {
    const state = {
      values: { preferredLanguage: "en" },
      data: {},
      text: "",
    } as State;
    const chineseMail = messageWith("邮件");
    expect(
      hasContextSignalSyncForKey(chineseMail, state, "gmail", {
        includeAllLocales: false,
        locale: "zh-CN",
      }),
    ).toBe(true);
    expect(
      hasContextSignalSyncForKey(chineseMail, state, "gmail", {
        includeAllLocales: false,
      }),
    ).toBe(false);
  });
});

describe("hasSelectedActionContext", () => {
  it("returns false for an empty action-context list", () => {
    expect(
      hasSelectedActionContext(
        messageWith("hello"),
        stateWithRouting("code"),
        [],
      ),
    ).toBe(false);
  });

  it("returns false when every declared context is general or page-scoped", () => {
    expect(
      hasSelectedActionContext(messageWith("hello"), stateWithRouting("code"), [
        "general" as AgentContext,
        "page-settings" as AgentContext,
      ]),
    ).toBe(false);
  });

  it("returns false when there is no active routing overlap", () => {
    expect(
      hasSelectedActionContext(
        messageWith("hello"),
        stateWithRouting("social"),
        ["code" as AgentContext],
      ),
    ).toBe(false);
    expect(
      hasSelectedActionContext(messageWith("hello"), undefined, [
        "code" as AgentContext,
      ]),
    ).toBe(false);
  });

  it("returns true when state routing overlaps a declared context", () => {
    expect(
      hasSelectedActionContext(messageWith("hello"), stateWithRouting("code"), [
        "code" as AgentContext,
      ]),
    ).toBe(true);
  });

  it("matches secondary contexts and ignores case", () => {
    expect(
      hasSelectedActionContext(
        messageWith("hello"),
        stateWithRouting("social", ["wallet"]),
        ["WALLET" as AgentContext],
      ),
    ).toBe(true);
  });

  it("returns true when message metadata routing overlaps", () => {
    const message = {
      content: {
        text: "hello",
        metadata: {
          [CONTEXT_ROUTING_METADATA_KEY]: {
            primaryContext: "crypto",
            secondaryContexts: ["trading"],
          },
        },
      },
    } as unknown as Memory;
    expect(
      hasSelectedActionContext(message, undefined, ["trading" as AgentContext]),
    ).toBe(true);
  });
});

describe("hasSelectedContextOrSignalSync", () => {
  it("returns true from selected action context even without keyword hits", () => {
    expect(
      hasSelectedContextOrSignalSync(
        messageWith("hello"),
        stateWithRouting("code"),
        ["code" as AgentContext],
        ["calendar"],
      ),
    ).toBe(true);
  });

  it("falls back to the keyword signal when no context is selected", () => {
    expect(
      hasSelectedContextOrSignalSync(
        messageWith("open the calendar"),
        undefined,
        ["code" as AgentContext],
        ["calendar"],
      ),
    ).toBe(true);
    expect(
      hasSelectedContextOrSignalSync(
        messageWith("hello"),
        undefined,
        ["code" as AgentContext],
        ["calendar"],
      ),
    ).toBe(false);
  });
});

describe("hasContextSignal", () => {
  it("returns false for an empty text queue", async () => {
    await expect(
      hasContextSignal({} as IAgentRuntime, messageWith(""), undefined, [
        "calendar",
      ]),
    ).resolves.toBe(false);
  });

  it("activates from the current message without a DB round-trip", async () => {
    await expect(
      hasContextSignal(
        runtimeWithMemories([{ content: { text: "unrelated" } }]),
        messageWith("open the calendar"),
        undefined,
        ["calendar"],
      ),
    ).resolves.toBe(true);
  });

  it("backfills from room memories when state is thin", async () => {
    await expect(
      hasContextSignal(
        runtimeWithMemories([
          { content: { text: "Alice: open the calendar" } },
        ]),
        messageWith("ok", { roomId: "room-1" } as Partial<Memory>),
        stateWithRecent(""),
        ["calendar"],
      ),
    ).resolves.toBe(true);
  });

  it("skips getMemories when state already meets contextLimit (capacity gate)", async () => {
    let called = false;
    const runtime = runtimeWithMemories(
      [{ content: { text: "the only calendar mention" } }],
      () => {
        called = true;
      },
    );
    const state = stateWithRecent("hello\nworld");
    const matched = await hasContextSignal(
      runtime,
      messageWith("ok", { roomId: "room-1" } as Partial<Memory>),
      state,
      ["calendar"],
      [],
      2,
    );
    expect(called).toBe(false);
    expect(matched).toBe(false);
  });

  it("still inspects the current message after the capacity gate skips the DB", async () => {
    let called = false;
    const matched = await hasContextSignal(
      runtimeWithMemories([{ content: { text: "ignored" } }], () => {
        called = true;
      }),
      messageWith("open the calendar", { roomId: "room-1" } as Partial<Memory>),
      stateWithRecent("hello\nworld"),
      ["calendar"],
      [],
      2,
    );
    expect(called).toBe(false);
    expect(matched).toBe(true);
  });

  it("treats contextLimit 0 with empty state as already-full and skips the DB", async () => {
    let called = false;
    const matched = await hasContextSignal(
      runtimeWithMemories(
        [{ content: { text: "the only calendar mention" } }],
        () => {
          called = true;
        },
      ),
      messageWith("", { roomId: "room-1" } as Partial<Memory>),
      undefined,
      ["calendar"],
      [],
      0,
    );
    expect(called).toBe(false);
    expect(matched).toBe(false);
  });

  it("falls back to state texts when getMemories throws", async () => {
    const runtime = {
      getMemories: async () => {
        throw new Error("db unavailable");
      },
    } as unknown as IAgentRuntime;
    await expect(
      hasContextSignal(
        runtime,
        messageWith("ok", { roomId: "room-1" } as Partial<Memory>),
        stateWithRecent("calendar reminder"),
        ["calendar"],
      ),
    ).resolves.toBe(true);
  });

  it("activates on a weak term from backfilled memories", async () => {
    await expect(
      hasContextSignal(
        runtimeWithMemories([{ content: { text: "please forward this" } }]),
        messageWith("ok", { roomId: "room-1" } as Partial<Memory>),
        undefined,
        ["calendar"],
        ["forward"],
      ),
    ).resolves.toBe(true);
  });
});
