// Unit coverage for the pure chat-input/streaming parsers in state/parsers.ts.
// These drive slash commands, custom-action argument binding, streamed-text
// reconciliation, and startup-error formatting — all chat-surface behavior with
// real branching. Pure functions, no harness.

import { describe, expect, it } from "vitest";
import type { CustomActionDef } from "../api/client";
import {
  asApiLikeError,
  formatSearchBullet,
  formatStartupErrorDetail,
  isRecord,
  normalizeCustomActionName,
  normalizeStreamComparisonText,
  parseAgentStartupDiagnostics,
  parseAgentStatusEvent,
  parseAgentStatusFromMainMenuResetPayload,
  parseConversationMessageEvent,
  parseCustomActionParams,
  parseProactiveMessageEvent,
  parseSlashCommandInput,
  parseStreamEventEnvelopeEvent,
  shouldApplyFinalStreamText,
} from "./parsers";

/**
 * Test fixture carrying only the fields `parseCustomActionParams` reads
 * (`parameters[].name` / `.required`). The unused `handler` is omitted, so the
 * partial is cast through `unknown` — never invoked, so the stub is irrelevant.
 */
function action(
  parameters: Array<{ name: string; required?: boolean }>,
): CustomActionDef {
  return {
    id: "act-1",
    name: "CUSTOM",
    description: "",
    parameters: parameters.map((p) => ({
      name: p.name,
      description: "",
      required: p.required ?? false,
    })),
    enabled: true,
    createdAt: "",
    updatedAt: "",
  } as unknown as CustomActionDef;
}

describe("isRecord", () => {
  it("is true only for non-null objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(5)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("parseSlashCommandInput", () => {
  it("returns null for non-slash or empty bodies", () => {
    expect(parseSlashCommandInput("hello")).toBeNull();
    expect(parseSlashCommandInput("/")).toBeNull();
    expect(parseSlashCommandInput("/   ")).toBeNull();
  });

  it("parses a bare command and lowercases/prefixes the name", () => {
    expect(parseSlashCommandInput("/Help")).toEqual({
      name: "/help",
      argsRaw: "",
    });
  });

  it("splits the name from the args at the first whitespace", () => {
    expect(parseSlashCommandInput("/Send  hi   there")).toEqual({
      name: "/send",
      argsRaw: "hi   there",
    });
  });
});

describe("normalizeCustomActionName", () => {
  it("uppercases and collapses spaces/dashes to underscores", () => {
    expect(normalizeCustomActionName("send message")).toBe("SEND_MESSAGE");
    expect(normalizeCustomActionName("  my-cool-action ")).toBe(
      "MY_COOL_ACTION",
    );
  });
});

describe("parseCustomActionParams", () => {
  it("binds named key=value args to canonical parameter names", () => {
    const { params, missingRequired } = parseCustomActionParams(
      action([{ name: "To", required: true }, { name: "body" }]),
      "to=alice body=hello",
    );
    expect(params).toEqual({ To: "alice", body: "hello" });
    expect(missingRequired).toEqual([]);
  });

  it("fills positional args in declared parameter order", () => {
    const { params } = parseCustomActionParams(
      action([{ name: "to" }, { name: "body" }]),
      "alice hello",
    );
    expect(params).toEqual({ to: "alice", body: "hello" });
  });

  it("routes overflow positional tokens into a sink param (input/text/...)", () => {
    const { params } = parseCustomActionParams(
      action([{ name: "input" }]),
      "hello world extra",
    );
    expect(params).toEqual({ input: "hello world extra" });
  });

  it("reports required params that were never supplied", () => {
    const { missingRequired } = parseCustomActionParams(
      action([{ name: "to", required: true }]),
      "",
    );
    expect(missingRequired).toEqual(["to"]);
  });

  it("keeps quoted positional values intact", () => {
    const { params } = parseCustomActionParams(
      action([{ name: "input" }]),
      '"hello world"',
    );
    expect(params).toEqual({ input: "hello world" });
  });

  it("binds quoted multi-word values to named args (double + single quotes)", () => {
    expect(
      parseCustomActionParams(
        action([{ name: "to", required: true }, { name: "subject" }]),
        "to=\"Alice Smith\" subject='Lunch plans'",
      ).params,
    ).toEqual({ to: "Alice Smith", subject: "Lunch plans" });
  });
});

describe("streamed-text reconciliation", () => {
  it("normalizeStreamComparisonText collapses whitespace and trims", () => {
    expect(normalizeStreamComparisonText("a  b\n c ")).toBe("a b c");
  });

  it("shouldApplyFinalStreamText only when final adds real content", () => {
    expect(shouldApplyFinalStreamText("", "final answer")).toBe(true);
    expect(shouldApplyFinalStreamText("final", "final")).toBe(false);
    // Whitespace-only difference → already shown, don't re-apply.
    expect(shouldApplyFinalStreamText("hello world", "hello  world")).toBe(
      false,
    );
    // Genuinely different final text → apply.
    expect(shouldApplyFinalStreamText("hi", "hello there")).toBe(true);
    // Empty final → never apply.
    expect(shouldApplyFinalStreamText("hi", "   ")).toBe(false);
  });
});

describe("formatSearchBullet", () => {
  it("formats an empty list and a bulleted list", () => {
    expect(formatSearchBullet("Items", [])).toBe("Items: none");
    expect(formatSearchBullet("Items", ["a", "b"])).toBe("Items:\n- a\n- b");
  });
});

describe("asApiLikeError + formatStartupErrorDetail", () => {
  it("extracts an API-shaped error and ignores non-API objects", () => {
    expect(
      asApiLikeError({
        kind: "http",
        status: 404,
        path: "/x",
        message: "nope",
      }),
    ).toEqual({ kind: "http", status: 404, path: "/x", message: "nope" });
    expect(asApiLikeError({ status: 500 })).toEqual({
      kind: undefined,
      status: 500,
      path: undefined,
      message: undefined,
    });
    expect(asApiLikeError({ foo: 1 })).toBeNull();
    expect(asApiLikeError("nope")).toBeNull();
  });

  it("formats startup error detail from API errors and Error instances", () => {
    expect(
      formatStartupErrorDetail({
        path: "/api/x",
        status: 500,
        message: "boom",
      }),
    ).toBe("/api/x - HTTP 500 - boom");
    expect(formatStartupErrorDetail(new Error("oops"))).toBe("oops");
    expect(formatStartupErrorDetail({})).toBeUndefined();
    expect(formatStartupErrorDetail("plain string")).toBeUndefined();
  });
});

describe("parseStreamEventEnvelopeEvent", () => {
  const valid = {
    type: "agent_event",
    eventId: "e1",
    ts: 123,
    payload: { foo: 1 },
  };

  it("accepts the known envelope types and stamps version 1", () => {
    expect(parseStreamEventEnvelopeEvent(valid)).toEqual({
      type: "agent_event",
      version: 1,
      eventId: "e1",
      ts: 123,
      payload: { foo: 1 },
    });
    expect(
      parseStreamEventEnvelopeEvent({ ...valid, type: "heartbeat_event" }),
    ).not.toBeNull();
  });

  it("rejects unknown types or malformed required fields", () => {
    expect(
      parseStreamEventEnvelopeEvent({ ...valid, type: "nope" }),
    ).toBeNull();
    expect(parseStreamEventEnvelopeEvent({ ...valid, eventId: 5 })).toBeNull();
    expect(parseStreamEventEnvelopeEvent({ ...valid, ts: "123" })).toBeNull();
    expect(
      parseStreamEventEnvelopeEvent({ ...valid, payload: "no" }),
    ).toBeNull();
  });

  it("copies optional fields only when correctly typed", () => {
    const env = parseStreamEventEnvelopeEvent({
      ...valid,
      runId: "r1",
      seq: 4,
      agentId: "a1",
      stream: 99, // wrong type → ignored
    });
    expect(env?.runId).toBe("r1");
    expect(env?.seq).toBe(4);
    expect(env?.agentId).toBe("a1");
    expect(env?.stream).toBeUndefined();
  });
});

describe("parseConversationMessageEvent", () => {
  it("parses a minimal valid message and rejects malformed ones", () => {
    expect(
      parseConversationMessageEvent({
        id: "m1",
        role: "assistant",
        text: "hi",
        timestamp: 10,
      }),
    ).toEqual({ id: "m1", role: "assistant", text: "hi", timestamp: 10 });

    expect(parseConversationMessageEvent(null)).toBeNull();
    expect(
      parseConversationMessageEvent({
        id: "m1",
        role: "bot",
        text: "x",
        timestamp: 1,
      }),
    ).toBeNull();
    expect(
      parseConversationMessageEvent({ id: "m1", role: "user", timestamp: 1 }),
    ).toBeNull();
  });

  it("carries optional fields and filters actionCallbackHistory", () => {
    const parsed = parseConversationMessageEvent({
      id: "m1",
      role: "assistant",
      text: "hi",
      timestamp: 10,
      source: "discord",
      actionCallbackHistory: ["a", "", "  ", "b", 5],
    });
    expect(parsed?.source).toBe("discord");
    expect(parsed?.actionCallbackHistory).toEqual(["a", "b"]);
  });

  it("validates reactions (drops empty emoji / non-positive count) and users", () => {
    const parsed = parseConversationMessageEvent({
      id: "m1",
      role: "assistant",
      text: "hi",
      timestamp: 10,
      reactions: [
        { emoji: "👍", count: 2, users: ["u1", "", "u2"] },
        { emoji: "", count: 3 }, // empty emoji → dropped
        { emoji: "🔥", count: 0 }, // non-positive count → dropped
      ],
    });
    expect(parsed?.reactions).toEqual([
      { emoji: "👍", count: 2, users: ["u1", "u2"] },
    ]);
  });
});

describe("parseProactiveMessageEvent", () => {
  it("wraps a valid conversation message under its conversationId", () => {
    expect(
      parseProactiveMessageEvent({
        conversationId: "c1",
        message: { id: "m1", role: "assistant", text: "hi", timestamp: 1 },
      }),
    ).toEqual({
      conversationId: "c1",
      message: { id: "m1", role: "assistant", text: "hi", timestamp: 1 },
    });
  });

  it("returns null when the id or the inner message is invalid", () => {
    expect(
      parseProactiveMessageEvent({
        message: { id: "m1", role: "assistant", text: "hi", timestamp: 1 },
      }),
    ).toBeNull();
    expect(
      parseProactiveMessageEvent({ conversationId: "c1", message: { bad: 1 } }),
    ).toBeNull();
  });
});

describe("parseAgentStatusEvent", () => {
  it("accepts a known state + agentName and rejects unknown/malformed", () => {
    const status = parseAgentStatusEvent({ state: "running", agentName: "A" });
    expect(status?.state).toBe("running");
    expect(status?.agentName).toBe("A");
    expect(
      parseAgentStatusEvent({ state: "bogus", agentName: "A" }),
    ).toBeNull();
    expect(
      parseAgentStatusEvent({ state: "running", agentName: 5 }),
    ).toBeNull();
  });

  it("carries canRespond only when boolean (server readiness signal)", () => {
    expect(
      parseAgentStatusEvent({
        state: "running",
        agentName: "A",
        canRespond: true,
      })?.canRespond,
    ).toBe(true);
    // Non-boolean canRespond is dropped, not coerced.
    expect(
      "canRespond" in
        (parseAgentStatusEvent({
          state: "running",
          agentName: "A",
          canRespond: "yes",
        }) ?? {}),
    ).toBe(false);
  });

  it("nests startup diagnostics when present", () => {
    expect(
      parseAgentStatusEvent({
        state: "starting",
        agentName: "A",
        startup: { phase: "boot", attempt: 2 },
      })?.startup,
    ).toEqual({ phase: "boot", attempt: 2 });
  });
});

describe("parseAgentStatusFromMainMenuResetPayload", () => {
  it("extracts a nested agentStatus or returns null", () => {
    expect(
      parseAgentStatusFromMainMenuResetPayload({
        agentStatus: { state: "running", agentName: "A" },
      })?.state,
    ).toBe("running");
    expect(parseAgentStatusFromMainMenuResetPayload({})).toBeNull();
    expect(
      parseAgentStatusFromMainMenuResetPayload({ agentStatus: null }),
    ).toBeNull();
    expect(parseAgentStatusFromMainMenuResetPayload(["x"])).toBeNull();
  });
});

describe("parseAgentStartupDiagnostics", () => {
  it("requires phase + attempt and is undefined otherwise", () => {
    expect(parseAgentStartupDiagnostics({ phase: "boot", attempt: 1 })).toEqual(
      {
        phase: "boot",
        attempt: 1,
      },
    );
    expect(parseAgentStartupDiagnostics({ phase: "boot" })).toBeUndefined();
    expect(parseAgentStartupDiagnostics(null)).toBeUndefined();
  });

  it("gates embeddingPhase to the known enum and clamps progress to 0..100", () => {
    const ok = parseAgentStartupDiagnostics({
      phase: "embedding",
      attempt: 1,
      embeddingPhase: "downloading",
      embeddingProgressPct: 150,
    });
    expect(ok?.embeddingPhase).toBe("downloading");
    expect(ok?.embeddingProgressPct).toBe(100);

    const gated = parseAgentStartupDiagnostics({
      phase: "embedding",
      attempt: 1,
      embeddingPhase: "bogus",
      embeddingProgressPct: -20,
    });
    expect(gated?.embeddingPhase).toBeUndefined();
    expect(gated?.embeddingProgressPct).toBe(0);
  });
});
