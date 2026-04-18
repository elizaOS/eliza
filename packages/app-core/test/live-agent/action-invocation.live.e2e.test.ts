/**
 * E2E tests for action invocation — verifying that the agent correctly
 * selects and executes actions in response to natural language input.
 *
 * NO MOCKS. Uses a real PGlite database and a real LLM provider.
 * All tests are gated on MILADY_LIVE_TEST=1 / ELIZA_LIVE_TEST=1 plus
 * a configured LLM API key.
 *
 * Dogfoods the ActionSpy / ConversationHarness helpers (which were previously
 * unused): every test spins up a fresh ConversationHarness (new roomId) so
 * context cannot leak between cases.
 */
import {
  type AgentRuntime,
  logger,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { appLifeOpsPlugin } from "@elizaos/app-lifeops/plugin";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIf } from "../../../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../../../test/helpers/live-provider";
import {
  expectActionCalled,
  expectActionNotCalled,
} from "../helpers/action-assertions.js";
import { ConversationHarness } from "../helpers/conversation-harness.js";
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

const DEFAULT_TEST_TIMEOUT_MS = 90_000;
const OWNER_ID = stringToUuid("action-e2e-owner");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function normalizeActionName(name: string): string {
  return name.trim().toUpperCase().replace(/_/g, "");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Action Invocation E2E", () => {
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let initialized = false;
  let registeredActions: Set<string>;

  /**
   * Returns true if the action is registered. If not, emits a clearly-marked
   * warning so the skip is visible in test output instead of silently green.
   * Also marks the test context as soft-failed so the run flags the gap
   * without aborting the whole suite.
   */
  function requireAction(name: string): boolean {
    if (registeredActions.has(normalizeActionName(name))) return true;
    const message = `[action-e2e] SKIPPING — action ${name} is not registered on the runtime; feature unavailable in this test environment`;
    // Warn loudly and use expect.soft so vitest reports a failure instead of
    // counting the test as a silent pass.
    console.warn(message);
    expect.soft(false, message).toBe(true);
    return false;
  }

  /**
   * Creates a fresh harness (new roomId) for a single test, runs `fn`, and
   * guarantees cleanup even on failure. This is the main dogfooding pattern
   * for ConversationHarness + ActionSpy.
   */
  async function withHarness(
    fn: (harness: ConversationHarness) => Promise<void>,
  ): Promise<void> {
    const harness = new ConversationHarness(runtime, {
      userId: OWNER_ID,
      userName: "Owner",
    });
    await harness.setup();
    try {
      await fn(harness);
    } finally {
      await harness.cleanup();
    }
  }

  beforeAll(async () => {
    if (!canRunLiveTests) return;

    process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
    process.env.ENABLE_TRAJECTORIES = "false";
    process.env.ELIZA_TRAJECTORY_LOGGING = "false";
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";

    const result = await createRealTestRuntime({
      withLLM: true,
      preferredProvider: selectedLiveProvider?.name,
      characterName: "ActionTestAgent",
      advancedCapabilities: true,
      plugins: [appLifeOpsPlugin],
    });

    runtime = result.runtime;
    cleanup = result.cleanup;
    initialized = true;
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", OWNER_ID, false);

    registeredActions = new Set(
      runtime.actions.map((a) => normalizeActionName(a.name)),
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
  //  Startup
  // ===================================================================

  describe("startup", () => {
    itIf(canRunLiveTests)("initializes with actions registered", () => {
      expect(initialized).toBe(true);
      expect(runtime.actions.length).toBeGreaterThan(0);
    });

    itIf(canRunLiveTests)("messageService is available", () => {
      expect(runtime.messageService).not.toBeNull();
    });
  });

  // ===================================================================
  //  1. Core: negatives + baseline LifeOps actions
  // ===================================================================

  describe("core", () => {
    itIf(canRunLiveTests)(
      "greeting does not trigger any action",
      async () => {
        await withHarness(async (h) => {
          const turn = await h.send("Hey, good morning! How are you?");
          expect(turn.responseText.length).toBeGreaterThan(0);
          expect(h.spy.getCompletedCalls()).toHaveLength(0);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "factual question does not trigger any action",
      async () => {
        await withHarness(async (h) => {
          const turn = await h.send("What is the capital of France?");
          expect(turn.responseText.length).toBeGreaterThan(0);
          expect(h.spy.getCompletedCalls()).toHaveLength(0);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "venting about email does not trigger email actions",
      async () => {
        await withHarness(async (h) => {
          await h.send("I hate email, it's such a time sink.");
          expectActionNotCalled(h.spy, "GMAIL_ACTION");
          expectActionNotCalled(h.spy, "INBOX");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "venting about calendar does not trigger CALENDAR_ACTION",
      async () => {
        await withHarness(async (h) => {
          await h.send("My calendar has been crazy this quarter.");
          expectActionNotCalled(h.spy, "CALENDAR_ACTION");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "personality change request triggers MODIFY_CHARACTER",
      async () => {
        if (!requireAction("MODIFY_CHARACTER")) return;
        await withHarness(async (h) => {
          await h.send("Change your personality to be more casual and funny.");
          expectActionCalled(h.spy, "MODIFY_CHARACTER");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "create todo triggers LIFE",
      async () => {
        if (!requireAction("LIFE")) return;
        await withHarness(async (h) => {
          await h.send("Add a todo: pick up dry cleaning tomorrow.");
          expectActionCalled(h.spy, "LIFE");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "set goal triggers LIFE",
      async () => {
        if (!requireAction("LIFE")) return;
        await withHarness(async (h) => {
          await h.send("Set a goal to save $5,000 by the end of the year.");
          expectActionCalled(h.spy, "LIFE");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  2. Messaging
  // ===================================================================

  describe("messaging", () => {
    itIf(canRunLiveTests)(
      "telegram request triggers CROSS_CHANNEL_SEND",
      async () => {
        if (!requireAction("CROSS_CHANNEL_SEND")) return;
        await withHarness(async (h) => {
          await h.send(
            "Send a telegram message to Jane saying I'm running 10 minutes late.",
          );
          expectActionCalled(h.spy, "CROSS_CHANNEL_SEND");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "discord DM request triggers CROSS_CHANNEL_SEND",
      async () => {
        if (!requireAction("CROSS_CHANNEL_SEND")) return;
        await withHarness(async (h) => {
          await h.send("DM bob on Discord: standup in 5.");
          expectActionCalled(h.spy, "CROSS_CHANNEL_SEND");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "email draft request triggers CROSS_CHANNEL_SEND",
      async () => {
        if (!requireAction("CROSS_CHANNEL_SEND")) return;
        await withHarness(async (h) => {
          await h.send(
            "Email alice@example.com the meeting notes from today.",
          );
          expectActionCalled(h.spy, "CROSS_CHANNEL_SEND");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "gmail triage request triggers GMAIL_ACTION",
      async () => {
        if (!requireAction("GMAIL_ACTION")) return;
        await withHarness(async (h) => {
          await h.send("Triage my gmail inbox.");
          expectActionCalled(h.spy, "GMAIL_ACTION");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "generic inbox triage triggers INBOX",
      async () => {
        if (!requireAction("INBOX")) return;
        await withHarness(async (h) => {
          await h.send("Triage my inbox.");
          expectActionCalled(h.spy, "INBOX");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  3. Calendar & scheduling
  // ===================================================================

  describe("calendar & scheduling", () => {
    itIf(canRunLiveTests)(
      "show today's calendar triggers CALENDAR_ACTION",
      async () => {
        if (!requireAction("CALENDAR_ACTION")) return;
        await withHarness(async (h) => {
          await h.send("Show me my calendar for today.");
          expectActionCalled(h.spy, "CALENDAR_ACTION");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "schedule event triggers CALENDAR_ACTION",
      async () => {
        if (!requireAction("CALENDAR_ACTION")) return;
        await withHarness(async (h) => {
          await h.send(
            "Schedule a dentist appointment next Tuesday at 3pm.",
          );
          expectActionCalled(h.spy, "CALENDAR_ACTION");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "help me schedule a meeting triggers SCHEDULING",
      async () => {
        if (!requireAction("SCHEDULING")) return;
        await withHarness(async (h) => {
          await h.send("Help me schedule a meeting with the design team.");
          expectActionCalled(h.spy, "SCHEDULING");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "availability question triggers CHECK_AVAILABILITY",
      async () => {
        if (!requireAction("CHECK_AVAILABILITY")) return;
        await withHarness(async (h) => {
          await h.send("Am I free on Thursday afternoon?");
          expectActionCalled(h.spy, "CHECK_AVAILABILITY");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "propose times triggers PROPOSE_MEETING_TIMES",
      async () => {
        if (!requireAction("PROPOSE_MEETING_TIMES")) return;
        await withHarness(async (h) => {
          await h.send(
            "Propose three times for a 30 minute sync with Marco next week.",
          );
          expectActionCalled(h.spy, "PROPOSE_MEETING_TIMES");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  4. Relationships
  // ===================================================================

  describe("relationships", () => {
    itIf(canRunLiveTests)(
      "add contact triggers RELATIONSHIP",
      async () => {
        if (!requireAction("RELATIONSHIP")) return;
        await withHarness(async (h) => {
          await h.send(
            "Add a new contact: David Lee, david@example.com, my old coworker.",
          );
          expectActionCalled(h.spy, "RELATIONSHIP");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "follow-up list request triggers RELATIONSHIP",
      async () => {
        if (!requireAction("RELATIONSHIP")) return;
        await withHarness(async (h) => {
          await h.send("Who should I follow up with this week?");
          expectActionCalled(h.spy, "RELATIONSHIP");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  5. Focus / blocking
  // ===================================================================

  describe("focus / blocking", () => {
    itIf(canRunLiveTests)(
      "block websites request triggers BLOCK_WEBSITES",
      async () => {
        if (!requireAction("BLOCK_WEBSITES")) return;
        await withHarness(async (h) => {
          await h.send("Block twitter and reddit for the next 2 hours.");
          expectActionCalled(h.spy, "BLOCK_WEBSITES");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "block apps request triggers BLOCK_APPS",
      async () => {
        if (!requireAction("BLOCK_APPS")) return;
        await withHarness(async (h) => {
          await h.send("Block the Slack app while I focus on deep work.");
          expectActionCalled(h.spy, "BLOCK_APPS");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  6. Social
  // ===================================================================

  describe("social — X", () => {
    itIf(canRunLiveTests)(
      "read DMs on X triggers X_READ",
      async () => {
        if (!requireAction("X_READ")) return;
        await withHarness(async (h) => {
          await h.send("Check my twitter DMs.");
          expectActionCalled(h.spy, "X_READ");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "read feed on X triggers X_READ",
      async () => {
        if (!requireAction("X_READ")) return;
        await withHarness(async (h) => {
          await h.send("What's on my X timeline right now?");
          expectActionCalled(h.spy, "X_READ");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  7. Activity
  // ===================================================================

  describe("activity & health", () => {
    itIf(canRunLiveTests)(
      "screen time today triggers SCREEN_TIME",
      async () => {
        if (!requireAction("SCREEN_TIME")) return;
        await withHarness(async (h) => {
          await h.send("How much screen time have I used today?");
          expectActionCalled(h.spy, "SCREEN_TIME");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "screen time by app triggers SCREEN_TIME",
      async () => {
        if (!requireAction("SCREEN_TIME")) return;
        await withHarness(async (h) => {
          await h.send("Break down my screen time by app this week.");
          expectActionCalled(h.spy, "SCREEN_TIME");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "health summary triggers HEALTH",
      async () => {
        if (!requireAction("HEALTH")) return;
        await withHarness(async (h) => {
          await h.send("Summarize my health metrics for today.");
          expectActionCalled(h.spy, "HEALTH");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  8. Meta & ops
  // ===================================================================

  describe("meta & ops", () => {
    itIf(canRunLiveTests)(
      "dossier request triggers DOSSIER",
      async () => {
        if (!requireAction("DOSSIER")) return;
        await withHarness(async (h) => {
          await h.send("Pull up a dossier on Satya Nadella.");
          expectActionCalled(h.spy, "DOSSIER");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "broadcast intent triggers INTENT_SYNC",
      async () => {
        if (!requireAction("INTENT_SYNC")) return;
        await withHarness(async (h) => {
          await h.send(
            "Broadcast to all my devices: remind me to take my medication at 8pm.",
          );
          expectActionCalled(h.spy, "INTENT_SYNC");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  9. Comms (action selection only — may require creds to execute)
  // ===================================================================

  describe("third-party", () => {
    itIf(canRunLiveTests)(
      "phone call request triggers TWILIO_VOICE_CALL",
      async () => {
        if (!requireAction("TWILIO_VOICE_CALL")) return;
        await withHarness(async (h) => {
          await h.send(
            "Call the dentist and reschedule my appointment for next week.",
          );
          // Action may be gated off from completing without creds/owner role,
          // but selection should still surface in the started events.
          const started = h.spy
            .getStartedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const completed = h.spy
            .getCompletedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const target = normalizeActionName("TWILIO_VOICE_CALL");
          expect(
            started.includes(target) || completed.includes(target),
            `Expected TWILIO_VOICE_CALL to be selected. Started=${started.join(",")} Completed=${completed.join(",")}`,
          ).toBe(true);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "password lookup request triggers PASSWORD_MANAGER",
      async () => {
        if (!requireAction("PASSWORD_MANAGER")) return;
        await withHarness(async (h) => {
          await h.send("Find my saved password for GitHub.");
          const started = h.spy
            .getStartedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const completed = h.spy
            .getCompletedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const target = normalizeActionName("PASSWORD_MANAGER");
          expect(
            started.includes(target) || completed.includes(target),
            `Expected PASSWORD_MANAGER to be selected. Started=${started.join(",")} Completed=${completed.join(",")}`,
          ).toBe(true);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "remote desktop request triggers REMOTE_DESKTOP",
      async () => {
        if (!requireAction("REMOTE_DESKTOP")) return;
        await withHarness(async (h) => {
          await h.send(
            "Open a remote desktop session to my home laptop.",
          );
          const started = h.spy
            .getStartedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const completed = h.spy
            .getCompletedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const target = normalizeActionName("REMOTE_DESKTOP");
          expect(
            started.includes(target) || completed.includes(target),
            `Expected REMOTE_DESKTOP to be selected. Started=${started.join(",")} Completed=${completed.join(",")}`,
          ).toBe(true);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "calendly booking link request triggers CALENDLY",
      async () => {
        if (!requireAction("CALENDLY")) return;
        await withHarness(async (h) => {
          await h.send(
            "Give me my Calendly booking link for a 30 minute intro.",
          );
          const started = h.spy
            .getStartedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const completed = h.spy
            .getCompletedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const target = normalizeActionName("CALENDLY");
          expect(
            started.includes(target) || completed.includes(target),
            `Expected CALENDLY to be selected. Started=${started.join(",")} Completed=${completed.join(",")}`,
          ).toBe(true);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "computer-use request triggers LIFEOPS_COMPUTER_USE",
      async () => {
        if (!requireAction("LIFEOPS_COMPUTER_USE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Open Finder and create a new folder called Q2-Reports on my desktop.",
          );
          const started = h.spy
            .getStartedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const completed = h.spy
            .getCompletedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const target = normalizeActionName("LIFEOPS_COMPUTER_USE");
          expect(
            started.includes(target) || completed.includes(target),
            `Expected LIFEOPS_COMPUTER_USE to be selected. Started=${started.join(",")} Completed=${completed.join(",")}`,
          ).toBe(true);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  // ===================================================================
  //  10. Multi-turn & parameter extraction
  // ===================================================================

  /**
   * Pulls action_result memories from a room. Used to assert that an action's
   * extracted parameters surface as concrete data — not just that the action
   * fired.
   */
  async function getActionResults(
    rt: AgentRuntime,
    roomId: UUID,
  ): Promise<Memory[]> {
    const memories = await rt.getMemories({
      tableName: "messages",
      roomId,
      count: 50,
    });
    return memories.filter(
      (m) =>
        (m.content as { type?: string } | undefined)?.type === "action_result",
    );
  }

  function stringifyResults(results: Memory[]): string {
    return results
      .map((m) => {
        try {
          return JSON.stringify(m.content);
        } catch {
          return String(m.content);
        }
      })
      .join("\n");
  }

  describe("multi-turn & parameter extraction", () => {
    itIf(canRunLiveTests)(
      "multi-turn todo follow-up keeps invoking LIFE",
      async () => {
        if (!requireAction("LIFE")) return;
        await withHarness(async (h) => {
          await h.send("Create a todo to call my mom.");
          expectActionCalled(h.spy, "LIFE");
          const callsAfterFirst = h.spy.getCompletedCalls().length;

          await h.send("Mark that todo as done.");
          const callsAfterSecond = h.spy.getCompletedCalls().length;
          expect(
            callsAfterSecond,
            `Expected a second LIFE call on follow-up. completed=${h.spy
              .getCompletedCalls()
              .map((c) => c.actionName)
              .join(",")}`,
          ).toBeGreaterThan(callsAfterFirst);
          // The second call should still be LIFE.
          const lastCall = h.spy.getCompletedCalls().slice(-1)[0];
          expect(
            lastCall ? normalizeActionName(lastCall.actionName) : null,
          ).toBe(normalizeActionName("LIFE"));
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );

    itIf(canRunLiveTests)(
      "extracts contact, duration, and time for a meeting schedule request",
      async () => {
        if (!requireAction("CALENDAR_ACTION")) return;
        await withHarness(async (h) => {
          await h.send(
            "Schedule a 30 minute meeting with John about Q4 planning tomorrow at 3pm.",
          );
          expectActionCalled(h.spy, "CALENDAR_ACTION");
          const results = await getActionResults(h.runtime, h.roomId);
          expect(
            results.length,
            "Expected at least one action_result memory",
          ).toBeGreaterThan(0);
          const blob = stringifyResults(results).toLowerCase();
          expect(blob, `Expected contact "John" in result data: ${blob}`).toMatch(/john/);
          expect(blob, `Expected duration ~30 minutes in result data: ${blob}`).toMatch(/30/);
          expect(blob, `Expected time signal (3pm/15:00/3:00) in result data: ${blob}`).toMatch(/3\s*pm|15:00|3:00/);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );

    itIf(canRunLiveTests)(
      "extracts duration for a website block request",
      async () => {
        if (!requireAction("BLOCK_WEBSITES")) return;
        await withHarness(async (h) => {
          await h.send("Block twitter.com for exactly 90 minutes.");
          expectActionCalled(h.spy, "BLOCK_WEBSITES");
          const results = await getActionResults(h.runtime, h.roomId);
          expect(
            results.length,
            "Expected at least one action_result memory",
          ).toBeGreaterThan(0);
          const blob = stringifyResults(results).toLowerCase();
          expect(blob, `Expected duration "90" in result data: ${blob}`).toMatch(/90/);
          expect(blob, `Expected "twitter" reference in result data: ${blob}`).toMatch(/twitter/);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );

    itIf(canRunLiveTests)(
      "chat that merely mentions calendar does not trigger CALENDAR_ACTION",
      async () => {
        await withHarness(async (h) => {
          await h.send("I love how my calendar app shows colors.");
          expectActionNotCalled(h.spy, "CALENDAR_ACTION");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "compound request triggers at least one valid action",
      async () => {
        // Don't gate on a single action — the planner may pick either or both.
        // Just assert that something useful ran.
        await withHarness(async (h) => {
          await h.send(
            "Block twitter.com for an hour and remind me to take a break in 30 minutes.",
          );
          const completedNames = h.spy
            .getCompletedCalls()
            .map((c) => normalizeActionName(c.actionName));
          const acceptable = [
            normalizeActionName("BLOCK_WEBSITES"),
            normalizeActionName("LIFE"),
          ];
          const hit = completedNames.some((n) => acceptable.includes(n));
          expect(
            hit,
            `Expected at least one of BLOCK_WEBSITES/LIFE to fire. Completed=${completedNames.join(",")}`,
          ).toBe(true);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );
  });
});
