import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

async function fixture(page: Page) {
  const apiBase = test.info().project.use.baseURL;
  if (!apiBase) throw new Error("Mobile entry fixture requires a base URL");
  await seedAppStorage(page, {
    "eliza:permissions-primed": "1",
    "elizaos:active-server": JSON.stringify({
      id: "remote:u1-fixture",
      kind: "remote",
      label: "U1 fixture",
      apiBase,
    }),
  });
  await installDefaultAppRoutes(page);
  await page.addInitScript(() => {
    Reflect.set(window, "androidBridge", {});
    Reflect.set(window, "u1NativeLaunches", 0);
    const storage = new Map(Object.entries(localStorage));
    const protectedKeys: Record<string, string> = {
      "session.device_auth": "eliza.device.auth",
      "session.steward_token": "steward_session_token",
      "runtime.active_server": "elizaos:active-server",
      "runtime.agent_profiles": "elizaos:agent-profiles",
    };
    const methods: Record<string, string[]> = {
      ElizaSecureStore: ["get", "set", "remove", "status"],
      ElizaSense: ["turnOff"],
      Preferences: ["get", "set", "remove", "keys", "clear"],
      ElizaSystem: [
        "listLauncherApps",
        "launchApp",
        "getBuildInfo",
        "getLocaleInfo",
      ],
      App: ["getLaunchUrl", "getInfo", "getState"],
      DeepLinkBuffer: [
        "takePending",
        "drain",
        "peekPendingUrl",
        "clearPendingUrl",
      ],
      Keyboard: [
        "setScroll",
        "setResizeMode",
        "hide",
        "show",
        "setAccessoryBarVisible",
      ],
    };
    Reflect.set(window, "Capacitor", {
      Plugins: {},
      PluginHeaders: Object.entries(methods).map(([name, names]) => ({
        name,
        methods: [
          ...names.map((name) => ({ name, rtype: "promise" })),
          { name: "addListener", rtype: "callback" },
          { name: "removeListener", rtype: "promise" },
        ],
      })),
      nativeCallback: () => "",
      nativePromise: async (
        plugin: string,
        method: string,
        options: { key?: string; value?: string } = {},
      ) => {
        if (plugin === "ElizaSense" && method === "turnOff") {
          Reflect.set(
            window,
            "u1NativeStopCalls",
            Number(Reflect.get(window, "u1NativeStopCalls") ?? 0) + 1,
          );
          return {
            available: true,
            state: "OFF",
            listening:
              Reflect.get(window, "u1UnconfirmedListenerStop") === true,
            microphoneOpen: false,
          };
        }
        if (plugin === "ElizaSecureStore" || plugin === "Preferences") {
          const key =
            plugin === "ElizaSecureStore"
              ? protectedKeys[options.key ?? ""]
              : (options.key ?? "");
          if (method === "get") {
            const value = key ? (storage.get(key) ?? null) : null;
            return plugin === "Preferences"
              ? { value }
              : value === null
                ? { ok: false, error: "not_found" }
                : { ok: true, value };
          }
          if (method === "set") {
            storage.set(key, options.value ?? "");
            return { ok: true };
          }
          if (method === "remove") {
            storage.delete(key);
            return { ok: true, deleted: true };
          }
          if (method === "keys") return { keys: [...storage.keys()] };
          return { ok: true, available: true };
        }
        if (plugin === "ElizaSystem" && method === "launchApp")
          Reflect.set(
            window,
            "u1NativeLaunches",
            Number(Reflect.get(window, "u1NativeLaunches")) + 1,
          );
        if (plugin === "ElizaSystem" && method === "listLauncherApps")
          return { apps: [] };
        if (method === "getLaunchUrl") return {};
        if (method === "getState") return { isActive: true };
        if (method === "takePending" || method === "drain") return { urls: [] };
        return {};
      },
    });
  });
}
test("Android production root owns Home and preserves Projects routes", async ({
  page,
}, info) => {
  await fixture(page);
  for (const path of ["/chat", "/views", "/apps"]) {
    await openAppPath(page, path);
    await expect(page.locator("[data-mobile-application]")).toHaveCount(1);
    await expect(page.locator("[data-mobile-shell-home]")).toHaveCount(1);
    await expect(page.locator("[data-mobile-shell-home]")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(
      page.locator('[data-testid="home-launcher-surface"]'),
    ).toHaveCount(0);
    if (path === "/chat") {
      await expect
        .poll(() =>
          page
            .locator("[data-mobile-shell-tile] [data-launcher-glyph]")
            .evaluateAll(
              (images) =>
                images.length > 0 &&
                images.every(
                  (image) =>
                    (image as HTMLImageElement).complete &&
                    (image as HTMLImageElement).naturalWidth > 0,
                ),
            ),
        )
        .toBe(true);
      await page.screenshot({
        path: info.outputPath("canonical-home-icons.png"),
      });
    }
    if (path !== "/apps")
      await expect(
        page.getByRole("button", { name: "All apps", exact: true }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("tablist", { name: "Projects sections" }),
      ).toBeVisible();
  }
});
test("All apps opens the existing Projects view", async ({ page }, info) => {
  await fixture(page);
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-textarea")).toBeEditable();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "All apps", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "All apps", exact: true });
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole("button", { name: /^Open Projects(?: \(.*\))?$/ })
    .click();
  await expect(
    page.getByRole("tablist", { name: "Projects sections" }),
  ).toBeVisible();
  await expect(page.locator("[data-mobile-shell-home]")).toHaveAttribute(
    "inert",
    "",
  );
  await expect(page.locator("[data-mobile-routed-content]")).not.toHaveCSS(
    "pointer-events",
    "none",
  );
  await page.screenshot({
    path: info.outputPath("shared-mobile-projects.png"),
  });
});
test("Wallet stays in the app and favorite changes survive reload", async ({
  page,
}) => {
  await fixture(page);
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-textarea")).toBeEditable();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "All apps", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "All apps", exact: true });
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  await drawer
    .getByRole("button", {
      name: "Remove Settings from favorites",
      exact: true,
    })
    .click();
  await expect(
    drawer.getByRole("button", {
      name: "Add Settings to favorites",
      exact: true,
    }),
  ).toBeVisible();
  const favorites = () =>
    page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("eliza.launcher.favorites.v1") ?? "null",
        )?.keys ?? [],
    );
  expect(await favorites()).not.toContain("eliza:settings");
  await drawer
    .getByRole("button", { name: /^Open Wallet(?: \(.*\))?$/ })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            Reflect.get(window, "__ELIZAOS_UI_APP_STORE__") as {
              value: { tab: string };
            }
          ).value.tab,
      ),
    )
    .toBe("inventory");
  await expect(
    page.getByRole("region", { name: "Wallet holdings", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "u1NativeLaunches")),
  ).toBe(0);
  await page.reload();
  await expect(page.locator("[data-mobile-application]")).toHaveCount(1);
  await expect.poll(favorites).not.toContain("eliza:settings");
  await expect(
    page.locator("[data-mobile-shell-tile]").filter({ hasText: /^Wallet$/ }),
  ).toHaveCount(1);
  await expect(
    page.locator("[data-mobile-shell-tile]").filter({ hasText: /^Settings$/ }),
  ).toHaveCount(0);
});
test("mobile route placement preserves composer and keyboard access to Home actions", async ({
  page,
}, info) => {
  await fixture(page);
  await openAppPath(page, "/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeEditable({ timeout: 10000 });
  await composer.fill("Keep this draft");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "All apps", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "All apps" })).toBeVisible();
  await page
    .getByRole("button", { name: "Close all apps", exact: true })
    .click();
  await page.evaluate(() => {
    const state = (
      Reflect.get(window, "__ELIZAOS_UI_APP_STORE__") as {
        value?: { setTab: (tab: string) => void };
      }
    )?.value;
    if (!state) throw Error("No production AppState");
    state.setTab("settings");
  });
  await expect(page.locator("[data-mobile-routed-content]")).toBeVisible();
  const bounds = await page
    .locator("[data-mobile-routed-content]")
    .boundingBox();
  expect(bounds?.height).toBeGreaterThan(700);
  await page.evaluate(() => {
    const state = (
      Reflect.get(window, "__ELIZAOS_UI_APP_STORE__") as {
        value: { setTab: (tab: string) => void };
      }
    ).value;
    state.setTab("chat");
  });
  await expect(composer).toHaveValue("Keep this draft");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("toggle-custom-actions-panel")),
  );
  const search = page.getByPlaceholder(/search/i).last();
  await expect(search).toBeVisible();
  await expect
    .poll(async () => (await search.boundingBox())?.width ?? 0)
    .toBeGreaterThan(200);
  await search.fill("Keyboard action");
  await expect(search).toHaveValue("Keyboard action");
  await page.screenshot({ path: info.outputPath("home-action-panel.png") });
});

test("Android Notes keeps one inert editor across Home with an in-flight failed save", async ({
  page,
}, info) => {
  await fixture(page);
  await openAppPath(page, "/notes");
  await page
    .getByRole("button", { name: "Note Launch checklist", exact: true })
    .click();
  const body = page.getByRole("textbox", { name: "Note", exact: true });
  const original = await body.elementHandle();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route("**/api/views/notes/interact", async (route) => {
    writes++;
    await held;
    await route.fulfill({
      status: 503,
      json: { error: "Controlled save failure" },
    });
  });
  await body.fill("Keep the in-flight Notes draft");
  await expect.poll(() => writes).toBeGreaterThan(0);
  const navigate = (viewPath: string) =>
    page.evaluate(
      (viewPath) =>
        window.dispatchEvent(
          new CustomEvent("eliza:navigate:view", { detail: { viewPath } }),
        ),
      viewPath,
    );
  await navigate("/chat");
  await expect(page.locator("[data-retained-notes]")).toHaveAttribute(
    "inert",
    "",
  );
  await expect(page.locator("[data-retained-notes]")).toBeHidden();
  await navigate("/notes");
  await expect(body).toHaveValue("Keep the in-flight Notes draft");
  expect(await body.evaluate((node, prior) => node === prior, original)).toBe(
    true,
  );
  release();
  await expect(
    page.getByRole("button", { name: "Discard draft and reload", exact: true }),
  ).toBeVisible();
  await navigate("/chat");
  await navigate("/notes");
  await expect(body).toHaveValue("Keep the in-flight Notes draft");
  expect(writes).toBe(1);
  await page.screenshot({ path: info.outputPath("retained-note-failure.png") });
});

test("routed Experience content remains clickable outside the mobile launcher catalog", async ({
  page,
}, info) => {
  await fixture(page);
  await openAppPath(page, "/character/experience");
  const filter = page.locator('[data-agent-id="experience-filter-review"]');
  await expect(filter).toBeVisible();
  await filter.click({ timeout: 5000 });
  await page
    .getByRole("menuitemradio", { name: "Needs review", exact: true })
    .click();
  await expect(filter).toContainText("Needs review");
  await expect(page.locator("[data-mobile-application-view]")).toHaveCount(0);
  await expect(
    page.getByText("This app is unavailable.", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("routed-experience-interaction.png"),
  });
});

test("chat-only Android requests a native stop and keeps contradictory receipts visible", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    Reflect.set(window, "u1UnconfirmedListenerStop", true),
  );
  await fixture(page);
  await openAppPath(page, "/chat");
  const notice = page.getByTestId("wake-listener-stop-unconfirmed");
  await expect(notice).toBeVisible();
  await page.screenshot({ path: info.outputPath("stop-unconfirmed.png") });
  await page.waitForTimeout(750);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(Reflect.get(window, "u1NativeStopCalls") ?? 0),
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    Reflect.set(window, "u1UnconfirmedListenerStop", false),
  );
  await notice
    .getByRole("button", { name: "Retry stopping wake listening" })
    .click();
  await expect(notice).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("stop-confirmed.png") });
});

test("Android Calendar uses the shared workspace and existing editor", async ({
  page,
}, info) => {
  await fixture(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/lifeops/calendar/") &&
      request.method() !== "GET"
    )
      writes.push(request.method());
  });
  await page.route("**/api/lifeops/calendar/calendars**", async (route) => {
    await route.fulfill({
      json: {
        calendars: [
          {
            provider: "eliza",
            side: "owner",
            grantId: "u6-calendar",
            calendarId: "primary",
            connectorAccountId: null,
            accountEmail: null,
            summary: "Calendar fixture",
            description: null,
            primary: true,
            accessRole: "owner",
            backgroundColor: null,
            foregroundColor: null,
            timeZone: "UTC",
            selected: true,
            includeInFeed: true,
          },
        ],
      },
    });
  });
  await page.route("**/api/lifeops/calendar/feed**", async (route) => {
    const url = new URL(route.request().url());
    const start = new Date();
    start.setHours(10, 0, 0, 0);
    await route.fulfill({
      json: {
        events: Array.from({ length: 5 }, (_, index) => ({
          id: `u6-event-${index}`,
          externalId: `u6-event-${index}`,
          agentId: "smoke-agent",
          provider: "eliza",
          side: "owner",
          grantId: "u6-calendar",
          calendarId: "primary",
          title: `U6 planning ${index + 1}`,
          description: "Existing editor owns this event",
          location: "",
          status: "confirmed",
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 3600000).toISOString(),
          isAllDay: false,
          timezone: null,
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: { etag: "u6-v1" },
          syncedAt: start.toISOString(),
          updatedAt: start.toISOString(),
        })),
        source: "cache",
        state: "complete",
        sources: [],
        timeMin: url.searchParams.get("timeMin"),
        timeMax: url.searchParams.get("timeMax"),
        syncedAt: start.toISOString(),
      },
    });
  });
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-textarea")).toBeEditable();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "All apps", exact: true }).click();
  await page
    .getByRole("dialog", { name: "All apps", exact: true })
    .getByRole("button", { name: /^Open Calendar(?: \(.*\))?$/ })
    .click();
  await expect(page.getByTestId("lifeops-calendar-section")).toBeVisible();
  await expect(page.locator("[data-mobile-application]")).toHaveCount(1);
  if (!process.env.U6_BASELINE)
    await expect(page.locator("[data-shared-workspace]")).toHaveCount(1);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page.getByRole("button", { name: "+2 more", exact: true }).click();
  const overflow = page.getByTestId("lifeops-calendar-day-overflow");
  await expect(overflow).toBeVisible();
  await expect(overflow).toHaveCSS("width", "256px");
  await page.screenshot({
    path: info.outputPath("canonical-calendar-month.png"),
  });
  await overflow.getByRole("button", { name: /U6 planning 4/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Event title", exact: true }),
  ).toHaveValue("U6 planning 4");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("lifeops-calendar-new-event").click();
  await page
    .getByRole("textbox", { name: "Event title", exact: true })
    .fill("Keep the existing Calendar editor");
  await page.screenshot({
    path: info.outputPath("canonical-calendar-editor.png"),
  });
  expect(writes).toEqual([]);
});

test("Home Calendar ranks the current visible feed and retires held old-owner reads", async ({
  page,
}, info) => {
  let clock = new Date("2026-10-02T12:00:00Z");
  await page.clock.setFixedTime(clock);
  await fixture(page);
  await page.route("**/api/plugins", (route) =>
    route.fulfill({
      json: {
        plugins: [
          {
            id: "calendar",
            name: "Calendar",
            enabled: true,
            isActive: true,
            configured: true,
            description: "Calendar fixture",
            envKey: null,
            category: "feature",
            source: "bundled",
            parameters: [],
            validationErrors: [],
            validationWarnings: [],
          },
        ],
      },
    }),
  );
  let futureMinutes: number | null = null;
  let owner = "First",
    feedState = "complete",
    feedReads = 0,
    sourceReads = 0,
    hold = false;
  let held: import("@playwright/test").Route | undefined;
  const source = {
    provider: "eliza",
    side: "owner",
    grantId: "home-grant",
    connectorAccountId: "home-account",
    calendarId: "primary",
    includeInFeed: true,
    accessRole: "owner",
    summary: "Calendar",
    description: null,
    primary: true,
    timeZone: "UTC",
    selected: true,
    selectionVersion: 0,
    backgroundColor: null,
    foregroundColor: null,
    accountEmail: null,
  };
  let eventOverrides:
    | { title: string; startAt: string; endAt: string }[]
    | undefined;
  let feedBegin: string | undefined;
  const windows: { timeMin: string | null; timeMax: string | null }[] = [];
  const payload = (url: URL, label: string) => {
    const start = new Date(clock);
    if (futureMinutes === null) start.setHours(0, 0, 0, 0);
    else start.setTime(clock.getTime() + futureMinutes * 60000);
    const result = {
      state: feedState,
      source: "cache",
      sources: [],
      timeMin: url.searchParams.get("timeMin"),
      timeMax: url.searchParams.get("timeMax"),
      syncedAt: new Date().toISOString(),
      events: [
        {
          ...source,
          id: "home-event",
          externalId: "home-event",
          agentId: "smoke-agent",
          title: `${label} today`,
          description: "",
          location: "",
          status: "confirmed",
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 3600000).toISOString(),
          isAllDay: false,
          timezone: null,
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: { etag: "v1" },
          updatedAt: start.toISOString(),
        },
      ],
    };
    if (eventOverrides)
      result.events = eventOverrides.map((event, index) => ({
        ...result.events[0],
        ...event,
        id: `period-${index}`,
        externalId: `period-${index}`,
      }));
    if (feedBegin) result.timeMin = feedBegin;
    return result;
  };
  await page.route("**/api/lifeops/calendar/calendars**", (route) => {
    sourceReads++;
    return route.fulfill({ json: { calendars: [source] } });
  });
  await page.route("**/api/lifeops/calendar/feed**", async (route) => {
    feedReads++;
    const url = new URL(route.request().url());
    windows.push({
      timeMin: url.searchParams.get("timeMin"),
      timeMax: url.searchParams.get("timeMax"),
    });
    if (hold) {
      hold = false;
      held = route;
      return;
    }
    await route.fulfill({
      json: payload(new URL(route.request().url()), owner),
    });
  });
  await page.route("**/api/connectors/google/accounts", (route) =>
    route.fulfill({
      json: { accounts: [{ id: "test", status: "connected" }] },
    }),
  );
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-textarea")).toBeEditable();
  const card = page.getByTestId("chat-widget-calendar-upcoming");
  if (process.env.U6_HOME_BASELINE) {
    await expect.poll(() => feedReads).toBeGreaterThan(0);
    await expect(card).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("home-before.png") });
    return;
  }
  await expect(card).toContainText("First today");
  const clientPath = new URL("../../../ui/src/api/client.ts", import.meta.url)
    .pathname;
  const originalToken = await page.evaluate(async (path) => {
    const { client } = await import(path);
    return client.getRestAuthToken();
  }, `/@fs${clientPath}`);
  const initial = { feed: feedReads, sources: sourceReads };
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("home-shared-feed.png") });
  expect({ feed: feedReads, sources: sourceReads }).toEqual(initial);
  expect(windows[0]).toEqual({
    timeMin: "2026-09-28T00:00:00.000Z",
    timeMax: "2026-11-01T00:00:00.000Z",
  });
  const refresh = async () => {
    for (const visibilityState of ["hidden", "visible"])
      await page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, visibilityState);
  };
  const item = (title: string, date: string, hour = 9) => ({
    title,
    startAt: `${date}T${String(hour).padStart(2, "0")}:00:00Z`,
    endAt: `${date}T${String(hour + 1).padStart(2, "0")}:00:00Z`,
  });
  clock = new Date("2026-10-30T12:00:00Z");
  await page.clock.setFixedTime(clock);
  for (const scenario of [
    {
      name: "past-week",
      events: [item("Past week", "2026-10-29")],
      expected: "Past week",
    },
    {
      name: "past-month",
      events: [item("Past month", "2026-10-10")],
      expected: "Past month",
    },
    {
      name: "upcoming-today",
      events: [
        item("Past today", "2026-10-30", 8),
        item("Upcoming today", "2026-10-30", 13),
      ],
      expected: "Upcoming today",
    },
    {
      name: "recent-past",
      events: [
        item("Earlier today", "2026-10-30", 7),
        item("Recent past today", "2026-10-30", 9),
      ],
      expected: "Recent past today",
    },
  ]) {
    eventOverrides = scenario.events;
    await refresh();
    await expect(card).toContainText(scenario.expected);
    await page.screenshot({
      path: info.outputPath(`home-${scenario.name}.png`),
    });
  }
  feedBegin = "2026-10-30T00:00:00Z";
  eventOverrides = [item("Incomplete priority", "2026-10-30", 13)];
  await refresh();
  await expect(card).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("home-incomplete-priority.png"),
  });
  clock = new Date("2026-10-02T12:00:00Z");
  await page.clock.setFixedTime(clock);
  feedBegin = "2026-10-01T00:00:00Z";
  eventOverrides = [];
  await refresh();
  await expect(card).toHaveCount(0);
  feedBegin = undefined;
  eventOverrides = [item("Hidden source", "2026-10-02", 13)];
  source.includeInFeed = false;
  await refresh();
  await expect(card).toHaveCount(0);
  source.includeInFeed = true;
  eventOverrides = undefined;
  await refresh();
  await expect(card).toContainText("First today");
  hold = true;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => !!held).toBe(true);
  owner = "Second";
  await page.evaluate(async (path) => {
    const { client } = await import(path);
    client.setToken("synthetic-owner-two-fixture");
  }, `/@fs${clientPath}`);
  await expect(card).toContainText("Second today");
  const retired = held;
  if (!retired) throw new Error("Held Calendar read was not captured");
  await retired
    .fulfill({ json: payload(new URL(retired.request().url()), "Retired") })
    .catch(() => {});
  await expect(card).toContainText("Second today");
  await expect(card).not.toContainText("Retired");
  feedState = "partial";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(card).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("home-partial-unconfirmed.png"),
  });
  feedState = "complete";
  await page.evaluate(
    async ({ path, token }) => {
      const { client } = await import(path);
      client.setToken(token);
    },
    { path: `/@fs${clientPath}`, token: originalToken },
  );
  await page.goto("/chat?shellMode=tray-popover", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("tray-popover-shell")).toBeVisible();
  await expect(card).toHaveCount(0);
  futureMinutes = 45;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(card).toContainText("Second today");
  await page.screenshot({ path: info.outputPath("tray-near-event.png") });
  await info.attach("request-counts", {
    body: JSON.stringify({
      initial,
      windows,
      total: { feed: feedReads, sources: sourceReads },
    }),
    contentType: "application/json",
  });
});
