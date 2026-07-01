// @vitest-environment jsdom

/**
 * Launch integration (#9304 / #9143): the home `WidgetHost` is what the /chat
 * launch screen mounts (`HomeScreen` → `<WidgetHost slot="home" layout="grid">`),
 * so this drives the REAL host + REAL registry resolution + REAL widget
 * components — not a stub — to prove the home widgets actually render on the
 * first screen when there is data, and that they self-hide (the #9143 clean-home
 * design) when there is none.
 *
 * Notifications are guaranteed on the cold home card. The curated home-grid
 * tiles (recent conversations, agent activity, …) render when their core API
 * surface has data and self-hide when it doesn't. The per-plugin lifeops cards
 * are API-polled and self-hide without a backend, which is the correct
 * fresh-launch behavior.
 */

import type { AgentNotification } from "@elizaos/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api/client-types-chat";

// The home WidgetHost reads `s.plugins` (none active on a cold launch). Empty
// plugins still resolve the always-visible core widgets (notifications).
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
  plugins: [] as Array<{ id: string; enabled: boolean; isActive: boolean }>,
  conversations: [...DEFAULT_CONVERSATIONS],
  t: (k: string) => k,
};

vi.mock("../state", () => ({
  useApp: () => mockState,
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
    listConversations: async () => ({ conversations: mockState.conversations }),
    getConversationMessages: (id: string) => getConversationMessages(id),
  },
}));

import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../state/notifications/notification-store";
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
  __resetNotificationStoreForTests();
  mockState.conversations = [...DEFAULT_CONVERSATIONS];
  getConversationMessages.mockClear();
});
afterEach(() => {
  cleanup();
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

  it("renders the notifications home widget when there is data", async () => {
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

    // Real widgets, resolved by the real registry, rendered into the home host.
    const notifications = screen.getByTestId("widget-notifications");
    expect(notifications.textContent).toContain("PR review requested");
    expect(notifications.textContent).toContain("2");
  });

  it("self-hides every card when there is no data (the #9143 clean home)", () => {
    mockState.conversations = [];
    render(
      <WidgetHost
        slot="home"
        layout="grid"
        events={[]}
        clearEvents={() => {}}
      />,
    );
    expect(screen.queryByTestId("widget-notifications")).toBeNull();
  });
});
