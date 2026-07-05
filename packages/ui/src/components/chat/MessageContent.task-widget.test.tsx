// @vitest-environment jsdom
//
// Integration test: an assistant message containing `[TASK:<id>]<title>[/TASK]`
// renders as a clickable, stream-driven TaskWidget via the MessageContent
// segment pipeline (parser → dispatch → component). Complements
// `message-task-parser.test.ts` (pure parser) and `widgets/task-widget.test.tsx`
// (component in isolation) by locking in the wire-up between them.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import type { CodingAgentTaskThreadDetail } from "../../api/client-types-cloud";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

const { clientMock, getTaskMock } = vi.hoisted(() => ({
  clientMock: {
    getCodingAgentTaskThread: vi.fn(),
    updateSecrets: vi.fn(),
    getPermission: vi.fn(),
    requestPermission: vi.fn(),
    openPermissionSettings: vi.fn(),
    // The live pipeline store subscribes to the WS feed on mount; a no-op
    // unsubscribe is enough here (stream behavior is covered by
    // task-activity-store.test.ts).
    onWsEvent: () => () => undefined,
  },
  getTaskMock: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../../api/client", () => ({
  client: clientMock,
}));

import { MessageContent } from "./MessageContent";
// The task widget is owned by the orchestrator plugin, not auto-registered in
// ui — register it here so MessageContent's generic dispatch can render it.
import { registerTaskWidget } from "./widgets/task-widget";

const THREAD_ID = "0123abcd-1234-5678-9abc-deadbeefcafe";

function detail(
  overrides: Partial<CodingAgentTaskThreadDetail> = {},
): CodingAgentTaskThreadDetail {
  return {
    id: THREAD_ID,
    title: "Real title",
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    originalRequest: "",
    summary: null,
    goal: "",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: Date.now() - 1000,
    decisionCount: 0,
    acceptanceCriteria: [],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "unavailable",
      usageState: "unavailable",
      byProvider: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    archivedAt: null,
    ...overrides,
  } as CodingAgentTaskThreadDetail;
}

function messageWithTaskBlock(prose: string): ConversationMessage {
  return {
    id: "message-1",
    role: "assistant",
    text: `${prose}\n\n[TASK:${THREAD_ID}]Optimistic title[/TASK]\n\nThanks!`,
    timestamp: Date.now(),
  } as ConversationMessage;
}

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  // MessageContent reads context via the selector store, so seed it too.
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

describe("MessageContent → TaskWidget integration", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  beforeEach(() => {
    registerTaskWidget();
    getTaskMock.mockReset();
    clientMock.getCodingAgentTaskThread.mockImplementation(getTaskMock);
  });

  it("renders the surrounding prose as text and the block as a TaskWidget", async () => {
    getTaskMock.mockResolvedValueOnce(detail());
    withApp(
      <MessageContent
        message={messageWithTaskBlock("Created the task you asked for.")}
      />,
    );

    expect(screen.getByText("Created the task you asked for.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("task-widget").textContent).toContain(
        "Real title",
      );
    });
    expect(screen.getByTestId("task-widget").getAttribute("data-task-id")).toBe(
      THREAD_ID,
    );
    expect(screen.getByText("Thanks!")).toBeTruthy();
  });

  it("uses the fallback title from the block before the fetch resolves", () => {
    getTaskMock.mockReturnValue(new Promise(() => undefined));
    withApp(<MessageContent message={messageWithTaskBlock("Created.")} />);
    expect(screen.getByTestId("task-widget").textContent).toContain(
      "Optimistic title",
    );
  });

  it("expands on header click and navigates via the workbench link", async () => {
    getTaskMock.mockResolvedValueOnce(detail());
    const events: CustomEvent[] = [];
    const handler = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener("eliza:navigate:view", handler);

    withApp(<MessageContent message={messageWithTaskBlock("Created.")} />);
    await waitFor(() => {
      expect(screen.getByTestId("task-widget").textContent).toContain(
        "Real title",
      );
    });

    // The header expands the inline pipeline in place; it does not navigate.
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(
      screen.getByTestId("task-widget").getAttribute("data-expanded"),
    ).toBe("true");
    expect(events).toHaveLength(0);

    // Navigation is the explicit workbench affordance.
    fireEvent.click(screen.getByText("Open in workbench →"));
    expect(events[0]?.detail).toEqual({
      viewPath: `/orchestrator?taskId=${THREAD_ID}`,
    });
    window.removeEventListener("eliza:navigate:view", handler);
  });

  it("leaves the original block text out of the rendered prose", async () => {
    getTaskMock.mockResolvedValueOnce(detail());
    const { container } = withApp(
      <MessageContent message={messageWithTaskBlock("Created.")} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("task-widget").textContent).toContain(
        "Real title",
      );
    });
    expect(container.textContent?.includes(`[TASK:${THREAD_ID}]`)).toBe(false);
    expect(container.textContent?.includes("[/TASK]")).toBe(false);
  });
});
