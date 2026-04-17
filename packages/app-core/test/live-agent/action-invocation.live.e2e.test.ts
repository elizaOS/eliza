/**
 * E2E tests for action invocation — verifying that the agent correctly
 * selects and executes actions in response to natural language input.
 *
 * NO MOCKS. Uses a real PGlite database and a real LLM provider.
 * All tests are gated on MILADY_LIVE_TEST=1 / ELIZA_LIVE_TEST=1 plus
 * a configured LLM API key.
 *
 * Follows the same lifecycle pattern as agent-runtime.live.e2e.test.ts
 * but focuses on action selection accuracy rather than infrastructure.
 */
import crypto from "node:crypto";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  logger,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIf } from "../../../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../../../test/helpers/live-provider";
import { withTimeout, sleep } from "../../../../../test/helpers/test-utils";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const liveModelTestsEnabled =
  process.env.MILADY_LIVE_TEST === "1" ||
  process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const canRunLiveTests = liveModelTestsEnabled && selectedLiveProvider !== null;

// ---------------------------------------------------------------------------
// Action capture helper
// ---------------------------------------------------------------------------

/**
 * Captures the first action name dispatched for a given room via the
 * `outgoing_before_deliver` pipeline hook. Same pattern used by the
 * action-selection benchmark runner.
 */
interface ActionCapture {
  action: string | null;
  responseText: string;
}

async function sendMessageAndCaptureAction(
  runtime: AgentRuntime,
  userMessage: string,
  options?: { timeoutMs?: number },
): Promise<ActionCapture> {
  const roomId = crypto.randomUUID() as UUID;
  const entityId = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;
  const hookId = `action-capture-${roomId}`;
  const timeoutMs = options?.timeoutMs ?? 90_000;

  let capturedAction: string | null = null;
  let responseText = "";

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: "ActionTestUser",
    source: "test",
    channelId: roomId,
    type: ChannelType.DM,
  });

  runtime.registerPipelineHook({
    id: hookId,
    phase: "outgoing_before_deliver",
    handler: (_runtime, ctx) => {
      if (ctx.phase !== "outgoing_before_deliver") return;
      if (ctx.roomId !== roomId) return;
      if (capturedAction !== null) return;
      const name = ctx.actionName;
      if (typeof name === "string" && name.trim().length > 0) {
        capturedAction = name;
      }
    },
  });

  try {
    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId,
      roomId,
      content: {
        text: userMessage,
        source: "test",
        channelType: ChannelType.DM,
      },
    });

    const handlePromise = Promise.resolve(
      runtime.messageService?.handleMessage(
        runtime,
        message,
        async (content: { text?: string }) => {
          if (content.text) responseText += content.text;
          return [];
        },
      ),
    );

    await withTimeout(handlePromise, timeoutMs, `handleMessage(${userMessage.slice(0, 40)})`);
  } finally {
    try {
      runtime.unregisterPipelineHook(hookId);
    } catch {
      // Best-effort cleanup.
    }
  }

  return { action: capturedAction, responseText };
}

/**
 * Multi-turn variant: sends multiple messages in the same room and captures
 * the action from the final turn.
 */
async function sendConversationAndCaptureAction(
  runtime: AgentRuntime,
  messages: string[],
  options?: { timeoutMs?: number },
): Promise<ActionCapture> {
  const roomId = crypto.randomUUID() as UUID;
  const entityId = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;
  const timeoutMs = options?.timeoutMs ?? 90_000;

  let capturedAction: string | null = null;
  let responseText = "";

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: "ActionTestUser",
    source: "test",
    channelId: roomId,
    type: ChannelType.DM,
  });

  for (let i = 0; i < messages.length; i += 1) {
    const isLast = i === messages.length - 1;
    const hookId = `action-capture-multi-${roomId}-${i}`;

    // Only capture action on the final turn.
    if (isLast) {
      capturedAction = null;
      responseText = "";

      runtime.registerPipelineHook({
        id: hookId,
        phase: "outgoing_before_deliver",
        handler: (_runtime, ctx) => {
          if (ctx.phase !== "outgoing_before_deliver") return;
          if (ctx.roomId !== roomId) return;
          if (capturedAction !== null) return;
          const name = ctx.actionName;
          if (typeof name === "string" && name.trim().length > 0) {
            capturedAction = name;
          }
        },
      });
    }

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId,
      roomId,
      content: {
        text: messages[i],
        source: "test",
        channelType: ChannelType.DM,
      },
    });

    let turnResponse = "";
    const handlePromise = Promise.resolve(
      runtime.messageService?.handleMessage(
        runtime,
        message,
        async (content: { text?: string }) => {
          if (content.text) turnResponse += content.text;
          return [];
        },
      ),
    );

    await withTimeout(handlePromise, timeoutMs, `handleMessage turn ${i + 1}`);

    if (isLast) {
      responseText = turnResponse;
      try {
        runtime.unregisterPipelineHook(hookId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  return { action: capturedAction, responseText };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function normalizeActionName(name: string | null): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase().replace(/[\s-]+/g, "_");
}

function expectActionCalled(
  capture: ActionCapture,
  expectedAction: string,
  acceptableAlternatives?: string[],
): void {
  const actual = normalizeActionName(capture.action);
  const expected = normalizeActionName(expectedAction);
  const acceptable = acceptableAlternatives?.map(normalizeActionName) ?? [];

  const allAcceptable = [expected, ...acceptable].filter(Boolean);
  expect(
    allAcceptable.includes(actual),
    `Expected action ${expectedAction}${acceptable.length > 0 ? ` (or ${acceptableAlternatives!.join(", ")})` : ""} but got ${capture.action ?? "(none)"}. Response: "${capture.responseText.slice(0, 200)}"`,
  ).toBe(true);
}

function expectNoAction(capture: ActionCapture): void {
  expect(
    normalizeActionName(capture.action),
    `Expected no action but got ${capture.action}. Response: "${capture.responseText.slice(0, 200)}"`,
  ).toBeNull();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Action Invocation E2E", () => {
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let initialized = false;

  // Track which actions are registered so we can skip tests for missing actions.
  let registeredActions: Set<string>;

  function hasAction(name: string): boolean {
    return registeredActions.has(normalizeActionName(name)!);
  }

  beforeAll(async () => {
    if (!canRunLiveTests) return;

    process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
    process.env.ENABLE_TRAJECTORIES = "false";
    process.env.ELIZA_TRAJECTORY_LOGGING = "false";

    const result = await createRealTestRuntime({
      withLLM: true,
      preferredProvider: selectedLiveProvider?.name,
      characterName: "ActionTestAgent",
    });

    runtime = result.runtime;
    cleanup = result.cleanup;
    initialized = true;

    registeredActions = new Set(
      runtime.actions.map((a) => normalizeActionName(a.name)!).filter(Boolean),
    );

    logger.info(
      `[action-e2e] Setup complete — ${runtime.plugins.length} plugins, ` +
        `${runtime.actions.length} actions registered: ${[...registeredActions].join(", ")}`,
    );
  }, 180_000);

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  }, 150_000);

  // ===================================================================
  //  1. Startup validation
  // ===================================================================

  describe("startup", () => {
    itIf(canRunLiveTests)("initializes with actions registered", () => {
      expect(initialized).toBe(true);
      expect(runtime.actions.length).toBeGreaterThan(0);
      logger.info(
        `[action-e2e] Registered actions: ${[...registeredActions].join(", ")}`,
      );
    });

    itIf(canRunLiveTests)("messageService is available", () => {
      expect(runtime.messageService).not.toBeNull();
    });
  });

  // ===================================================================
  //  2. Action selection — basic / negative cases
  // ===================================================================

  describe("action selection — no action expected", () => {
    itIf(canRunLiveTests)(
      "greeting does not trigger any action",
      async () => {
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "Hey, good morning! How are you?",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectNoAction(capture);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "factual question does not trigger any action",
      async () => {
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "What is the capital of France?",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectNoAction(capture);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "opinion question does not trigger any action",
      async () => {
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "What do you think about remote work?",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectNoAction(capture);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "casual chat about email does not trigger email action",
      async () => {
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "I hate email, it's such a time sink.",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        // Should not trigger GMAIL_ACTION or INBOX despite mentioning email.
        const actual = normalizeActionName(capture.action);
        expect(
          actual === null || (!["GMAIL_ACTION", "INBOX"].includes(actual)),
          `Venting about email should not trigger an email action, got: ${capture.action}`,
        ).toBe(true);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "casual chat about calendar does not trigger calendar action",
      async () => {
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "My calendar has been crazy this quarter.",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        const actual = normalizeActionName(capture.action);
        expect(
          actual === null || actual !== "CALENDAR_ACTION",
          `Venting about calendar should not trigger CALENDAR_ACTION, got: ${capture.action}`,
        ).toBe(true);
      },
      90_000,
    );
  });

  // ===================================================================
  //  3. Action selection — positive: personality modification
  // ===================================================================

  describe("action selection — personality", () => {
    itIf(canRunLiveTests)(
      "personality change request triggers MODIFY_CHARACTER",
      async () => {
        if (!hasAction("MODIFY_CHARACTER")) {
          logger.warn("[action-e2e] MODIFY_CHARACTER not registered, skipping");
          return;
        }
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "Change your personality to be more casual and funny.",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectActionCalled(capture, "MODIFY_CHARACTER");
      },
      90_000,
    );
  });

  // ===================================================================
  //  4. Action selection — LifeOps (todos, habits, goals)
  // ===================================================================

  describe("action selection — LifeOps", () => {
    itIf(canRunLiveTests)(
      "create todo triggers LIFE action",
      async () => {
        if (!hasAction("LIFE")) {
          logger.warn("[action-e2e] LIFE action not registered, skipping");
          return;
        }
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "Add a todo: pick up dry cleaning tomorrow.",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectActionCalled(capture, "LIFE", ["CREATE_TODO", "LIFE_CREATE_DEFINITION"]);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "list todos triggers LIFE action",
      async () => {
        if (!hasAction("LIFE")) {
          logger.warn("[action-e2e] LIFE action not registered, skipping");
          return;
        }
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "What's on my todo list today?",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectActionCalled(capture, "LIFE", ["LIST_TODOS"]);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "set a goal triggers LIFE action",
      async () => {
        if (!hasAction("LIFE")) {
          logger.warn("[action-e2e] LIFE action not registered, skipping");
          return;
        }
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "Set a goal to save $5,000 by the end of the year.",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectActionCalled(capture, "LIFE", ["CREATE_GOAL"]);
      },
      90_000,
    );
  });

  // ===================================================================
  //  5. Action selection — calendar
  // ===================================================================

  describe("action selection — calendar", () => {
    itIf(canRunLiveTests)(
      "schedule event triggers CALENDAR_ACTION",
      async () => {
        if (!hasAction("CALENDAR_ACTION")) {
          logger.warn("[action-e2e] CALENDAR_ACTION not registered, skipping");
          return;
        }
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "Schedule a dentist appointment next Tuesday at 3pm.",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectActionCalled(capture, "CALENDAR_ACTION", ["CREATE_EVENT"]);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "asking about weather does not invoke calendar action",
      async () => {
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "What is the weather like today?",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        const actual = normalizeActionName(capture.action);
        expect(
          actual === null || actual !== "CALENDAR_ACTION",
          `Weather question should not trigger CALENDAR_ACTION, got: ${capture.action}`,
        ).toBe(true);
      },
      90_000,
    );
  });

  // ===================================================================
  //  6. Action selection — messaging
  // ===================================================================

  describe("action selection — messaging", () => {
    itIf(canRunLiveTests)(
      "send telegram message triggers cross-channel send",
      async () => {
        if (!hasAction("CROSS_CHANNEL_SEND")) {
          logger.warn("[action-e2e] CROSS_CHANNEL_SEND not registered, skipping");
          return;
        }
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "Send a telegram message to Jane saying I'm running 10 minutes late.",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectActionCalled(capture, "CROSS_CHANNEL_SEND", ["SEND_MESSAGE"]);
      },
      90_000,
    );

    itIf(canRunLiveTests)(
      "casual chat does not invoke SEND_MESSAGE",
      async () => {
        const capture = await sendMessageAndCaptureAction(
          runtime,
          "Thanks, that was helpful!",
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        const actual = normalizeActionName(capture.action);
        expect(
          actual === null ||
            !["SEND_MESSAGE", "CROSS_CHANNEL_SEND"].includes(actual),
          `Casual thank-you should not trigger messaging action, got: ${capture.action}`,
        ).toBe(true);
      },
      90_000,
    );
  });

  // ===================================================================
  //  7. Multi-turn context
  // ===================================================================

  describe("multi-turn", () => {
    itIf(canRunLiveTests)(
      "follow-up todo creation after establishing context",
      async () => {
        if (!hasAction("LIFE")) {
          logger.warn("[action-e2e] LIFE action not registered, skipping");
          return;
        }
        const capture = await sendConversationAndCaptureAction(
          runtime,
          [
            "I have a really busy week coming up with lots of errands.",
            "Actually, can you add 'pick up prescription from pharmacy' to my todo list?",
          ],
          { timeoutMs: 120_000 },
        );
        expect(capture.responseText.length).toBeGreaterThan(0);
        expectActionCalled(capture, "LIFE", ["CREATE_TODO", "LIFE_CREATE_DEFINITION"]);
      },
      180_000,
    );
  });
});
