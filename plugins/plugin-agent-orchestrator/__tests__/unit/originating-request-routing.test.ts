import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOriginatingRequestText } from "../../src/actions/common.js";
import { resolveSpawnWorkdir } from "../../src/services/task-agent-routing.js";

// Regression coverage for the whole-stack-claude workdir-route miss: when the
// planner dispatches TASKS_SPAWN_AGENT with a terse `task` and an
// envelope-wrapped / empty `content.text`, route matching used to run against
// the planner's wording and miss the configured route — silently falling
// builds back to the default ACP workspace instead of the agent-home apps dir.
//
// The fix makes route matching planner-independent by recovering the genuine
// originating user request from sources that are GUARANTEED populated
// synchronously at action time — no DB round-trip, no persistence race:
//   1. `content.currentMessageText` (the raw request connectors stamp);
//   2. the state-composed conversation window
//      (`state.data.providers.RECENT_MESSAGES.data.recentMessages`);
//   3. `getMemories` only as a last resort.
// These tests fail against the old code (which passed only the action's
// `content.text` via the narrow `messageText()` reader).

const AGENT_ID = "agent-xyz";

function msg(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    entityId: "user-1",
    agentId: AGENT_ID,
    roomId: "room-1",
    content: { text: "" },
    createdAt: Date.now(),
    ...overrides,
  } as never;
}

function stateWithRecentMessages(messages: Memory[]): State {
  return {
    values: {},
    text: "",
    data: {
      providers: {
        RECENT_MESSAGES: { data: { recentMessages: messages } },
      },
    },
  } as never;
}

function bareRuntime(): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

function runtimeWithRoomMessages(messages: Memory[]): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getMemories: vi.fn(async () => messages),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe("resolveOriginatingRequestText", () => {
  it("recovers the raw request from content.currentMessageText when content.text is empty", async () => {
    // Connector stamped the raw human message into currentMessageText; the
    // envelope/planner left content.text empty. No state, no DB needed.
    const action = msg({
      content: {
        text: "",
        currentMessageText:
          "build me a small markdown-to-html previewer web page",
      },
    });

    const resolved = await resolveOriginatingRequestText(bareRuntime(), action);

    expect(resolved).toContain("web page");
    expect(resolved).toContain("markdown-to-html previewer");
  });

  it("recovers the request from the state-composed conversation window", async () => {
    // The action message is a synthetic re-plan trigger with no usable text,
    // but the user's original request is in the state-composed dialogue.
    const action = msg({ content: { text: "" } });
    const state = stateWithRecentMessages([
      msg({
        id: "m-user",
        entityId: "user-1",
        content: {
          text: "build me a small markdown-to-html previewer web page",
        },
      }),
      msg({
        id: "m-agent",
        entityId: AGENT_ID,
        content: { text: "On it — spawning a coding agent now." },
      }),
    ]);

    const resolved = await resolveOriginatingRequestText(
      bareRuntime(),
      action,
      state,
    );

    expect(resolved).toContain("web page");
    expect(resolved).toContain("markdown-to-html previewer");
  });

  it("skips the agent's own messages in the state window and keeps the human request", async () => {
    const action = msg({ content: { text: "create a previewer" } });
    const state = stateWithRecentMessages([
      msg({
        id: "m-user",
        entityId: "user-1",
        content: { text: "make me a static site for my bakery" },
      }),
      msg({
        id: "m-agent",
        entityId: AGENT_ID,
        content: { text: "Sure, building a web page for you." },
      }),
    ]);

    const resolved = await resolveOriginatingRequestText(
      bareRuntime(),
      action,
      state,
    );

    // The agent message also said "web page", but we must route on the human's
    // actual wording — assert the human request is present and unioned with the
    // action's own (terse) text.
    expect(resolved).toContain("static site for my bakery");
    expect(resolved).toContain("create a previewer");
  });

  it("falls back to getMemories only when state has no usable request", async () => {
    const action = msg({ content: { text: "" } });
    const runtime = runtimeWithRoomMessages([
      msg({
        id: "m-agent",
        entityId: AGENT_ID,
        content: { text: "On it." },
      }),
      msg({
        id: "m-user",
        entityId: "user-1",
        content: { text: "build me a stopwatch web page" },
      }),
    ]);

    const resolved = await resolveOriginatingRequestText(
      runtime,
      action,
      stateWithRecentMessages([]),
    );

    expect(resolved).toContain("stopwatch web page");
  });

  it("prefers the synchronous state source over getMemories", async () => {
    const action = msg({ content: { text: "" } });
    const getMemories = vi.fn(async () => [
      msg({
        id: "m-stale",
        entityId: "user-1",
        content: { text: "an older unrelated request" },
      }),
    ]);
    const runtime = {
      agentId: AGENT_ID,
      getMemories,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never as IAgentRuntime;
    const state = stateWithRecentMessages([
      msg({
        id: "m-user",
        entityId: "user-1",
        content: { text: "build me a bmi calculator web page" },
      }),
    ]);

    const resolved = await resolveOriginatingRequestText(
      runtime,
      action,
      state,
    );

    expect(resolved).toContain("bmi calculator web page");
    // The synchronous state source short-circuits before the DB read.
    expect(getMemories).not.toHaveBeenCalled();
  });

  it("falls back to messageText when no source carries the request", async () => {
    const action = msg({ content: { text: "build a static site" } });

    const resolved = await resolveOriginatingRequestText(bareRuntime(), action);

    expect(resolved).toBe("build a static site");
  });

  it("falls back to messageText when getMemories throws", async () => {
    const action = msg({ content: { text: "build a static site" } });
    const runtime = {
      agentId: AGENT_ID,
      getMemories: vi.fn(async () => {
        throw new Error("db down");
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never;

    const resolved = await resolveOriginatingRequestText(runtime, action);

    expect(resolved).toBe("build a static site");
  });
});

describe("route matching uses the originating request, not the planner task", () => {
  const ENV_KEY = "TASK_AGENT_WORKDIR_ROUTES";
  let tmpRoot: string;
  let appsDir: string;
  let originalRoutes: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "originating-route-"));
    appsDir = path.join(tmpRoot, "agent-home");
    fs.mkdirSync(appsDir, { recursive: true });
    originalRoutes = process.env[ENV_KEY];
    process.env[ENV_KEY] = JSON.stringify([
      {
        id: "agent-home-local-apps",
        workdir: appsDir,
        matchAny: ["web page", "webpage", "static site", "landing page"],
        excludeAny: ["production", "database", "auth"],
      },
    ]);
  });

  afterEach(() => {
    if (originalRoutes === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalRoutes;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("FAILS-ON-OLD: terse planner task + empty content.text misses, recovered request matches", async () => {
    // Planner emitted a terse task that drops the "web page" keyword and an
    // empty content.text; the real user request lives on currentMessageText.
    const plannerTask = "create a markdown-to-html previewer";
    const action = msg({
      content: {
        text: "",
        currentMessageText:
          "build me a small markdown-to-html previewer web page",
      },
    });

    // OLD behavior: resolveSpawnWorkdir(runtime, plannerTask, content.text, ...)
    // where content.text === "" → no keyword → fallback (no route).
    const oldUserRequest = (action.content as { text: string }).text;
    const oldResult = resolveSpawnWorkdir(
      bareRuntime(),
      plannerTask,
      oldUserRequest,
      undefined,
    );
    expect(oldResult.route).toBeUndefined();

    // NEW behavior: feed the recovered originating request as userRequest.
    const routingRequest = await resolveOriginatingRequestText(
      bareRuntime(),
      action,
    );
    const newResult = resolveSpawnWorkdir(
      bareRuntime(),
      plannerTask,
      routingRequest,
      undefined,
    );
    expect(newResult.route?.id).toBe("agent-home-local-apps");
    expect(newResult.workdir).toBe(appsDir);
  });

  it("recovers from the state window when the action message has no text at all", async () => {
    const plannerTask = "create a previewer";
    const action = msg({ content: { text: "" } });
    const state = stateWithRecentMessages([
      msg({
        id: "m-user",
        entityId: "user-1",
        content: { text: "build me a markdown previewer web page" },
      }),
    ]);

    const routingRequest = await resolveOriginatingRequestText(
      bareRuntime(),
      action,
      state,
    );
    const result = resolveSpawnWorkdir(
      bareRuntime(),
      plannerTask,
      routingRequest,
      undefined,
    );
    expect(result.route?.id).toBe("agent-home-local-apps");
    expect(result.workdir).toBe(appsDir);
  });

  it("does not regress the verbose-planner path (request text already carries the keyword)", async () => {
    const verboseTask = "build me a stopwatch web page with start/stop";
    const action = msg({ content: { text: verboseTask } });

    const routingRequest = await resolveOriginatingRequestText(
      bareRuntime(),
      action,
    );
    const result = resolveSpawnWorkdir(
      bareRuntime(),
      verboseTask,
      routingRequest,
      undefined,
    );
    expect(result.route?.id).toBe("agent-home-local-apps");
  });

  it("does not invent a route when neither task nor request carries a keyword", async () => {
    const plannerTask = "do the unremarkable thing";
    const action = msg({ content: { text: "" } });
    const state = stateWithRecentMessages([
      msg({
        id: "m-user",
        entityId: "user-1",
        content: { text: "fix a typo in my notes" },
      }),
    ]);

    const routingRequest = await resolveOriginatingRequestText(
      bareRuntime(),
      action,
      state,
    );
    const result = resolveSpawnWorkdir(
      bareRuntime(),
      plannerTask,
      routingRequest,
      undefined,
    );
    expect(result.route).toBeUndefined();
  });
});
