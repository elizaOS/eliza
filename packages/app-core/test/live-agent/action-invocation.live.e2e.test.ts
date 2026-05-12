/**
 * E2E tests for action invocation — verifying that the agent correctly
 * selects and executes actions in response to natural language input.
 *
 * NO MOCKS. Uses a real PGlite database and a real LLM provider.
 * All tests are gated on ELIZA_LIVE_TEST=1 / ELIZA_LIVE_TEST=1 plus
 * a configured LLM API key.
 *
 * Dogfoods the ActionSpy / ConversationHarness helpers (which were previously
 * unused): every test spins up a fresh ConversationHarness (new roomId) so
 * context cannot leak between cases.
 */

import {
  appLifeOpsPlugin,
  getSelfControlStatus,
  LifeOpsService,
} from "@elizaos/app-lifeops";
import { readCalendlyCredentialsFromEnv } from "@elizaos/app-lifeops";
import { detectHealthBackend } from "@elizaos/app-lifeops";
import { detectPasswordManagerBackend } from "@elizaos/app-lifeops";
import { detectRemoteDesktopBackend } from "@elizaos/app-lifeops";
import { LifeOpsRepository } from "@elizaos/app-lifeops";
import { readTwilioCredentialsFromEnv } from "@elizaos/app-lifeops";
import { getAppBlockerStatus } from "@elizaos/app-lifeops";
import {
  type AgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";
import {
  expectActionCalled,
  expectActionNotCalled,
} from "../helpers/action-assertions.js";
import { ConversationHarness } from "../helpers/conversation-harness.js";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const canRunLiveTests = liveModelTestsEnabled && selectedLiveProvider !== null;

const DEFAULT_TEST_TIMEOUT_MS = 90_000;

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
  let appBlockingAvailable = false;
  let calendlyConfigured = false;
  let googleCalendarWritable = false;
  let healthBackendAvailable = false;
  let passwordManagerAvailable = false;
  let remoteDesktopAvailable = false;
  let twilioConfigured = false;
  let websiteBlockingAvailable = false;
  let xReadConnected = false;
  let previousDisableLifeOpsScheduler: string | undefined;

  // Connectors / actions / native backends required by this suite are
  // environment-dependent (Twilio, Calendly, X, Google Calendar, native
  // app/website blockers, etc.). Default behavior is to warn loudly and
  // skip — CI environments cannot configure all third-party credentials.
  // Set ELIZA_REQUIRE_ALL_CONNECTORS=1 in dev to surface gaps as failures.
  const strictConnectorMode = process.env.ELIZA_REQUIRE_ALL_CONNECTORS === "1";

  function reportMissingCapability(message: string): void {
    console.warn(message);
    if (strictConnectorMode) {
      expect.soft(false, message).toBe(true);
    }
  }

  function requireAction(name: string): boolean {
    if (registeredActions.has(normalizeActionName(name))) return true;
    reportMissingCapability(
      `[action-e2e] SKIPPING — action ${name} is not registered on the runtime; feature unavailable in this test environment`,
    );
    return false;
  }

  function requireEnvironmentCapability(
    enabled: boolean,
    label: string,
  ): boolean {
    if (enabled) return true;
    reportMissingCapability(
      `[action-e2e] SKIPPING — ${label} is unavailable in this test environment`,
    );
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
      userName: "TestUser",
    });
    await harness.setup();
    harness.spy.reset();
    try {
      await fn(harness);
    } finally {
      await harness.cleanup();
    }
  }

  function formatObservedActions(harness: ConversationHarness): string {
    const started = harness.spy
      .getStartedCalls()
      .map((call) => normalizeActionName(call.actionName));
    const completed = harness.spy
      .getCompletedCalls()
      .map((call) => normalizeActionName(call.actionName));
    return `Started=${started.join(",") || "(none)"} Completed=${completed.join(",") || "(none)"}`;
  }

  function expectAnyCompletedAction(
    harness: ConversationHarness,
    actionNames: string[],
  ): void {
    const targets = new Set(actionNames.map(normalizeActionName));
    const completed = harness.spy
      .getCompletedCalls()
      .map((call) => normalizeActionName(call.actionName));
    expect(
      completed.some((name) => targets.has(name)),
      `Expected one of ${actionNames.join(", ")} to complete. ${formatObservedActions(harness)}`,
    ).toBe(true);
  }

  function expectAnySelectedAction(
    harness: ConversationHarness,
    actionNames: string[],
  ): void {
    const targets = new Set(actionNames.map(normalizeActionName));
    const started = harness.spy
      .getStartedCalls()
      .map((call) => normalizeActionName(call.actionName));
    const completed = harness.spy
      .getCompletedCalls()
      .map((call) => normalizeActionName(call.actionName));
    expect(
      [...started, ...completed].some((name) => targets.has(name)),
      `Expected one of ${actionNames.join(", ")} to be selected. ${formatObservedActions(harness)}`,
    ).toBe(true);
  }

  function hasExpectedActionSince(
    harness: ConversationHarness,
    actionNames: string[],
    phase: "selected" | "completed",
    baseline: number,
  ): boolean {
    const targets = new Set(actionNames.map(normalizeActionName));
    const calls = harness.spy.getCalls().slice(baseline);
    const filtered =
      phase === "completed"
        ? calls.filter((call) => call.phase === "completed")
        : calls;
    return filtered.some((call) =>
      targets.has(normalizeActionName(call.actionName)),
    );
  }

  async function sendUntilExpectedAction(
    harness: ConversationHarness,
    actionNames: string[],
    prompts: string[],
    phase: "selected" | "completed" = "completed",
  ): Promise<void> {
    const baseline = harness.spy.getCalls().length;
    const attempts: string[] = [];
    for (const prompt of prompts) {
      await harness.send(prompt);
      if (hasExpectedActionSince(harness, actionNames, phase, baseline)) return;
      attempts.push(
        `${JSON.stringify(prompt)} => ${formatObservedActions(harness)}`,
      );
    }

    expect(
      false,
      `Expected ${phase} action ${actionNames.join(" / ")} after ${prompts.length} prompt(s).\n${attempts.join("\n")}`,
    ).toBe(true);
  }

  function expectOnlyCompletedActions(
    actions: Array<{ phase: string; actionName: string }>,
    allowedActionNames: string[],
  ): void {
    const allowed = new Set(allowedActionNames.map(normalizeActionName));
    const completed = actions
      .filter((call) => call.phase === "completed")
      .map((call) => normalizeActionName(call.actionName));
    const unexpected = completed.filter((name) => !allowed.has(name));
    expect(
      unexpected,
      `Expected only ${allowedActionNames.join(", ")} as completed actions, but saw ${completed.join(",") || "(none)"}`,
    ).toHaveLength(0);
  }

  beforeAll(async () => {
    if (!canRunLiveTests) return;

    process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
    process.env.ENABLE_TRAJECTORIES = "false";
    process.env.ELIZA_TRAJECTORY_LOGGING = "false";
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
    previousDisableLifeOpsScheduler =
      process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = "1";

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
    await LifeOpsRepository.bootstrapSchema(runtime);

    const removedEvaluators = runtime.evaluators.map((e) => e.name);
    runtime.evaluators.splice(0, runtime.evaluators.length);

    registeredActions = new Set(
      runtime.actions.map((a) => normalizeActionName(a.name)),
    );

    const service = new LifeOpsService(runtime);
    twilioConfigured = Boolean(readTwilioCredentialsFromEnv());
    calendlyConfigured = Boolean(readCalendlyCredentialsFromEnv());
    healthBackendAvailable =
      (await detectHealthBackend().catch(() => "none")) !== "none";
    passwordManagerAvailable =
      (await detectPasswordManagerBackend().catch(() => "none")) !== "none";
    remoteDesktopAvailable =
      (await detectRemoteDesktopBackend().catch(() => "none")) !== "none";
    appBlockingAvailable = Boolean(
      (await getAppBlockerStatus().catch(() => null))?.available,
    );
    const websiteBlockStatus = await getSelfControlStatus().catch(() => null);
    websiteBlockingAvailable = Boolean(
      websiteBlockStatus?.available && !websiteBlockStatus.requiresElevation,
    );
    xReadConnected = Boolean(
      (await service.getXConnectorStatus().catch(() => null))?.connected,
    );
    const googleStatus = await service
      .getGoogleConnectorStatus(new URL("http://127.0.0.1/"))
      .catch(() => null);
    const googleCapabilities = new Set(googleStatus?.grantedCapabilities ?? []);
    googleCalendarWritable = Boolean(
      googleStatus?.connected &&
        googleCapabilities.has("google.calendar.write"),
    );

    logger.info(
      `[action-e2e] Setup complete — ${runtime.plugins.length} plugins, ` +
        `${runtime.actions.length} actions registered: ${[...registeredActions].join(", ")}`,
    );
    logger.info(
      `[action-e2e] Disabled evaluators for action-only assertions: ${removedEvaluators.join(", ") || "(none)"}`,
    );
    logger.info(
      `[action-e2e] Feature availability — appBlocking=${appBlockingAvailable}, calendly=${calendlyConfigured}, googleCalendarWritable=${googleCalendarWritable}, health=${healthBackendAvailable}, passwordManager=${passwordManagerAvailable}, remoteDesktop=${remoteDesktopAvailable}, twilio=${twilioConfigured}, xRead=${xReadConnected}`,
    );
  }, 180_000);

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
    if (previousDisableLifeOpsScheduler === undefined) {
      delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    } else {
      process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER =
        previousDisableLifeOpsScheduler;
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
          expectOnlyCompletedActions(turn.actions, ["REPLY", "IGNORE"]);
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
          expectOnlyCompletedActions(turn.actions, ["REPLY", "IGNORE"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "venting about email does not trigger email actions",
      async () => {
        await withHarness(async (h) => {
          await h.send(
            "I'm venting, not asking you to do anything: email has been overwhelming lately. Do not check inboxes, triage mail, draft, send, or take any action.",
          );
          expectActionNotCalled(h.spy, "MESSAGE");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "venting about calendar does not trigger CALENDAR",
      async () => {
        await withHarness(async (h) => {
          await h.send(
            "I'm just venting: my calendar has been crazy this quarter. Don't check it or schedule anything.",
          );
          expectActionNotCalled(h.spy, "CALENDAR");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "personality change request triggers MODIFY_CHARACTER",
      async () => {
        if (!requireAction("MODIFY_CHARACTER")) return;
        await withHarness(async (h) => {
          await sendUntilExpectedAction(
            h,
            ["MODIFY_CHARACTER"],
            [
              "Change your personality to be more casual and funny.",
              "Use the modify character action to make your response style more casual and funny.",
              "Update your character preferences: respond in a more casual, funny style from now on.",
            ],
          );
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "create todo triggers LIFE",
      async () => {
        if (!requireAction("LIFE")) return;
        await withHarness(async (h) => {
          await sendUntilExpectedAction(
            h,
            ["LIFE"],
            [
              "Add a todo: pick up dry cleaning tomorrow.",
              "Use the Life action to create a todo to pick up dry cleaning tomorrow.",
              "Create a LifeOps todo item named pick up dry cleaning due tomorrow.",
            ],
          );
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "set goal triggers LIFE",
      async () => {
        if (!requireAction("LIFE")) return;
        await withHarness(async (h) => {
          await sendUntilExpectedAction(
            h,
            ["LIFE"],
            [
              "Set a goal to save $5,000 by the end of the year.",
              "Use the Life action to create a goal to save $5,000 by the end of the year.",
              "Create a LifeOps goal named save $5,000 by the end of the year.",
            ],
          );
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    // Morning/night CHECKIN tests removed: the CHECKIN action was deleted in
    // favor of scheduled tasks. See plugins/app-lifeops/src/actions/CHECKIN_MIGRATION.TODO.md.
  });

  // ===================================================================
  //  2. Messaging
  // ===================================================================

  describe("messaging", () => {
    itIf(canRunLiveTests)(
      "telegram request triggers MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Send a telegram message to Jane saying I'm running 10 minutes late.",
          );
          expectAnySelectedAction(h, ["MESSAGE", "MESSAGE"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "signal request triggers MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Send a Signal message to Priya saying thanks for the review.",
          );
          expectAnySelectedAction(h, ["MESSAGE", "MESSAGE"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "signal draft request triggers MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Draft a Signal message to Priya saying thanks for the review.",
          );
          expectAnySelectedAction(h, ["MESSAGE", "MESSAGE"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "email draft request triggers MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await sendUntilExpectedAction(
            h,
            ["MESSAGE", "MESSAGE", "MESSAGE"],
            [
              "Email alice@example.com the meeting notes from today.",
              "Send an email to alice@example.com with the meeting notes from today.",
              "Use the send message action to send an email to alice@example.com containing the meeting notes from today.",
            ],
          );
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "gmail triage request selects MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await h.send("Triage my gmail inbox.");
          expectAnyCompletedAction(h, ["MESSAGE"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "generic inbox triage triggers MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await h.send("Triage my inbox.");
          expectActionCalled(h.spy, "MESSAGE");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "gmail send-reply request triggers MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Send a reply to the last email from finance confirming receipt.",
          );
          expectAnySelectedAction(h, ["MESSAGE", "MESSAGE"]);
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
      "show today's calendar triggers CALENDAR",
      async () => {
        if (!requireAction("CALENDAR")) return;
        await withHarness(async (h) => {
          await h.send("Show me my calendar for today.");
          expectActionCalled(h.spy, "CALENDAR");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "schedule event triggers CALENDAR",
      async () => {
        if (!requireAction("CALENDAR")) return;
        await withHarness(async (h) => {
          await h.send("Schedule a dentist appointment next Tuesday at 3pm.");
          expectActionCalled(h.spy, "CALENDAR");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "help me schedule a meeting triggers CALENDAR",
      async () => {
        if (!requireAction("CALENDAR")) return;
        await withHarness(async (h) => {
          await h.send("Help me schedule a meeting with the design team.");
          expectAnySelectedAction(h, [
            "SCHEDULING",
            "PROPOSE_MEETING_TIMES",
            "CALENDAR",
          ]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "availability question triggers CALENDAR",
      async () => {
        if (!requireAction("CALENDAR")) return;
        await withHarness(async (h) => {
          await h.send("Am I free on Thursday afternoon?");
          expectAnyCompletedAction(h, ["CALENDAR"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "propose times triggers CALENDAR",
      async () => {
        if (!requireAction("CALENDAR")) return;
        await withHarness(async (h) => {
          await h.send(
            "Propose three times for a 30 minute sync with Marco next week.",
          );
          expectAnyCompletedAction(h, ["CALENDAR"]);
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
          expectAnyCompletedAction(h, ["RELATIONSHIP"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "days-since-contact request triggers RELATIONSHIP",
      async () => {
        if (!requireAction("RELATIONSHIP")) return;
        await withHarness(async (h) => {
          await h.send(
            "Add David Park to my contacts. Email david@example.com and telegram @dpark.",
          );
          h.spy.reset();
          await h.send("How long has it been since I talked to David Park?");
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
      "block websites request triggers WEBSITE_BLOCK",
      async () => {
        if (!requireAction("WEBSITE_BLOCK")) return;
        if (
          !requireEnvironmentCapability(
            websiteBlockingAvailable,
            "website blocking",
          )
        )
          return;
        await withHarness(async (h) => {
          await h.send("Block twitter.com for exactly 90 minutes.");
          expectActionCalled(h.spy, "WEBSITE_BLOCK");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "block apps request triggers APP_BLOCK",
      async () => {
        if (!requireAction("APP_BLOCK")) return;
        if (!requireEnvironmentCapability(appBlockingAvailable, "app blocking"))
          return;
        await withHarness(async (h) => {
          await h.send("Block the Slack app while I focus on deep work.");
          expectActionCalled(h.spy, "APP_BLOCK");
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
        if (!requireEnvironmentCapability(xReadConnected, "X connector"))
          return;
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
        if (!requireEnvironmentCapability(xReadConnected, "X connector"))
          return;
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
        if (
          !requireEnvironmentCapability(
            healthBackendAvailable,
            "health backend",
          )
        )
          return;
        await withHarness(async (h) => {
          await h.send("How did I sleep last night?");
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
      "owner profile update request triggers PROFILE",
      async () => {
        if (!requireAction("PROFILE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Remember that I prefer aisle seats, carry-on only, and moderate hotels close to the venue.",
          );
          expectActionCalled(h.spy, "PROFILE");
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "broadcast intent triggers DEVICE_INTENT",
      async () => {
        if (!requireAction("DEVICE_INTENT")) return;
        await withHarness(async (h) => {
          await h.send("Broadcast a reminder to all my devices.");
          expectAnySelectedAction(h, ["DEVICE_INTENT"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "approve request prompt triggers RESOLVE_REQUEST",
      async () => {
        if (!requireAction("RESOLVE_REQUEST")) return;
        await withHarness(async (h) => {
          await h.send("Approve the pending travel booking request.");
          expectAnySelectedAction(h, ["RESOLVE_REQUEST"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "reject request prompt triggers RESOLVE_REQUEST",
      async () => {
        if (!requireAction("RESOLVE_REQUEST")) return;
        await withHarness(async (h) => {
          await h.send(
            "Reject that pending approval request and say it needs changes.",
          );
          expectAnySelectedAction(h, ["RESOLVE_REQUEST"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "browser settings request triggers MANAGE_LIFEOPS_BROWSER",
      async () => {
        if (!requireAction("MANAGE_LIFEOPS_BROWSER")) return;
        await withHarness(async (h) => {
          await h.send("Show me my LifeOps browser settings.");
          expectAnySelectedAction(h, ["MANAGE_LIFEOPS_BROWSER"]);
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
      "phone call request triggers VOICE_CALL",
      async () => {
        if (!requireAction("VOICE_CALL")) return;
        if (
          !requireEnvironmentCapability(twilioConfigured, "Twilio credentials")
        )
          return;
        await withHarness(async (h) => {
          await h.send("Call the dentist and reschedule my appointment.");
          expectAnySelectedAction(h, ["VOICE_CALL"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "password lookup request triggers PASSWORD_MANAGER",
      async () => {
        if (!requireAction("PASSWORD_MANAGER")) return;
        if (
          !requireEnvironmentCapability(
            passwordManagerAvailable,
            "password manager backend",
          )
        )
          return;
        await withHarness(async (h) => {
          await h.send("Look up my GitHub password.");
          expectAnySelectedAction(h, ["PASSWORD_MANAGER"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "remote desktop request triggers REMOTE_DESKTOP",
      async () => {
        if (!requireAction("REMOTE_DESKTOP")) return;
        if (
          !requireEnvironmentCapability(
            remoteDesktopAvailable,
            "remote desktop backend",
          )
        )
          return;
        await withHarness(async (h) => {
          await h.send("Start a remote desktop session.");
          expectAnySelectedAction(h, ["REMOTE_DESKTOP"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "calendly booking link request triggers CALENDAR",
      async () => {
        if (!requireAction("CALENDAR")) return;
        if (
          !requireEnvironmentCapability(
            calendlyConfigured,
            "Calendly credentials",
          )
        )
          return;
        await withHarness(async (h) => {
          await h.send(
            "Create a single-use Calendly booking link for https://api.calendly.com/event_types/abc.",
          );
          expectAnySelectedAction(h, ["CALENDAR"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "computer-use request triggers COMPUTER_USE",
      async () => {
        if (!requireAction("COMPUTER_USE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Use computer automation on this Mac to create a new folder named Q2-Reports in ~/Desktop.",
          );
          expectAnySelectedAction(h, ["COMPUTER_USE"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "email unsubscribe request triggers MESSAGE",
      async () => {
        if (!requireAction("MESSAGE")) return;
        await withHarness(async (h) => {
          await h.send(
            "Unsubscribe me from newsletters@medium.com and block them.",
          );
          expectAnySelectedAction(h, ["MESSAGE"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "book travel request triggers BOOK_TRAVEL",
      async () => {
        if (!requireAction("BOOK_TRAVEL")) return;
        await withHarness(async (h) => {
          await h.send(
            "Book travel for me from San Francisco to New York next Thursday and Friday.",
          );
          expectAnySelectedAction(h, ["BOOK_TRAVEL"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "field fill request triggers AUTOFILL",
      async () => {
        if (!requireAction("AUTOFILL")) return;
        await withHarness(async (h) => {
          await h.send(
            "Fill the password field on github.com using my password manager.",
          );
          expectAnySelectedAction(h, ["AUTOFILL"]);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS,
    );

    itIf(canRunLiveTests)(
      "subscription cancellation request triggers SUBSCRIPTIONS",
      async () => {
        if (!requireAction("SUBSCRIPTIONS")) return;
        await withHarness(async (h) => {
          await h.send(
            "Cancel my Google Play subscription and handle the cancellation workflow for me.",
          );
          expectAnySelectedAction(h, [
            "SUBSCRIPTIONS",
            "COMPUTER_USE",
          ]);
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
    const deadline = Date.now() + 5_000;
    let filtered: Memory[] = [];
    do {
      const memories = await rt.getMemories({
        tableName: "messages",
        roomId,
        count: 50,
      });
      filtered = memories.filter(
        (m) =>
          (m.content as { type?: string } | undefined)?.type ===
          "action_result",
      );
      if (filtered.length > 0) {
        return filtered;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);

    return filtered;
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

  function stringifyCompletedActionPayloads(
    harness: ConversationHarness,
    actionName: string,
  ): string {
    const target = normalizeActionName(actionName);
    return harness.spy
      .getCompletedCalls()
      .filter((call) => normalizeActionName(call.actionName) === target)
      .map((call) => {
        try {
          return JSON.stringify(call.payload.content);
        } catch {
          return String(call.payload.content);
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
          await sendUntilExpectedAction(
            h,
            ["LIFE"],
            [
              "Create a todo to call my mom.",
              "Use the LIFE action to create a todo to call my mom.",
              "Create a LifeOps todo item named call my mom.",
            ],
          );
          const callsBeforeSecond = h.spy.getCalls().length;

          await sendUntilExpectedAction(
            h,
            ["LIFE"],
            [
              "Mark the todo to call my mom as done.",
              "Use the LIFE action to complete the todo named call my mom.",
              "Update the LifeOps todo item named call my mom to completed.",
            ],
            "selected",
          );
          const secondTurnCalls = h.spy.getCalls().slice(callsBeforeSecond);
          expect(
            secondTurnCalls.some(
              (call) =>
                normalizeActionName(call.actionName) ===
                normalizeActionName("LIFE"),
            ),
            `Expected LIFE to be selected again on follow-up. secondTurn=${secondTurnCalls
              .map((c) => `${c.phase}:${c.actionName}`)
              .join(",")} allCompleted=${h.spy
              .getCompletedCalls()
              .map((c) => c.actionName)
              .join(",")}`,
          ).toBe(true);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );

    itIf(canRunLiveTests)(
      "extracts a 30-minute time window for a meeting schedule request",
      async () => {
        if (!requireAction("CALENDAR")) return;
        if (
          !requireEnvironmentCapability(
            googleCalendarWritable,
            "Google Calendar write access",
          )
        )
          return;
        await withHarness(async (h) => {
          await sendUntilExpectedAction(
            h,
            ["CALENDAR", "SCHEDULING"],
            [
              "Create a calendar event titled 'Q4 planning with John' tomorrow at 3pm for 30 minutes.",
              "Use my calendar to create an event titled 'Q4 planning with John' tomorrow at 3pm for 30 minutes.",
              "Run the owner calendar action to create an event titled 'Q4 planning with John' tomorrow at 3pm for 30 minutes.",
            ],
          );
          const results = await getActionResults(h.runtime, h.roomId);
          expect(
            results.length,
            "Expected at least one action_result memory",
          ).toBeGreaterThan(0);
          const blob = stringifyResults(results).toLowerCase();
          const resultData = results
            .map(
              (result) =>
                ((
                  result.content as
                    | { data?: Record<string, unknown> }
                    | undefined
                )?.data ?? null) as Record<string, unknown> | null,
            )
            .filter((data): data is Record<string, unknown> => data !== null);
          const dataWithBounds = resultData.find((data) => {
            const start =
              data.startAt ?? data.startat ?? data.timeMin ?? data.timemin;
            const end =
              data.endAt ?? data.endat ?? data.timeMax ?? data.timemax;
            return typeof start === "string" && typeof end === "string";
          });
          const startValue = (dataWithBounds?.startAt ??
            dataWithBounds?.startat ??
            dataWithBounds?.timeMin ??
            dataWithBounds?.timemin) as string | undefined;
          const endValue = (dataWithBounds?.endAt ??
            dataWithBounds?.endat ??
            dataWithBounds?.timeMax ??
            dataWithBounds?.timemax) as string | undefined;
          expect(
            startValue && endValue,
            `Expected start/end bounds in result data: ${blob}`,
          ).toBeTruthy();
          const startMs = Date.parse(String(startValue));
          const endMs = Date.parse(String(endValue));
          expect(
            Number.isFinite(startMs) && Number.isFinite(endMs),
            `Expected parseable datetime bounds in result data: ${blob}`,
          ).toBe(true);
          expect(
            Math.round((endMs - startMs) / 60000),
            `Expected a 30-minute duration in result data: ${blob}`,
          ).toBe(30);
          expect(
            blob,
            `Expected the meeting context to survive in result data: ${blob}`,
          ).toMatch(/john|q4 planning|3\s*pm|15:00|3:00/);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );

    itIf(canRunLiveTests)(
      "extracts duration for a website block request",
      async () => {
        if (!requireAction("WEBSITE_BLOCK")) return;
        if (
          !requireEnvironmentCapability(
            websiteBlockingAvailable,
            "website blocking",
          )
        )
          return;
        await withHarness(async (h) => {
          await sendUntilExpectedAction(
            h,
            ["WEBSITE_BLOCK"],
            [
              "Block twitter.com for exactly 90 minutes.",
              "Use website blocking to block twitter.com for exactly 90 minutes.",
              "Run the owner website block action for twitter.com with duration 90 minutes.",
            ],
          );
          const results = await getActionResults(h.runtime, h.roomId);
          const blob = [
            stringifyCompletedActionPayloads(h, "WEBSITE_BLOCK"),
            stringifyResults(results),
          ]
            .filter(Boolean)
            .join("\n")
            .toLowerCase();
          expect(
            blob.length,
            "Expected action payload or action_result data for WEBSITE_BLOCK",
          ).toBeGreaterThan(0);
          expect(
            blob,
            `Expected duration "90" in result data: ${blob}`,
          ).toMatch(/90/);
          expect(
            blob,
            `Expected "twitter" reference in result data: ${blob}`,
          ).toMatch(/twitter/);
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );

    itIf(canRunLiveTests)(
      "chat that merely mentions calendar does not trigger CALENDAR",
      async () => {
        await withHarness(async (h) => {
          await h.send(
            "I'm only talking about app design: the colors in my calendar app UI look nice. Don't check it or schedule anything.",
          );
          expectActionNotCalled(h.spy, "CALENDAR");
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
          await sendUntilExpectedAction(
            h,
            ["WEBSITE_BLOCK", "LIFE"],
            [
              "Block twitter.com for an hour and create a todo to stretch when the block ends.",
              "Use LifeOps actions to block twitter.com for one hour and create a todo to stretch when the block ends.",
              "Run either the owner website block action or the life todo action to handle this: block twitter.com for one hour and remind me to stretch when the block ends.",
            ],
          );
        });
      },
      DEFAULT_TEST_TIMEOUT_MS * 2,
    );
  });
});
