import { expect, type Page, type Route, test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const SMOKE_NOW = "2030-01-01T09:00:00.000Z";
const SMOKE_LATER = "2030-01-01T11:30:00.000Z";
const SMOKE_ALARM = "2030-01-01T14:15:00.000Z";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requestJson(route: Route): JsonRecord {
  const raw = route.request().postData();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function lifeOpsSummary(reminderCount: number) {
  return {
    activeOccurrenceCount: reminderCount,
    overdueOccurrenceCount: 0,
    snoozedOccurrenceCount: 0,
    activeReminderCount: reminderCount,
    activeGoalCount: 0,
  };
}

function lifeOpsDefinition(
  id: string,
  title: string,
  overrides: JsonRecord = {},
) {
  return {
    id,
    agentId: "agent-ui-smoke",
    domain: "owner",
    subjectType: "owner",
    subjectId: "owner-ui-smoke",
    visibilityScope: "owner",
    contextPolicy: { mode: "default" },
    kind: "task",
    title,
    description: `${title} description`,
    originalIntent: title,
    timezone: "America/New_York",
    status: "active",
    priority: 1,
    cadence: { kind: "daily", windows: ["morning"] },
    windowPolicy: {
      kind: "named_windows",
      windows: [{ name: "morning", startMinute: 9 * 60, endMinute: 10 * 60 }],
    },
    progressionRule: { kind: "fixed" },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "ui-smoke",
    metadata: {},
    createdAt: SMOKE_NOW,
    updatedAt: SMOKE_NOW,
    ...overrides,
  };
}

function definitionRecord(definition: JsonRecord) {
  return {
    definition,
    reminderPlan: null,
    performance: {
      scheduledCount: 1,
      completedCount: 0,
      skippedCount: 0,
      pendingCount: 1,
      completionRate: 0,
    },
  };
}

function lifeOpsReminder(
  title: string,
  occurrenceId: string,
  definitionId: string,
  scheduledFor: string,
) {
  return {
    domain: "owner",
    subjectType: "owner",
    subjectId: "owner-ui-smoke",
    ownerType: "occurrence",
    ownerId: occurrenceId,
    occurrenceId,
    definitionId,
    eventId: null,
    title,
    channel: "in_app",
    stepIndex: 0,
    stepLabel: "Reminder",
    scheduledFor,
    dueAt: scheduledFor,
    state: "scheduled",
    metadata: {},
    htmlLink: null,
    eventStartAt: null,
  };
}

function alarmDefinitionFromRequest(id: string, body: JsonRecord): JsonRecord {
  return lifeOpsDefinition(id, String(body.title ?? `Alarm ${id}`), {
    description: String(body.description ?? "Eliza alarm."),
    originalIntent: String(body.originalIntent ?? body.title ?? id),
    cadence: isRecord(body.cadence) ? body.cadence : { kind: "once" },
    windowPolicy: isRecord(body.windowPolicy)
      ? body.windowPolicy
      : {
          kind: "named_windows",
          windows: [
            { name: "alarm", startMinute: 9 * 60 + 15, endMinute: 9 * 60 + 16 },
          ],
        },
    source: String(body.source ?? "lifeops_ui_alarm"),
    metadata: isRecord(body.metadata) ? body.metadata : { lifeOpsAlarm: true },
  });
}

function installLifeOpsInteractionRoutes(page: Page) {
  const medDefinition = lifeOpsDefinition("def-med", "Refill med tray");
  const waterDefinition = lifeOpsDefinition(
    "def-water",
    "Send water plants note",
  );
  const alarmDefinition = lifeOpsDefinition(
    "def-existing-alarm",
    "Wakeup alarm",
    {
      cadence: { kind: "weekly", weekdays: [1, 3], windows: ["alarm"] },
      windowPolicy: {
        kind: "named_windows",
        windows: [
          { name: "alarm", startMinute: 7 * 60, endMinute: 7 * 60 + 1 },
        ],
      },
      source: "lifeops_ui_alarm",
      metadata: {
        lifeOpsAlarm: true,
        nativeAppleReminder: {
          kind: "alarm",
          provider: "apple_reminders",
          reminderId: "apple-alarm-1",
        },
      },
    },
  );

  const state = {
    overviewGets: 0,
    definitionGets: 0,
    snoozeRequests: [] as Array<{ occurrenceId: string; body: JsonRecord }>,
    completeRequests: [] as string[],
    createDefinitionRequests: [] as JsonRecord[],
    createdAlarmDefinitions: [] as JsonRecord[],
    nextAlarmId: 1,
  };

  const currentDefinitions = () => [
    definitionRecord(medDefinition),
    definitionRecord(waterDefinition),
    definitionRecord(alarmDefinition),
    ...state.createdAlarmDefinitions.map(definitionRecord),
  ];

  const currentReminders = () => [
    lifeOpsReminder("Refill med tray", "occ-med", "def-med", SMOKE_NOW),
    lifeOpsReminder(
      "Send water plants note",
      "occ-water",
      "def-water",
      SMOKE_LATER,
    ),
    lifeOpsReminder(
      "Wakeup alarm",
      "occ-existing-alarm",
      "def-existing-alarm",
      SMOKE_ALARM,
    ),
    ...state.createdAlarmDefinitions.map((definition, index) =>
      lifeOpsReminder(
        String(definition.title ?? "Created alarm"),
        `occ-created-alarm-${index + 1}`,
        String(definition.id),
        SMOKE_ALARM,
      ),
    ),
  ];

  const currentOverview = () => {
    const reminders = currentReminders();
    const summary = lifeOpsSummary(reminders.length);
    const emptySection = {
      occurrences: [],
      goals: [],
      reminders: [],
      summary: lifeOpsSummary(0),
    };
    return {
      occurrences: [],
      goals: [],
      reminders,
      summary,
      owner: {
        occurrences: [],
        goals: [],
        reminders,
        summary,
      },
      agentOps: emptySection,
      schedule: null,
    };
  };

  page.route("**/api/lifeops/overview", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    state.overviewGets += 1;
    await fulfillJson(route, currentOverview());
  });

  page.route("**/api/lifeops/definitions", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      state.definitionGets += 1;
      await fulfillJson(route, { definitions: currentDefinitions() });
      return;
    }
    if (method === "POST") {
      const body = requestJson(route);
      state.createDefinitionRequests.push(body);
      const id = `def-created-alarm-${state.nextAlarmId}`;
      state.nextAlarmId += 1;
      const definition = alarmDefinitionFromRequest(id, body);
      state.createdAlarmDefinitions.push(definition);
      await fulfillJson(route, definitionRecord(definition), 201);
      return;
    }
    await route.fallback();
  });

  page.route(/\/api\/lifeops\/definitions\/([^/?]+)$/, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    const definitionId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop() ?? "",
    );
    await fulfillJson(route, {
      ...definitionRecord(lifeOpsDefinition(definitionId, definitionId)),
      updated: requestJson(route),
    });
  });

  page.route(
    /\/api\/lifeops\/occurrences\/([^/?]+)\/snooze$/,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const occurrenceId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-2) ?? "",
      );
      state.snoozeRequests.push({ occurrenceId, body: requestJson(route) });
      await fulfillJson(route, { ok: true, occurrenceId });
    },
  );

  page.route(
    /\/api\/lifeops\/occurrences\/([^/?]+)\/complete$/,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const occurrenceId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-2) ?? "",
      );
      state.completeRequests.push(occurrenceId);
      await fulfillJson(route, { ok: true, occurrenceId });
    },
  );

  return state;
}

function installFeedTuiRoutes(page: Page) {
  const state = {
    commands: [] as string[],
  };

  page.route(/\/api\/views\/feed\/interact(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = requestJson(route);
    const capability =
      typeof body.capability === "string" ? body.capability : "unknown";
    state.commands.push(capability);

    if (capability === "refresh-agent-status") {
      await fulfillJson(route, {
        ok: true,
        status: {
          id: "feed-agent-smoke",
          displayName: "Smoke Feed Agent",
          agentStatus: "scanning",
          autonomous: true,
        },
        dashboard: {
          summary: { ownerName: "Smoke Feed Desk" },
        },
        markets: {
          markets: [
            {
              id: "market-ui-smoke",
              title: "Will deterministic UI coverage pass?",
              yesPrice: 0.72,
              noPrice: 0.28,
            },
          ],
        },
      });
      return;
    }

    if (capability === "send-team-message") {
      await fulfillJson(route, {
        ok: true,
        message: "Terminal status check queued for Feed social channel.",
      });
      return;
    }

    await fulfillJson(route, {
      ok: true,
      path: "/feed",
      endpoints: [
        "/api/apps/feed/agent/status",
        "/api/apps/feed/team/dashboard",
        "/api/apps/feed/markets",
      ],
    });
  });

  return state;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await installDefaultAppRoutes(page);
});

test("LifeOps app supports deterministic reminders and alarm interactions", async ({
  page,
}) => {
  const lifeOps = installLifeOpsInteractionRoutes(page);

  await openAppPath(page, "/lifeops");
  await assertReadyChecks(
    page,
    "lifeops app shell",
    [{ selector: '[data-testid="lifeops-shell"]' }],
    "all",
    90_000,
  );

  await page
    .getByTestId("lifeops-nav-rail")
    .getByRole("button", { name: "Reminders" })
    .click();

  const reminders = page.getByTestId("lifeops-reminders");
  await expect(reminders).toBeVisible();
  await expect(reminders.getByText("Refill med tray")).toBeVisible();
  await expect(reminders.getByText("Send water plants note")).toBeVisible();

  const medRow = reminders.locator(".group").filter({
    hasText: "Refill med tray",
  });
  const medRowButton = medRow
    .getByRole("button", { name: /^Refill med tray/ })
    .first();
  await medRowButton.click();
  await expect(medRowButton).toHaveAttribute("aria-pressed", "true");
  await medRow.getByRole("button", { name: "Snooze +15 min" }).click();
  await expect
    .poll(() => lifeOps.snoozeRequests)
    .toContainEqual({ occurrenceId: "occ-med", body: { preset: "15m" } });

  const waterRow = reminders.locator(".group").filter({
    hasText: "Send water plants note",
  });
  await waterRow.getByRole("button", { name: "Mark complete" }).click();
  await expect.poll(() => lifeOps.completeRequests).toContain("occ-water");

  await reminders.getByRole("tab", { name: /Alarms/ }).click();
  await expect(reminders.getByRole("tab", { name: /Alarms/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(reminders.getByText("Wakeup alarm")).toBeVisible();

  await reminders.getByRole("button", { name: "Add alarm" }).click();
  await reminders.getByLabel("Time").fill("09:15");
  await reminders.getByLabel("Label (optional)").fill("Standup alarm");
  await reminders.getByTitle("Monday").click();
  await reminders.getByTitle("Wednesday").click();
  await reminders.getByRole("button", { name: "Save alarm" }).click();

  await expect
    .poll(() => lifeOps.createDefinitionRequests.at(-1))
    .toMatchObject({
      title: "Standup alarm",
      cadence: { kind: "weekly", weekdays: [1, 3] },
      metadata: { lifeOpsAlarm: true },
    });
  await expect(reminders.getByText("Standup alarm")).toBeVisible();

  const beforeRefresh = lifeOps.overviewGets;
  await reminders.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => lifeOps.overviewGets).toBeGreaterThan(beforeRefresh);
  await expect.poll(() => lifeOps.definitionGets).toBeGreaterThan(0);
});

test("LifeOps assistant launches chat-first command prompts", async ({
  page,
}) => {
  installLifeOpsInteractionRoutes(page);

  await openAppPath(page, "/lifeops");
  await assertReadyChecks(
    page,
    "lifeops assistant app shell",
    [{ selector: '[data-testid="lifeops-shell"]' }],
    "all",
    90_000,
  );

  const nav = page.getByTestId("lifeops-nav-rail");
  await nav.getByRole("button", { name: "Assistant" }).click();

  const assistant = page.getByTestId("lifeops-assistant-intents");
  await expect(assistant).toBeVisible();

  const composer = page.getByTestId("chat-composer-textarea");
  await page.getByTestId("lifeops-assistant-command-brief").click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(/LifeOps command brief/);

  await page.getByTestId("lifeops-assistant-voice-command").click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Voice command for LifeOps: ");

  await page.getByRole("button", { name: "Quick Inbox decisions" }).click();
  await expect(composer).toHaveValue(/Find messages that need my decision/);

  const scenarioBackedCommands = [
    ["Approval batch", /Batch pending approvals/],
    ["Privacy redaction", /privacy-safe summary/],
    ["Interruption firebreak", /Protect my focus block/],
    ["Status compression", /Compress status across active projects/],
    ["VIP escalation", /Handle a VIP escalation/],
    ["Delegation map", /Map delegated work by owner/],
    ["Remote agent stuck", /Unstick a remote agent/],
    ["Family logistics", /Coordinate family logistics/],
    ["Outage recovery", /Recover from a service or workflow outage/],
    ["Weekly operating review", /Run my weekly operating review/],
    ["Board pack prep", /Prepare the board pack brief/],
    ["Chief-of-staff handoff", /Build a chief-of-staff handoff/],
    ["Event planning", /Coordinate event planning/],
    ["Finance dispute", /Handle a finance dispute/],
    ["Gift milestone", /Prepare a relationship milestone gift/],
    ["Hiring loop", /Coordinate the hiring loop/],
    ["Intro routing", /Triage inbound intro requests/],
    ["Legal deadline", /Track the legal document deadline/],
    ["Travel disruption", /Recover from a travel disruption/],
    ["Vendor negotiation", /Prepare vendor renewal negotiation/],
  ] as const;

  for (const [label, expectedPrompt] of scenarioBackedCommands) {
    await assistant.getByRole("button", { name: label }).click();
    await expect(composer, `${label} should prefill chat`).toHaveValue(
      expectedPrompt,
    );
  }
});

test("Feed routes expose reachable GUI state and deterministic TUI commands", async ({
  page,
}) => {
  const feedTui = installFeedTuiRoutes(page);

  await openAppPath(page, "/feed");
  await assertReadyChecks(
    page,
    "feed gui no-run state",
    [
      { text: "Feed operator surface" },
      { text: "Launch Feed to see live team coordination" },
    ],
    "all",
    90_000,
  );

  await openAppPath(page, "/feed/tui");
  await assertReadyChecks(
    page,
    "feed tui",
    [
      { text: "elizaos://feed --type=tui" },
      { text: "refresh-agent-status" },
      { text: "send-team-message" },
    ],
    "all",
    90_000,
  );

  await page.getByRole("button", { name: "Run refresh-agent-status" }).click();
  await expect(
    page.locator('[data-terminal-output="ok"]').last(),
  ).toContainText("Smoke Feed Agent");
  await expect(
    page.locator('[data-terminal-output="ok"]').last(),
  ).toContainText("Will deterministic UI coverage pass?");

  await page.getByRole("button", { name: "Run send-team-message" }).click();
  await expect(
    page.locator('[data-terminal-output="ok"]').last(),
  ).toContainText("Terminal status check queued for Feed social channel.");
  await expect
    .poll(() => feedTui.commands)
    .toEqual(["refresh-agent-status", "send-team-message"]);
});
