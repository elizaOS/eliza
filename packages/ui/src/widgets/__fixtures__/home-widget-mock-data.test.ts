/**
 * Unit coverage for the home-widget mock fixture: URL-driven mode detection,
 * per-mode payload gating, the fetch-mock route table (any-base matching,
 * quiet bodies, unmatched-route fallback, restore semantics) and the
 * app-store / notification-store seeding the home surface consumes.
 * Real harness: jsdom window, a real fetch swap and the real stores — no
 * module mocks.
 */
// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppSelector } from "../../state/app-store";
import {
  __getStateForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import type { AppContextValue } from "../../state/types";
import {
  HOME_WIDGET_MOCK_NOTIFICATION,
  HOME_WIDGET_MOCK_PLUGINS,
  homeWidgetApprovalsResponse,
  homeWidgetLifeopsTodosResponse,
  homeWidgetMockMode,
  homeWidgetNotificationsResponse,
  homeWidgetTodosResponse,
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "./home-widget-mock-data";

let restoreFetch: () => void = () => {};

function setHomeDataParam(value: string | null): void {
  const search = value === null ? "" : `?homeData=${value}`;
  window.history.replaceState(null, "", `/${search}`);
}

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
  setHomeDataParam(null);
  __resetNotificationStoreForTests();
  cleanup();
});

describe("homeWidgetMockMode", () => {
  it("defaults to attention without a homeData param", () => {
    expect(homeWidgetMockMode()).toBe("attention");
  });

  it("reads ?homeData=quiet as quiet", () => {
    setHomeDataParam("quiet");
    expect(homeWidgetMockMode()).toBe("quiet");
  });

  it("treats any other homeData value as attention", () => {
    setHomeDataParam("loud");
    expect(homeWidgetMockMode()).toBe("attention");
  });

  it("falls back to attention outside a browser (no window)", () => {
    vi.stubGlobal("window", undefined);
    try {
      expect(homeWidgetMockMode()).toBe("attention");
      expect(installHomeWidgetFetchMock()()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("per-mode payloads", () => {
  it("attention mode returns populated payloads with consumer-facing ordering", () => {
    const t0 = Date.now();

    const todos = homeWidgetTodosResponse().todos;
    expect(todos).toHaveLength(1);
    expect(todos[0].isCompleted).toBe(false);

    const lifeops = homeWidgetLifeopsTodosResponse().todos;
    expect(lifeops).toHaveLength(1);
    expect(lifeops[0].status).toBe("pending");
    // dueDate is the current instant so the row renders as due-today on any clock.
    expect(Date.parse(lifeops[0].dueDate)).toBeGreaterThanOrEqual(t0 - 60_000);

    const approvals = homeWidgetApprovalsResponse().pending;
    expect(approvals).toHaveLength(2);
    // Oldest pending decision first — NeedsAttentionWidget surfaces pending[0].
    expect(approvals[0].createdAt).toBeLessThan(approvals[1].createdAt);

    const notifications = homeWidgetNotificationsResponse();
    expect(notifications.notifications).toEqual([
      HOME_WIDGET_MOCK_NOTIFICATION,
    ]);
    expect(notifications.unreadCount).toBe(1);
  });

  it("quiet mode empties every builder instead of throwing", () => {
    setHomeDataParam("quiet");
    expect(homeWidgetTodosResponse()).toEqual({ todos: [] });
    expect(homeWidgetLifeopsTodosResponse()).toEqual({ todos: [] });
    expect(homeWidgetApprovalsResponse()).toEqual({ pending: [] });
    expect(homeWidgetNotificationsResponse()).toEqual({
      notifications: [],
      unreadCount: 0,
    });
  });

  it("mock plugins are all enabled+active so plugin-gated widgets resolve", () => {
    for (const plugin of HOME_WIDGET_MOCK_PLUGINS) {
      expect(plugin.enabled).toBe(true);
      expect(plugin.isActive).toBe(true);
      expect(plugin.configured).toBe(true);
    }
  });
});

describe("installHomeWidgetFetchMock", () => {
  it("restore() puts the original fetch back", () => {
    const original = window.fetch;
    const restore = installHomeWidgetFetchMock();
    restoreFetch = restore;
    expect(window.fetch).not.toBe(original);
    restore();
    restoreFetch = () => {};
    expect(window.fetch).toBe(original);
  });

  it("answers the calendar feed at any base inside the 2h urgent window", async () => {
    restoreFetch = installHomeWidgetFetchMock();
    const t0 = Date.now();
    const res = await window.fetch("/api/base/api/lifeops/calendar/feed");
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      events: { startAt: string; endAt: string }[];
    };
    expect(body.events).toHaveLength(1);
    const start = Date.parse(body.events[0].startAt);
    const end = Date.parse(body.events[0].endAt);
    // Relative times must land in (now, now+2h] so the live ranking floats
    // the timed event up at reminder weight regardless of the CI clock.
    expect(start).toBeGreaterThan(t0);
    expect(start).toBeLessThanOrEqual(t0 + 120 * 60_000);
    expect(end).toBeGreaterThan(start);
  });

  it("serves a goals feed containing an at_risk goal among active ones", async () => {
    restoreFetch = installHomeWidgetFetchMock();
    const res = await window.fetch("/api/lifeops/goals");
    const body = (await res.json()) as {
      goals: { goal: { reviewState: string } }[];
    };
    const states = body.goals.map((g) => g.goal.reviewState);
    expect(states).toContain("at_risk");
    expect(states).toContain("on_track");
  });

  it("resolves unmatched routes to an empty 200 body instead of throwing", async () => {
    restoreFetch = installHomeWidgetFetchMock();
    const res = await window.fetch("/api/unrelated/route");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({});
  });

  it("accepts Request objects via their url", async () => {
    restoreFetch = installHomeWidgetFetchMock();
    const res = await window.fetch(
      new Request("http://localhost/api/notifications"),
    );
    const body = (await res.json()) as { unreadCount: number };
    expect(body.unreadCount).toBe(1);
  });

  it("routes quiet-mode bodies for the gated endpoints", async () => {
    setHomeDataParam("quiet");
    restoreFetch = installHomeWidgetFetchMock();
    expect(await (await window.fetch("/api/approvals")).json()).toEqual({
      pending: [],
    });
    const regularity = (await (
      await window.fetch("/api/lifeops/sleep/regularity")
    ).json()) as { classification: string };
    expect(regularity.classification).toBe("regular");
    const history = (await (
      await window.fetch("/api/lifeops/sleep/history")
    ).json()) as { episodes: unknown[] };
    expect(history.episodes).toEqual([]);
    expect(await (await window.fetch("/api/lifeops/todos")).json()).toEqual({
      todos: [],
    });
  });
});

describe("seeding", () => {
  function readViaSelector<T>(select: (v: AppContextValue) => T): T {
    let captured!: T;
    function Probe() {
      captured = useAppSelector(select);
      return null;
    }
    render(createElement(Probe));
    return captured;
  }

  it("seedHomeWidgetAppStore publishes the plugin snapshot to app-store consumers", () => {
    seedHomeWidgetAppStore();
    const plugins = readViaSelector((v) => v.plugins);
    expect(plugins).toBe(HOME_WIDGET_MOCK_PLUGINS);
  });

  it("the seeded app value degrades unknown fields to inert functions", () => {
    seedHomeWidgetAppStore();
    const value = readViaSelector((v) => v);
    expect(typeof Reflect.get(value, "someUnknownSlice")).toBe("function");
    expect(value.t("missing.key", { defaultValue: "fallback" })).toBe(
      "fallback",
    );
  });

  it("seedHomeWidgetNotifications ingests the urgent unread notification", () => {
    seedHomeWidgetNotifications();
    const state = __getStateForTests();
    expect(state.notifications.map((n) => n.id)).toEqual(["notif-urgent"]);
    expect(state.notifications[0].priority).toBe("urgent");
    expect(state.notifications[0].readAt).toBeNull();
    expect(state.unreadCount).toBe(1);
  });

  it("quiet mode seeds an empty inbox", () => {
    setHomeDataParam("quiet");
    seedHomeWidgetNotifications();
    const state = __getStateForTests();
    expect(state.notifications).toEqual([]);
    expect(state.unreadCount).toBe(0);
  });
});
