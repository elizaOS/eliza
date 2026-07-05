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
    // Retained for callers that still touch task APIs; sparse home no longer
    // mounts workflow.running on launch.
    listAutomations: async () => ({ automations: [] }),
    listScheduledTasks: async () => ({ tasks: [] }),
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
