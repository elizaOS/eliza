// Live-stack e2e for issue #11792: prove the scheduled-task / reminder
// create -> fire -> notification pipeline end to end against the REAL app
// runtime (no mocks, no component fixture).
//
// Enable with ELIZA_UI_SMOKE_LIVE_STACK=1 (the harness boots the real
// app-core runtime). The spec also needs @elizaos/plugin-personal-assistant
// enabled so its LIFEOPS_SCHEDULER task worker drives the ScheduledTask runner
// and its in_app notification dispatch — set
// ELIZA_UI_SMOKE_PLUGIN_ENTRIES=personal-assistant.
//
// Flow:
//   1. Create a `reminder` ScheduledTask ~75s out via the app's own API
//      (POST /api/lifeops/scheduled-tasks) — the exact route the UI client hits.
//   2. Prove the server persists the row (GET read-back) and the UI reads it
//      back (the row renders in the Automations feed).
//   3. Fire it through the REAL runner: drive the real TaskService
//      (POST /api/background/run-due-tasks) in a bounded loop until the
//      LIFEOPS_SCHEDULER tick fires the due reminder — asserting the row
//      transitions out of `scheduled` AND a `reminder` notification is emitted.
//   4. Prove the dashboard notification center (NotificationsHomeCenter, the
//      widget pinned on the home dashboard — THE in-app notification surface)
//      renders the fired reminder in the real UI (desktop + mobile). The
//      `eliza:notifications:open` event navigates to the home dashboard, so
//      dispatching it both exercises the event contract and lands on the
//      widget.

import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const EVIDENCE_DIR = process.env.W8B_EVIDENCE_DIR?.trim() || "";
const OPEN_NOTIFICATION_CENTER_EVENT = "eliza:notifications:open";

interface ScheduledTaskView {
  taskId: string;
  kind: string;
  promptInstructions: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
  state: { status: string; firedAt?: string };
}

interface AgentNotification {
  id: string;
  title: string;
  body?: string;
  category: string;
  priority: string;
  source?: string;
  groupKey?: string;
  readAt?: string | null;
}

async function getJson<T>(req: APIRequestContext, path: string): Promise<T> {
  const res = await req.get(path);
  expect(res.status(), `GET ${path}`).toBe(200);
  return (await res.json()) as T;
}

/** Best-effort GET that returns null on any transport/status blip (used inside
 *  the bounded fire-poll loop so a transient hiccup retries instead of failing). */
async function tryGetJson<T>(
  req: APIRequestContext,
  path: string,
): Promise<T | null> {
  try {
    const res = await req.get(path, { timeout: 10_000 });
    if (res.status() !== 200) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function installFailureCollectors(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });
  return failures;
}

async function visible(locator: Locator, timeout: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

/** Wait for the app shell to be interactive after a (re)load. */
async function waitAppReady(page: Page): Promise<void> {
  const composer = page.getByRole("combobox", { name: /message/i });
  const main = page.locator("main").first();
  if (!(await visible(composer, 60_000))) {
    await expect(main).toBeVisible({ timeout: 60_000 });
  }
}

/**
 * Land on the Automations feed and keep it there. The shell briefly honours the
 * boot URL then can re-resolve to its default landing tab, so after the initial
 * nav we re-apply the route in-app (history + popstate — the mechanism the app's
 * router listens to) until the feed shell sticks.
 */
async function ensureAutomationsFeed(page: Page): Promise<void> {
  const shell = page.getByTestId("automations-shell");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await visible(shell, 4_000)) {
      await page.waitForTimeout(2_000);
      if (
        await shell
          .first()
          .isVisible()
          .catch(() => false)
      )
        return;
    }
    await page.evaluate(() => {
      window.history.pushState(null, "", "/automations");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.waitForTimeout(1_500);
  }
  await expect(shell).toBeVisible({ timeout: 15_000 });
}

/**
 * Dispatch the surface-agnostic "open notifications" event. Its handler
 * (notifications-boot) navigates to the home dashboard, where the pinned
 * NotificationsHomeCenter widget IS the notification center — so the dispatch
 * covers the event contract AND gets the widget on screen.
 */
async function openNotificationsDashboard(page: Page): Promise<void> {
  await page.evaluate((eventName) => {
    window.dispatchEvent(new CustomEvent(eventName));
  }, OPEN_NOTIFICATION_CENTER_EVENT);
}

async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const file = EVIDENCE_DIR ? `${EVIDENCE_DIR}/${name}.png` : undefined;
  const buf = await page.screenshot({
    fullPage: true,
    ...(file ? { path: file } : {}),
  });
  await testInfo.attach(name, { body: buf, contentType: "image/png" });
}

test.describe("scheduled reminder create -> fire -> dashboard notification center", () => {
  test.skip(
    !LIVE_STACK,
    "set ELIZA_UI_SMOKE_LIVE_STACK=1 (+ ELIZA_UI_SMOKE_PLUGIN_ENTRIES=personal-assistant) to run against the real runtime",
  );

  test("reminder fires through the real runner and renders in the dashboard notification center", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(420_000);
    const failures = installFailureCollectors(page);

    const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const marker = `W8B11792-${runId}`;
    // metadata.slot becomes the row TITLE in the Automations feed; the reminder
    // text (promptInstructions) becomes the notification BODY. Both carry the
    // marker so they are uniquely locatable in the feed and the rail.
    const slotTitle = `${marker} drink water`;
    const reminderText = `Reminder (${marker}): drink a glass of water — issue #11792 live proof.`;
    // ~30s out: the reminder becomes due at +30s and the LifeOps scheduler tick
    // (60s cadence) fires it ~60-90s later, so end to end it lands ~2 min after
    // creation — a real timed fire, not an immediate one.
    const atIso = new Date(Date.now() + 30_000).toISOString();

    // ── 1. CREATE via the real API (loopback-trusted, the UI client's route) ─
    const createRes = await request.post("/api/lifeops/scheduled-tasks", {
      data: {
        kind: "reminder",
        promptInstructions: reminderText,
        trigger: { kind: "once", atIso },
        // `medium` keeps the dispatch a plain "reminder"; the default ladder
        // escalates a `high` reminder to intensity `urgent`, which the dispatcher
        // surfaces as an "Approval needed" (category `approval`) notification.
        priority: "medium",
        output: { destination: "in_app_card" },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: "w8b-e2e",
        ownerVisible: true,
        idempotencyKey: marker,
        metadata: { slot: slotTitle, recordKey: marker },
      },
    });
    expect(
      createRes.status(),
      `create should return 201 (got ${createRes.status()}: ${(await createRes.text()).slice(0, 500)})`,
    ).toBe(201);
    const created = (await createRes.json()) as { task: ScheduledTaskView };
    const taskId = created.task?.taskId;
    expect(taskId, "created task id").toBeTruthy();
    expect(created.task.state.status).toBe("scheduled");

    // ── 2. READ BACK from the real API (persisted) ─────────────────────────
    const list1 = await getJson<{ tasks: ScheduledTaskView[] }>(
      request,
      "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
    );
    const persisted = (list1.tasks ?? []).find((t) => t.taskId === taskId);
    expect(
      persisted,
      "created reminder should be read back from GET /api/lifeops/scheduled-tasks",
    ).toBeTruthy();
    expect(persisted?.state.status).toBe("scheduled");
    expect(persisted?.promptInstructions).toContain(marker);

    // ── 3. UI READ-BACK — the row renders in the feed ──────────────────────
    // The reminder already exists, so the reliable initial nav paints it.
    await seedAppStorage(page);
    await openAppPath(page, "/automations");
    await ensureAutomationsFeed(page);
    await expect(
      page.getByText(slotTitle, { exact: false }).first(),
      "the created reminder row should render in the Automations feed",
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, "01-automations-feed-scheduled");

    // ── 4. FIRE through the REAL runner ────────────────────────────────────
    // The real core TaskService runs the LifeOps scheduler tick on its own 60s
    // cadence; that tick calls processDueScheduledTasks -> runner.fire -> in_app
    // dispatch. We POST run-due-tasks as a best-effort accelerator (it is a no-op
    // on hosts where the route reports the task service unavailable) and poll the
    // real API until the row has fired AND the reminder notification exists.
    const deadline = Date.now() + 240_000;
    let firedTask: ScheduledTaskView | undefined;
    let firedNotification: AgentNotification | undefined;
    let ticks = 0;
    while (Date.now() < deadline) {
      ticks += 1;
      await request
        .post("/api/background/run-due-tasks", { timeout: 10_000 })
        .catch(() => undefined);

      const listNow = await tryGetJson<{ tasks: ScheduledTaskView[] }>(
        request,
        "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
      );
      const t = (listNow?.tasks ?? []).find((x) => x.taskId === taskId);

      const notifs = await tryGetJson<{ notifications: AgentNotification[] }>(
        request,
        "/api/notifications?category=reminder&limit=100",
      );
      const n = (notifs?.notifications ?? []).find(
        (x) => (x.body ?? "").includes(marker) || x.title.includes(marker),
      );

      if (t && t.state.status !== "scheduled" && n) {
        firedTask = t;
        firedNotification = n;
        break;
      }
      await page.waitForTimeout(6_000);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[w8b] fire loop: ticks=${ticks} firedStatus=${firedTask?.state.status} notif=${firedNotification?.id} cat=${firedNotification?.category}`,
    );

    expect(
      firedTask,
      `reminder should transition out of "scheduled" via the real runner (ticks=${ticks})`,
    ).toBeTruthy();
    expect(firedTask?.state.status).toMatch(/^(fired|acknowledged|completed)$/);
    expect(firedTask?.state.firedAt, "firedAt stamped").toBeTruthy();

    expect(
      firedNotification,
      "firing should emit a reminder notification",
    ).toBeTruthy();
    if (!firedNotification) {
      throw new Error("unreachable: firedNotification asserted above");
    }
    expect(firedNotification.category).toBe("reminder");
    expect(firedNotification.body ?? "").toContain(marker);
    expect(firedNotification.title, "fired notification title").toBeTruthy();

    // Persist the domain artifacts (API truth) as evidence.
    await testInfo.attach("scheduled-task-fired.json", {
      body: JSON.stringify(firedTask, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("notification-fired.json", {
      body: JSON.stringify(firedNotification, null, 2),
      contentType: "application/json",
    });

    // ── 5. UI shows the fired feed + the dashboard notification center ─────
    // Reload re-hydrates the notification store from GET /api/notifications
    // (now containing the fired reminder) and refetches the scheduled-tasks.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitAppReady(page);
    await ensureAutomationsFeed(page);
    await expect(
      page.getByText(slotTitle, { exact: false }).first(),
      "the reminder row still renders after firing",
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, "03-automations-feed-after-fire");

    // The "open notifications" event navigates to the home dashboard, where
    // notifications hide behind the pull-up hint — opening the shade must
    // render the fired reminder as a row in the inbox card.
    await openNotificationsDashboard(page);
    const hint = page.getByTestId("home-notifications-hint");
    await expect(
      hint,
      "the open-notifications event should land on the home dashboard with the notifications pull-up hint",
    ).toBeVisible({ timeout: 15_000 });
    await hint.click();
    const center = page.getByTestId("home-notification-center");
    await expect(
      center,
      "opening the shade should reveal the notification inbox card",
    ).toBeVisible({ timeout: 15_000 });
    const reminderRow = center
      .getByTestId("notification-row")
      .filter({ hasText: marker })
      .first();
    await expect(
      reminderRow,
      "the fired reminder should render as a row in the dashboard notification center",
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      reminderRow,
      "the row should carry the reminder notification's title",
    ).toContainText(firedNotification.title);
    await shot(page, testInfo, "04-notification-center-desktop");

    // Mobile viewport capture of the same widget.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitAppReady(page);
    await openNotificationsDashboard(page);
    await page.getByTestId("home-notifications-hint").click();
    await expect(
      page
        .getByTestId("home-notification-center")
        .getByTestId("notification-row")
        .filter({ hasText: marker })
        .first(),
      "the fired reminder should render in the mobile notification shade",
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, testInfo, "05-notification-center-mobile");

    expect(failures, "no uncaught page errors during the flow").toEqual([]);
  });
});
