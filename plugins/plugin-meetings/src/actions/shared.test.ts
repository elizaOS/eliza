import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import type { MeetingSession } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import type { MeetingService } from "../service.js";
import {
  findMeetingUrlInText,
  messageText,
  optionString,
  reply,
  requireMeetingService,
  resolveMeetingUrl,
  resolveTargetSession,
} from "./shared.js";

const MEET = "https://meet.google.com/abc-defg-hij";

function msg(text?: unknown): Memory {
  return { content: text === undefined ? {} : { text } } as Memory;
}

function session(over: Partial<MeetingSession>): MeetingSession {
  return {
    id: "s1",
    platform: "google_meet",
    meetingUrl: MEET,
    nativeMeetingId: "abc-defg-hij",
    botName: "Eliza Notetaker",
    status: "active",
    requestedAt: 1,
    roomId: "r1",
    transcriptId: "t1",
    participants: [],
    ...over,
  } as MeetingSession;
}

describe("messageText", () => {
  it("returns text when a string, empty otherwise", () => {
    expect(messageText(msg("hi"))).toBe("hi");
    expect(messageText(msg(undefined))).toBe("");
    expect(messageText(msg(42))).toBe("");
    expect(messageText(null)).toBe("");
    expect(messageText({ content: null } as unknown as Memory)).toBe("");
  });
});

describe("optionString", () => {
  it("reads top-level and nested parameters", () => {
    expect(optionString({ botName: "Bot" }, "botName")).toBe("Bot");
    expect(optionString({ parameters: { botName: "Bot" } }, "botName")).toBe(
      "Bot",
    );
    expect(optionString({ parameters: { language: "en" } }, "language")).toBe(
      "en",
    );
  });
  it("trims and rejects non-strings / blanks / bad shapes", () => {
    expect(optionString({ botName: "  Bot  " }, "botName")).toBe("Bot");
    expect(optionString({ botName: "   " }, "botName")).toBeNull();
    expect(optionString({ botName: 5 }, "botName")).toBeNull();
    expect(optionString(null, "botName")).toBeNull();
    expect(optionString("string", "botName")).toBeNull();
  });
  it("prefers top-level over nested", () => {
    expect(
      optionString(
        { botName: "Top", parameters: { botName: "Nested" } },
        "botName",
      ),
    ).toBe("Top");
  });
});

describe("findMeetingUrlInText — adversarial", () => {
  it("finds a bare meeting URL", () => {
    expect(findMeetingUrlInText(`join ${MEET}`)?.nativeMeetingId).toBe(
      "abc-defg-hij",
    );
  });
  it("skips a non-meeting URL and takes the meeting one after it", () => {
    const parsed = findMeetingUrlInText(
      `see https://example.com/docs then ${MEET}`,
    );
    expect(parsed?.platform).toBe("google_meet");
  });
  it("returns the first recognizable meeting URL when several are present", () => {
    const parsed = findMeetingUrlInText(
      `https://meet.google.com/aaa-bbbb-ccc and https://meet.google.com/xxx-yyyy-zzz`,
    );
    expect(parsed?.nativeMeetingId).toBe("aaa-bbbb-ccc");
  });
  it("strips trailing punctuation", () => {
    expect(findMeetingUrlInText(`${MEET}.`)?.nativeMeetingId).toBe(
      "abc-defg-hij",
    );
    expect(findMeetingUrlInText(`${MEET}!?`)?.nativeMeetingId).toBe(
      "abc-defg-hij",
    );
  });
  it("handles markdown/angle/bracket-wrapped links", () => {
    expect(findMeetingUrlInText(`(${MEET})`)?.nativeMeetingId).toBe(
      "abc-defg-hij",
    );
    expect(findMeetingUrlInText(`<${MEET}>`)?.nativeMeetingId).toBe(
      "abc-defg-hij",
    );
    expect(findMeetingUrlInText(`[${MEET}]`)?.nativeMeetingId).toBe(
      "abc-defg-hij",
    );
  });
  it("returns null for empty text and non-meeting URLs", () => {
    expect(findMeetingUrlInText("")).toBeNull();
    expect(findMeetingUrlInText("no links here")).toBeNull();
    expect(
      findMeetingUrlInText("https://example.com/not-a-meeting"),
    ).toBeNull();
  });
  it("handles very long text", () => {
    const long = `${"x ".repeat(50_000)}${MEET}`;
    expect(findMeetingUrlInText(long)?.nativeMeetingId).toBe("abc-defg-hij");
  });
});

describe("resolveMeetingUrl — option vs text", () => {
  it("prefers an explicit meetingUrl option (top-level and nested)", () => {
    expect(
      resolveMeetingUrl(msg("ignore me"), { meetingUrl: MEET })?.platform,
    ).toBe("google_meet");
    expect(
      resolveMeetingUrl(msg(""), { parameters: { url: MEET } })?.platform,
    ).toBe("google_meet");
  });
  it("falls back to message text when the option is not a meeting URL", () => {
    expect(
      resolveMeetingUrl(msg(MEET), { meetingUrl: "https://example.com" })
        ?.nativeMeetingId,
    ).toBe("abc-defg-hij");
  });
  it("returns null when neither source has a meeting URL", () => {
    expect(resolveMeetingUrl(msg("hello"), {})).toBeNull();
    expect(resolveMeetingUrl(msg(undefined), undefined)).toBeNull();
  });
});

function collect(): { cb: HandlerCallback; sent: string[] } {
  const sent: string[] = [];
  const cb = (async (content: { text?: string }) => {
    sent.push(content.text ?? "");
    return [];
  }) as unknown as HandlerCallback;
  return { cb, sent };
}

describe("reply", () => {
  it("sends the callback and returns the matching ActionResult", async () => {
    const { cb, sent } = collect();
    const res = await reply(cb, true, "hi", { sessionId: "s1" });
    expect(sent).toEqual(["hi"]);
    expect(res).toEqual({
      success: true,
      text: "hi",
      data: { sessionId: "s1" },
    });
  });
  it("omits data when not provided and tolerates an undefined callback", async () => {
    const res = await reply(undefined, false, "nope");
    expect(res).toEqual({ success: false, text: "nope" });
  });
});

function runtimeWith(service: MeetingService | null): IAgentRuntime {
  return { getService: () => service } as unknown as IAgentRuntime;
}

describe("requireMeetingService", () => {
  it("returns the service when running", async () => {
    const service = {} as MeetingService;
    const { cb, sent } = collect();
    const out = await requireMeetingService(runtimeWith(service), cb, "down");
    expect("service" in out && out.service).toBe(service);
    expect(sent).toEqual([]);
  });
  it("replies and bails with the exact text when not running", async () => {
    const { cb, sent } = collect();
    const out = await requireMeetingService(runtimeWith(null), cb, "down");
    expect(sent).toEqual(["down"]);
    expect("bail" in out && out.bail).toEqual({ success: false, text: "down" });
  });
});

describe("resolveTargetSession", () => {
  const a = session({ id: "a", nativeMeetingId: "abc-defg-hij" });
  const b = session({
    id: "b",
    platform: "zoom",
    nativeMeetingId: "1234567890",
  });

  it("matches an explicit sessionId; unknown id → null (never fallback)", () => {
    expect(
      resolveTargetSession([a, b], msg(""), { sessionId: "b" }, "most-recent"),
    ).toBe(b);
    expect(
      resolveTargetSession(
        [a, b],
        msg(""),
        { parameters: { sessionId: "a" } },
        "single-or-ambiguous",
      ),
    ).toBe(a);
    expect(
      resolveTargetSession(
        [a, b],
        msg(""),
        { sessionId: "nope" },
        "most-recent",
      ),
    ).toBeNull();
  });

  it("matches by meeting URL in the message; unknown URL → null", () => {
    expect(
      resolveTargetSession(
        [a, b],
        msg(`leave ${MEET}`),
        {},
        "single-or-ambiguous",
      ),
    ).toBe(a);
    expect(
      resolveTargetSession(
        [a, b],
        msg("leave https://meet.google.com/zzz-zzzz-zzz"),
        {},
        "single-or-ambiguous",
      ),
    ).toBeNull();
  });

  it("single-or-ambiguous fallback", () => {
    expect(
      resolveTargetSession([a], msg("leave"), {}, "single-or-ambiguous"),
    ).toBe(a);
    expect(
      resolveTargetSession([a, b], msg("leave"), {}, "single-or-ambiguous"),
    ).toBe("ambiguous");
    expect(
      resolveTargetSession([], msg("leave"), {}, "single-or-ambiguous"),
    ).toBeNull();
  });

  it("most-recent fallback picks the newest (first) session, never ambiguous", () => {
    expect(resolveTargetSession([a, b], msg("notes"), {}, "most-recent")).toBe(
      a,
    );
    expect(
      resolveTargetSession([], msg("notes"), {}, "most-recent"),
    ).toBeNull();
  });
});
