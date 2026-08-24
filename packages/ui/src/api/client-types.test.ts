/**
 * Unit coverage for the ElizaClient DTO barrel (api/client-types.ts): pins the
 * runtime re-export identity of every value module it aggregates and drives
 * that surface through the single import path consumers use — ApiError
 * construction and the error guards, the ConversationMessage boundary guard,
 * and the two pure coding-agent session mappers. Deterministic fixtures only,
 * no network.
 */
import { describe, expect, test } from "vitest";
import * as barrel from "./client-types";
import { isConversationMessage } from "./client-types-chat";
import {
  type CodingAgentTaskThread,
  mapAcpSessionsToCodingAgentSessions,
  mapTaskThreadsToCodingAgentSessions,
  type RawAcpSession,
} from "./client-types-cloud";
import {
  ApiError,
  isApiError,
  isCloudAgentGoneError,
  isRateLimitedError,
} from "./client-types-core";

describe("client-types barrel re-exports", () => {
  test("exposes the core error class and guards by identity", () => {
    expect(barrel.ApiError).toBe(ApiError);
    expect(barrel.isApiError).toBe(isApiError);
    expect(barrel.isRateLimitedError).toBe(isRateLimitedError);
    expect(barrel.isCloudAgentGoneError).toBe(isCloudAgentGoneError);
  });

  test("exposes the chat message guard by identity", () => {
    expect(barrel.isConversationMessage).toBe(isConversationMessage);
  });

  test("exposes the coding-agent session mappers by identity", () => {
    expect(barrel.mapAcpSessionsToCodingAgentSessions).toBe(
      mapAcpSessionsToCodingAgentSessions,
    );
    expect(barrel.mapTaskThreadsToCodingAgentSessions).toBe(
      mapTaskThreadsToCodingAgentSessions,
    );
  });
});

describe("ApiError", () => {
  test("carries kind, path, message, status, code and retryAfter", () => {
    const error = new ApiError({
      kind: "http",
      path: "/api/agents",
      message: "boom",
      status: 500,
      code: "internal_error",
      retryAfter: 30,
    });
    expect(error.name).toBe("ApiError");
    expect(error.kind).toBe("http");
    expect(error.path).toBe("/api/agents");
    expect(error.message).toBe("boom");
    expect(error.status).toBe(500);
    expect(error.code).toBe("internal_error");
    expect(error.retryAfter).toBe(30);
  });

  test("is a real Error", () => {
    const error = new ApiError({
      kind: "timeout",
      path: "/api/messages",
      message: "timed out",
    });
    expect(error).toBeInstanceOf(Error);
  });

  test("keeps the parsed body on data as a non-enumerable, read-only field", () => {
    const body = { error: "quota exhausted" };
    const error = new ApiError({
      kind: "http",
      path: "/api/agents",
      message: "quota",
      data: body,
    });
    expect(error.data).toEqual(body);
    expect(Object.keys(error)).not.toContain("data");
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("data");
    expect(() => {
      (error as { data: unknown }).data = { swapped: true };
    }).toThrow(TypeError);
  });

  test("leaves data undefined when the response carried no body", () => {
    const error = new ApiError({
      kind: "network",
      path: "/api/agents",
      message: "offline",
    });
    expect(error.data).toBeUndefined();
  });

  test("preserves an explicit cause", () => {
    const cause = new Error("socket closed");
    const error = new ApiError({
      kind: "network",
      path: "/api/agents",
      message: "wrapped",
      cause,
    });
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

describe("isApiError", () => {
  test("accepts only ApiError instances", () => {
    const error = new ApiError({
      kind: "parse",
      path: "/api/agents",
      message: "bad json",
    });
    expect(isApiError(error)).toBe(true);
    const lookalike = Object.assign(new Error("bad json"), {
      kind: "parse",
      path: "/api/agents",
    });
    expect(isApiError(lookalike)).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError("bad json")).toBe(false);
    expect(isApiError(42)).toBe(false);
  });
});

describe("isRateLimitedError", () => {
  test("classifies by 429 status alone", () => {
    const error = new ApiError({
      kind: "http",
      path: "/api/messages",
      status: 429,
      message: "slow down",
    });
    expect(isRateLimitedError(error)).toBe(true);
  });

  test("classifies by rate_limit_exceeded code even on another status", () => {
    const error = new ApiError({
      kind: "http",
      path: "/api/messages",
      status: 200,
      code: "rate_limit_exceeded",
      message: "slow down",
    });
    expect(isRateLimitedError(error)).toBe(true);
  });

  test("rejects other statuses, other codes and non-ApiErrors", () => {
    expect(
      isRateLimitedError(
        new ApiError({
          kind: "http",
          path: "/api/messages",
          status: 500,
          code: "internal_error",
          message: "boom",
        }),
      ),
    ).toBe(false);
    expect(
      isRateLimitedError(
        new ApiError({
          kind: "http",
          path: "/api/messages",
          status: 500,
          message: "no code",
        }),
      ),
    ).toBe(false);
    expect(
      isRateLimitedError(
        Object.assign(new Error("slow down"), { status: 429 }),
      ),
    ).toBe(false);
  });
});

describe("isCloudAgentGoneError", () => {
  function gone(status?: number): ApiError {
    return new ApiError({
      kind: "http",
      path: "/api/coding-agents/agent-1",
      status,
      code: "agent_not_found",
      message: "no such agent",
    });
  }

  test("accepts the structured agent_not_found code with a 404 or no status", () => {
    expect(isCloudAgentGoneError(gone(404))).toBe(true);
    expect(isCloudAgentGoneError(gone(undefined))).toBe(true);
  });

  test("rejects agent_not_found on any other concrete status", () => {
    expect(isCloudAgentGoneError(gone(500))).toBe(false);
  });

  test("walks the cause chain to find the definitive shape", () => {
    const wrapped = new Error("selection failed", { cause: gone(404) });
    expect(isCloudAgentGoneError(wrapped)).toBe(true);
  });

  test("treats recoverable cold states as not-gone unless the cause proves otherwise", () => {
    const cold = new ApiError({
      kind: "http",
      path: "/api/coding-agents/agent-1",
      status: 503,
      code: "agent_not_running",
      message: "cold",
    });
    expect(isCloudAgentGoneError(cold)).toBe(false);
    const coldWrappingGone = new ApiError({
      kind: "http",
      path: "/api/coding-agents/agent-1",
      status: 503,
      code: "agent_not_running",
      message: "cold but actually deleted",
      cause: gone(404),
    });
    expect(isCloudAgentGoneError(coldWrappingGone)).toBe(true);
  });

  test("does not classify legacy code-less 404 bodies", () => {
    const legacy = new ApiError({
      kind: "http",
      path: "/api/coding-agents/agent-1",
      status: 404,
      message: "not found",
    });
    expect(isCloudAgentGoneError(legacy)).toBe(false);
  });

  test("gives up after five cause hops", () => {
    let deepest = gone(404);
    for (let depth = 0; depth < 4; depth += 1) {
      deepest = new Error(`wrap ${depth}`, { cause: deepest }) as never;
    }
    // The loop inspects at most five nodes: four wrappers plus the match.
    expect(isCloudAgentGoneError(deepest)).toBe(true);
    const oneTooDeep = new Error("one more wrap", { cause: deepest });
    expect(isCloudAgentGoneError(oneTooDeep)).toBe(false);
  });

  test("returns false for plain errors and non-errors", () => {
    expect(isCloudAgentGoneError(new Error("generic"))).toBe(false);
    expect(isCloudAgentGoneError(null)).toBe(false);
    expect(isCloudAgentGoneError(undefined)).toBe(false);
  });
});

describe("isConversationMessage", () => {
  const valid = {
    id: "msg-1",
    role: "user",
    text: "hello",
    timestamp: 1756000000000,
  };

  test("accepts user and assistant messages with all required fields", () => {
    expect(isConversationMessage(valid)).toBe(true);
    expect(isConversationMessage({ ...valid, role: "assistant" })).toBe(true);
  });

  test("requires a non-empty string id", () => {
    expect(isConversationMessage({ ...valid, id: "" })).toBe(false);
    expect(isConversationMessage({ ...valid, id: 7 })).toBe(false);
    const { id: _missing, ...noId } = valid;
    expect(isConversationMessage(noId)).toBe(false);
  });

  test("only accepts the user and assistant roles", () => {
    expect(isConversationMessage({ ...valid, role: "system" })).toBe(false);
    expect(isConversationMessage({ ...valid, role: "agent" })).toBe(false);
  });

  test("requires string text and a finite numeric timestamp", () => {
    expect(isConversationMessage({ ...valid, text: 42 })).toBe(false);
    expect(isConversationMessage({ ...valid, timestamp: Number.NaN })).toBe(
      false,
    );
    expect(
      isConversationMessage({ ...valid, timestamp: Number.POSITIVE_INFINITY }),
    ).toBe(false);
    // Observed boundary: the guard checks finiteness only, so negative
    // timestamps pass.
    expect(isConversationMessage({ ...valid, timestamp: -1 })).toBe(true);
  });

  test("rejects primitives", () => {
    expect(isConversationMessage(null)).toBe(false);
    expect(isConversationMessage(undefined)).toBe(false);
    expect(isConversationMessage("hello")).toBe(false);
    expect(isConversationMessage(42)).toBe(false);
  });
});

describe("mapAcpSessionsToCodingAgentSessions", () => {
  test("maps an empty list to an empty list", () => {
    expect(mapAcpSessionsToCodingAgentSessions([])).toEqual([]);
  });

  test("maps every raw field and zeroes UI-only counters in input order", () => {
    const sessions: RawAcpSession[] = [
      {
        id: "acp-1",
        name: "Builder",
        agentType: "codex",
        workdir: "/repo/eliza",
        status: "busy",
        metadata: { label: "Pinned builder" },
      },
      { id: "acp-2" },
    ];
    expect(mapAcpSessionsToCodingAgentSessions(sessions)).toEqual([
      {
        sessionId: "acp-1",
        agentType: "codex",
        label: "Pinned builder",
        originalTask: "",
        workdir: "/repo/eliza",
        status: "active",
        decisionCount: 0,
        autoResolvedCount: 0,
      },
      {
        sessionId: "acp-2",
        agentType: "claude",
        label: "Agent",
        originalTask: "",
        workdir: "",
        status: "active",
        decisionCount: 0,
        autoResolvedCount: 0,
      },
    ]);
  });

  test("falls back through metadata label, name and agentType for the label", () => {
    const [byName, byAgentType] = mapAcpSessionsToCodingAgentSessions([
      { id: "a", name: "Named session", agentType: "codex" },
      { id: "b", agentType: "opencode" },
    ]);
    expect(byName.label).toBe("Named session");
    expect(byAgentType.label).toBe("opencode");
  });

  test.each([
    ["ready", "active"],
    ["busy", "active"],
    ["error", "error"],
    ["stopped", "stopped"],
    ["done", "stopped"],
    ["completed", "stopped"],
    ["exited", "stopped"],
    ["running", "active"],
  ])("maps acp status %s to %s", (raw, expected) => {
    const [mapped] = mapAcpSessionsToCodingAgentSessions([
      { id: "s", status: raw },
    ]);
    expect(mapped.status).toBe(expected);
  });
});

describe("mapTaskThreadsToCodingAgentSessions", () => {
  function makeThread(
    status: CodingAgentTaskThread["status"],
    overrides: {
      title?: string;
      summary?: string;
      latestSessionId?: string | null;
      latestSessionLabel?: string | null;
      latestWorkdir?: string | null;
      latestRepo?: string | null;
    } = {},
  ): CodingAgentTaskThread {
    const thread: CodingAgentTaskThread = {
      id: "thread-1",
      title: "Ship the barrel tests",
      kind: "task",
      status,
      priority: "normal",
      paused: false,
      originalRequest: "cover client-types",
      sessionCount: 2,
      activeSessionCount: 1,
      latestSessionId: "sess-9",
      latestSessionLabel: "session nine",
      latestWorkdir: "/repo/eliza",
      latestRepo: "eliza",
      projectId: null,
      latestActivityAt: 1756000000000,
      latestSessionModel: null,
      latestAccountProviderId: null,
      latestAccountId: null,
      latestAccountLabel: null,
      parentTaskId: null,
      decisionCount: 3,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheTokens: 0,
        totalTokens: 30,
        costUsd: 0.01,
        state: "measured",
        byProvider: [],
      },
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T01:00:00Z",
      closedAt: null,
      archivedAt: null,
    };
    if (overrides.title !== undefined) {
      thread.title = overrides.title;
    }
    if (overrides.summary !== undefined) {
      thread.summary = overrides.summary;
    }
    if (overrides.latestSessionId !== undefined) {
      thread.latestSessionId = overrides.latestSessionId;
    }
    if (overrides.latestSessionLabel !== undefined) {
      thread.latestSessionLabel = overrides.latestSessionLabel;
    }
    if (overrides.latestWorkdir !== undefined) {
      thread.latestWorkdir = overrides.latestWorkdir;
    }
    if (overrides.latestRepo !== undefined) {
      thread.latestRepo = overrides.latestRepo;
    }
    return thread;
  }

  test("maps an empty list to an empty list", () => {
    expect(mapTaskThreadsToCodingAgentSessions([])).toEqual([]);
  });

  test("maps a done thread onto its latest session", () => {
    const [mapped] = mapTaskThreadsToCodingAgentSessions([
      makeThread("done", { summary: "all green" }),
    ]);
    expect(mapped).toEqual({
      sessionId: "sess-9",
      agentType: "task-thread",
      label: "Ship the barrel tests",
      originalTask: "cover client-types",
      workdir: "/repo/eliza",
      status: "completed",
      decisionCount: 3,
      autoResolvedCount: 0,
      lastActivity: "all green",
    });
  });

  const threadStatusCases: Array<[CodingAgentTaskThread["status"], string]> = [
    ["failed", "error"],
    ["done", "completed"],
    ["interrupted", "stopped"],
    ["validating", "tool_running"],
    ["blocked", "blocked"],
    ["waiting_on_user", "blocked"],
    ["open", "active"],
    ["archived", "active"],
  ];
  test.each(threadStatusCases)(
    "maps thread status %s to %s",
    (raw, expected) => {
      const [mapped] = mapTaskThreadsToCodingAgentSessions([makeThread(raw)]);
      expect(mapped.status).toBe(expected);
    },
  );

  test("interrupted threads get the fixed resume hint instead of their summary", () => {
    const [mapped] = mapTaskThreadsToCodingAgentSessions([
      makeThread("interrupted", { summary: "half finished" }),
    ]);
    expect(mapped.lastActivity).toBe(
      "Interrupted - reopen or resume this task",
    );
  });

  test("falls back to thread id, label chain and workdir chain", () => {
    const [mapped] = mapTaskThreadsToCodingAgentSessions([
      makeThread("open", {
        title: "",
        latestSessionId: null,
        latestWorkdir: null,
      }),
    ]);
    expect(mapped.sessionId).toBe("thread-1");
    expect(mapped.label).toBe("session nine");
    expect(mapped.workdir).toBe("eliza");
    const [unlabelled] = mapTaskThreadsToCodingAgentSessions([
      makeThread("open", {
        title: "",
        latestSessionId: null,
        latestSessionLabel: null,
        latestWorkdir: null,
        latestRepo: null,
      }),
    ]);
    expect(unlabelled.label).toBe("Task");
    expect(unlabelled.workdir).toBe("");
  });
});
