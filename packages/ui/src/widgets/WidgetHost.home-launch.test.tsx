/** Verifies home WidgetHost on launch (#9304 / #9143) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Launch integration (#9304 / #9143): the home `WidgetHost` is what the /chat
 * launch screen mounts (`HomeScreen` → `<WidgetHost slot="home" layout="grid">`),
 * so this drives the REAL host + REAL registry resolution + REAL widget
 * components — not a stub. Sparse home keeps activity/app-run/domain widgets out
 * of the launch host; retained cards self-hide without a backend, which is the
 * correct fresh-launch behavior.
 *
 * Notifications are NOT a host widget: HomeScreen pins NotificationsHomeCenter
 * as a sibling of the host, so the host rendering nothing notification-shaped —
 * even with a populated store — is itself a contract (double-render guard).
 */

import type { AgentNotification } from "@elizaos/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api/client-types-chat";
import type { PluginWidgetDeclaration } from "./types";

// The home WidgetHost reads `s.plugins` (none active on a cold launch). Empty
// plugins still resolve the always-visible core widgets.
const DEFAULT_CONVERSATIONS = [
  {
    id: "c1",
    title: "Trip planning",
    roomId: "r1",
    createdAt: "x",
    updatedAt: "2026-06-24T08:00:00.000Z",
  },
  {
    id: "c2",
    title: "Budget review",
    roomId: "r2",
    createdAt: "x",
    updatedAt: "2026-06-24T07:00:00.000Z",
  },
];

const mockState = {
  tab: "chat",
  plugins: [] as Array<{
    id: string;
    enabled: boolean;
    isActive: boolean;
    widgets?: PluginWidgetDeclaration[];
  }>,
  conversations: [...DEFAULT_CONVERSATIONS],
  t: (k: string) => k,
};

vi.mock("../hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({ events: [], clearEvents: () => {} }),
}));
vi.mock("../hooks/useWeather", () => ({
  prefers24HourClock: () => true,
  useWeather: () => ({
    status: "ready",
    temp: 68,
    unit: "°F",
    condition: "Mostly clear",
    kind: "clear",
    approximate: false,
  }),
}));

vi.mock("../state/useApp", () => ({ useApp: () => mockState }));
vi.mock("../state/app-store", () => ({
  useAppSelector: <T,>(sel: (s: typeof mockState) => T): T => sel(mockState),
  useAppSelectorShallow: <T,>(sel: (s: typeof mockState) => T): T =>
    sel(mockState),
}));

// Default (non-developer) launch toggles — home widgets are visible here.
vi.mock("../state/useViewKinds", () => ({
  useEnabledViewKinds: () => ({ developer: false, preview: false }),
}));

function exchange(): ConversationMessage[] {
  return [
    { id: "u1", role: "user", text: "Can you help?", timestamp: 1 },
    { id: "a1", role: "assistant", text: "Yes.", timestamp: 2 },
  ];
}

const getConversationMessages = vi.fn<
  (id: string) => Promise<{ messages: ConversationMessage[] }>
>(async () => ({ messages: exchange() }));

vi.mock("../api/client", () => ({
  client: {
    getBaseUrl: () => "http://localhost:3000",
    getAuthorityRevision: () => 0,
    getRestAuthToken: () => null,
    onAuthorityChange: () => () => {},
    listConversations: async () => ({ conversations: mockState.conversations }),
    getConversationMessages: (id: string) => getConversationMessages(id),
    // Retained for callers that still touch task APIs; sparse home no longer
    // mounts workflow.running on launch.
    listAutomations: async () => ({ automations: [] }),
    listScheduledTasks: async () => ({ tasks: [] }),
  },
}));

import { HomeScreen } from "../components/shell/HomeScreen";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  __setHydratedForTests,
} from "../state/notifications/notification-store";
import { resolveWidgetsForSlot } from "./registry";
import { WidgetHost } from "./WidgetHost";

function notification(id: string, title: string): AgentNotification {
  return {
    id: id as AgentNotification["id"],
    title,
    body: "tap to review",
    category: "reminder",
    priority: "normal",
    source: "lifeops",
    createdAt: Date.UTC(2026, 5, 24, 8, 0, 0),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({})),
  );
  mockState.plugins = [];
  __resetNotificationStoreForTests();
  mockState.conversations = [...DEFAULT_CONVERSATIONS];
  getConversationMessages.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetNotificationStoreForTests();
});

describe("home WidgetHost on launch (#9304 / #9143)", () => {
  it("mounts the host for the home slot", () => {
    render(
      <WidgetHost
        slot="home"
        layout="grid"
        events={[]}
        clearEvents={() => {}}
      />,
    );
    const host = screen.getByTestId("widget-host-home");
    expect(host.getAttribute("data-slot")).toBe("home");
    expect(host.getAttribute("data-layout")).toBe("grid");
  });

  it("renders NO notifications card even with a populated store (pinned-center double-render guard)", () => {
    __ingestNotificationForTests(notification("n1", "Standup at 10"), 1);
    __ingestNotificationForTests(notification("n2", "PR review requested"), 2);

    render(
      <WidgetHost
        slot="home"
        layout="grid"
        events={[]}
        clearEvents={() => {}}
      />,
    );

    // The real registry resolves nothing notification-shaped for the home slot;
    // the seeded store content must not leak into the host under ANY test id.
    const host = screen.getByTestId("widget-host-home");
    expect(screen.queryByTestId("widget-notifications")).toBeNull();
    expect(host.textContent).not.toContain("Standup at 10");
    expect(host.textContent).not.toContain("PR review requested");
  });
});

it.each(["todo", "todos"])(
  "keeps real Home notifications without restoring retired Today declarations from %s",
  (pluginId) => {
    const stale: PluginWidgetDeclaration = {
      id: "todo.items",
      pluginId,
      slot: "home" as const,
      label: "Today",
      defaultEnabled: true,
      uiSpec: {
        root: "root",
        state: {},
        elements: {
          root: {
            type: "Text",
            props: { text: "Retired Today" },
            children: [],
          },
        },
      },
    };
    const plugins = [{ id: pluginId, enabled: true, isActive: true }];
    const home = resolveWidgetsForSlot("home", plugins, [stale]);
    expect(
      home.some(({ declaration }) => declaration.id === "todo.items"),
    ).toBe(false);
    expect(
      home.some(({ declaration }) => declaration.id === "calendar.upcoming"),
    ).toBe(true);
    expect(
      resolveWidgetsForSlot("chat-sidebar", plugins, [
        { ...stale, slot: "chat-sidebar" },
      ]).some(({ declaration }) => declaration.id === "todo.items"),
    ).toBe(true);
    mockState.plugins = [{ ...plugins[0], widgets: [stale] }];
    __setHydratedForTests(true);
    __ingestNotificationForTests(
      {
        ...notification(
          "11111111-1111-4111-8111-111111111111",
          "Keep this reminder",
        ),
        priority: "high",
        createdAt: Date.now(),
      },
      1,
    );
    render(<HomeScreen onOpenTile={() => {}} />);
    expect(screen.getByText("Keep this reminder")).toBeTruthy();
    expect(screen.getByText("Mostly clear")).toBeTruthy();
    expect(screen.getByTestId("home-time-widget")).toBeTruthy();
    expect(screen.queryByTestId("today-todo-row")).toBeNull();
    expect(screen.queryByTestId("todo-goal-attention-row")).toBeNull();
  },
);
