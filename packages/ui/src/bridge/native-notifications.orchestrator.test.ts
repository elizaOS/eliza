// @vitest-environment jsdom
//
// Gap closed: the existing src/state/notifications/notification-store.test.ts
// FULLY mocks `../../bridge/native-notifications`, so it proves the store
// *calls* the bridge but never proves an orchestrator-shaped notification's
// title/body/deepLink actually survive the hop into the platform Capacitor API
// (`LocalNotifications.schedule`). And `native-notifications.ts` itself has ZERO
// direct test coverage. This file exercises the REAL bridge end-to-end: it
// asserts the deep link rides through to `extra.deepLink`, the android channel
// id / numeric id / body-default mapping, the iOS ElizaIntent fallback, the
// graceful no-op path, and the FULL store -> deliver() -> bridge -> Capacitor
// fan-out (the assertion the mocked sibling test structurally cannot make).
//
// A regression that dropped/relocated the deep link, changed the channel id,
// stopped defaulting body to "", or broke the unfocused store fan-out would
// turn one of these red.

import type { AgentNotification } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Capacitor mock (hoisted shared state; mirrors first-run/probe-local-agent.test.ts) ──
const { capacitorState } = vi.hoisted(() => ({
  capacitorState: {
    isNative: true,
    platform: "android" as "android" | "ios" | "web",
    plugins: {} as Record<string, unknown>,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    get Plugins() {
      return capacitorState.plugins;
    },
    getPlatform: () => capacitorState.platform,
    isNativePlatform: () => capacitorState.isNative,
    registerPlugin: vi.fn(),
  },
}));

// Desktop bridge mock so the store's desktop sink is observable and never hits a
// real window RPC. vi.mock resolves the specifier relative to THIS test file and
// keys the mock by the resolved absolute module id; "./electrobun-rpc" from
// src/bridge/ resolves to the same file the store imports as
// "../../bridge/electrobun-rpc", so the store picks up this mock.
const invokeDesktopBridgeRequest = vi.fn();
vi.mock("./electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: (...args: unknown[]) =>
    invokeDesktopBridgeRequest(...args),
}));

// The store also top-level-imports the api client; the __ingest path never
// touches it, but module-eval pulls it in. Stub it minimally so module load is
// inert (no transport graph).
vi.mock("../../api/client", () => ({ client: {} }));

// IMPORTANT: do NOT mock "./native-notifications" — this test drives the REAL bridge.
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  registerNotificationToastSink,
} from "../state/notifications/notification-store";
import {
  hasNativeNotificationChannel,
  showNativeNotification,
} from "./native-notifications";

// ── Fake Capacitor plugins ────────────────────────────────────────────────────
const schedule = vi.fn();
const createChannel = vi.fn();
const checkPermissions = vi.fn();
const requestPermissions = vi.fn();
const receiveIntent = vi.fn();

function freshLocalNotifications(): Record<string, unknown> {
  return {
    schedule,
    createChannel,
    checkPermissions,
    requestPermissions,
  };
}

type ScheduledNotification = {
  id: number;
  title: string;
  body: string;
  channelId?: string;
  extra?: { deepLink?: string };
};

function firstScheduled(): ScheduledNotification {
  const arg = schedule.mock.calls[0]?.[0] as {
    notifications: ScheduledNotification[];
  };
  return arg.notifications[0];
}

function makeOrchestratorNotification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  return {
    id: (overrides.id ?? "orch-1") as AgentNotification["id"],
    title: overrides.title ?? "Coding agent finished",
    body: "body" in overrides ? overrides.body : "PR #42 ready for review",
    category: overrides.category ?? "agent",
    priority: overrides.priority ?? "normal",
    source: overrides.source ?? "orchestrator",
    deepLink: "deepLink" in overrides ? overrides.deepLink : "/orchestrator",
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    readAt: overrides.readAt ?? null,
  };
}

beforeEach(() => {
  __resetNotificationStoreForTests();
  registerNotificationToastSink(null);

  schedule.mockReset().mockResolvedValue(undefined);
  createChannel.mockReset().mockResolvedValue(undefined);
  checkPermissions.mockReset().mockResolvedValue({ display: "granted" });
  requestPermissions.mockReset().mockResolvedValue({ display: "granted" });
  receiveIntent.mockReset().mockResolvedValue({ accepted: true, reason: "ok" });
  invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);

  capacitorState.isNative = true;
  capacitorState.platform = "android";
  capacitorState.plugins = { LocalNotifications: freshLocalNotifications() };

  // Default the window to UNFOCUSED so deliver() fans out to the OS sinks.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("native-notifications bridge — direct (android LocalNotifications)", () => {
  it("schedules a local notification and resolves 'local'", async () => {
    const result = await showNativeNotification({
      id: "orch-1",
      title: "Coding agent finished",
      body: "PR #42 ready for review",
      deepLink: "/orchestrator",
      urgent: false,
    });
    expect(result).toBe("local");
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("preserves the deep link in extra.deepLink, NOT as a top-level field (core regression)", async () => {
    await showNativeNotification({
      id: "orch-1",
      title: "Coding agent finished",
      deepLink: "/orchestrator",
    });
    const notif = firstScheduled();
    expect(notif.extra?.deepLink).toBe("/orchestrator");
    // The deep link must ride inside `extra`, never as a top-level Capacitor field.
    expect(notif).not.toHaveProperty("deepLink");
  });

  it("maps title and body onto the scheduled notification", async () => {
    await showNativeNotification({
      id: "orch-1",
      title: "Coding agent finished",
      body: "PR #42 ready for review",
      deepLink: "/orchestrator",
    });
    const notif = firstScheduled();
    expect(notif.title).toBe("Coding agent finished");
    expect(notif.body).toBe("PR #42 ready for review");
  });

  it("uses the eliza_notifications android channel id", async () => {
    await showNativeNotification({ id: "orch-1", title: "x" });
    expect(firstScheduled().channelId).toBe("eliza_notifications");
  });

  it("derives a stable positive numeric id that is identical for the same string id", async () => {
    await showNativeNotification({ id: "orch-stable", title: "first" });
    const idA = firstScheduled().id;
    expect(Number.isInteger(idA)).toBe(true);
    expect(idA).toBeGreaterThan(0);
    expect(idA).toBeLessThan(2_000_000_000);

    schedule.mockClear();
    await showNativeNotification({ id: "orch-stable", title: "second" });
    const idB = firstScheduled().id;
    expect(idB).toBe(idA); // determinism / dedupe identity
  });

  it("omits the extra key entirely when there is no deep link", async () => {
    await showNativeNotification({ id: "orch-1", title: "no link" });
    expect(firstScheduled()).not.toHaveProperty("extra");
  });

  it("defaults a missing body to an empty string (not undefined)", async () => {
    await showNativeNotification({ id: "orch-1", title: "only title" });
    expect(firstScheduled().body).toBe("");
  });
});

describe("native-notifications bridge — iOS ElizaIntent fallback", () => {
  it("routes through ElizaIntent with deepLinkOnTap when LocalNotifications is absent", async () => {
    capacitorState.platform = "ios";
    capacitorState.plugins = { ElizaIntent: { receiveIntent } };

    const result = await showNativeNotification({
      id: "orch-ios",
      title: "Coding agent finished",
      body: "PR #42 ready for review",
      deepLink: "/orchestrator",
    });

    expect(result).toBe("intent");
    expect(receiveIntent).toHaveBeenCalledTimes(1);
    const arg = receiveIntent.mock.calls[0][0] as {
      kind: string;
      payload: Record<string, unknown>;
    };
    expect(arg.kind).toBe("reminder");
    expect(arg.payload.deepLinkOnTap).toBe("/orchestrator");
  });
});

describe("native-notifications bridge — graceful degradation", () => {
  it("resolves 'none' and never throws when no native plugin and no web Notification", async () => {
    capacitorState.plugins = {};
    vi.stubGlobal("Notification", undefined);

    let result: string | undefined;
    await expect(
      (async () => {
        result = await showNativeNotification({ id: "orch-1", title: "x" });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBe("none");

    vi.unstubAllGlobals();
  });
});

describe("native-notifications bridge — hasNativeNotificationChannel", () => {
  it("is true on android when LocalNotifications.schedule exists", () => {
    capacitorState.platform = "android";
    capacitorState.plugins = { LocalNotifications: freshLocalNotifications() };
    expect(hasNativeNotificationChannel()).toBe(true);
  });

  it("is false when the platform is not native", () => {
    capacitorState.isNative = false;
    expect(hasNativeNotificationChannel()).toBe(false);
  });
});

describe("notification-store fan-out -> REAL native bridge (orchestrator)", () => {
  // deliver() is fire-and-forget (`void showNativeNotification(...).catch`), and
  // the schedule() call lands several microtasks later
  // (showNativeNotification -> tryLocalNotifications -> checkPermissions -> schedule).
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("fires BOTH the desktop sink and the real native schedule when the window is unfocused", async () => {
    __ingestNotificationForTests(makeOrchestratorNotification(), 1);
    await flushMicrotasks();

    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("passes desktop params (title/body/urgency/silent) without a deepLink", async () => {
    __ingestNotificationForTests(makeOrchestratorNotification(), 1);
    await flushMicrotasks();

    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith({
      rpcMethod: "desktopShowNotification",
      ipcChannel: "desktop:showNotification",
      params: expect.objectContaining({
        title: "Coding agent finished",
        body: "PR #42 ready for review",
        urgency: "normal",
        silent: false,
      }),
    });
    // The store intentionally omits the deep link from the desktop sink params.
    const params = invokeDesktopBridgeRequest.mock.calls[0][0].params as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty("deepLink");
  });

  it("carries the orchestrator deep link all the way into the native extra.deepLink", async () => {
    __ingestNotificationForTests(makeOrchestratorNotification(), 1);
    await flushMicrotasks();

    // This is the assertion the fully-mocked sibling test cannot make:
    // store -> deliver -> showNativeNotification -> Capacitor schedule.
    expect(firstScheduled().extra?.deepLink).toBe("/orchestrator");
  });
});
