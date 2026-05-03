// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentConnectorStatus,
  clientMock,
  connectorRefreshMock,
  ownerConnectorStatus,
  reactJsxDevRuntimePath,
  reactJsxRuntimePath,
  reactModulePath,
  setActionNoticeMock,
  tMock,
} = vi.hoisted(() => {
  const cwd = process.cwd();
  const workspaceRoot = cwd.endsWith("/eliza") ? cwd.slice(0, -6) : cwd;
  const reactRoot = `${workspaceRoot}/node_modules/react`;
  const ownerConnectorStatus = {
    connected: true,
    defaultMode: "local",
    grant: null,
    grantedCapabilities: [
      "google.calendar.read",
      "google.gmail.triage",
      "google.gmail.send",
      "google.gmail.manage",
    ],
    grantedScopes: [],
    hasCredentials: true,
    identity: {
      email: "owner@example.test",
      name: "Owner",
    },
    mode: "local",
    provider: "google",
    reason: null,
    side: "owner",
  };
  const agentConnectorStatus = {
    connected: true,
    defaultMode: "local",
    grant: null,
    grantedCapabilities: ["google.calendar.read"],
    grantedScopes: [],
    hasCredentials: true,
    identity: {
      email: "agent@example.test",
      name: "Agent",
    },
    mode: "local",
    provider: "google",
    reason: null,
    side: "agent",
  };
  return {
    agentConnectorStatus,
    clientMock: {
      getLifeOpsCalendarFeed: vi.fn(),
      getLifeOpsGmailTriage: vi.fn(),
      getLifeOpsGmailSearch: vi.fn(),
      getLifeOpsGmailNeedsResponse: vi.fn(),
      getLifeOpsGmailRecommendations: vi.fn(),
      createLifeOpsGmailReplyDraft: vi.fn(),
      sendLifeOpsGmailReply: vi.fn(),
      manageLifeOpsGmailMessages: vi.fn(),
    },
    connectorRefreshMock: vi.fn(),
    reactJsxDevRuntimePath: `${reactRoot}/jsx-dev-runtime.js`,
    reactJsxRuntimePath: `${reactRoot}/jsx-runtime.js`,
    reactModulePath: `${reactRoot}/index.js`,
    ownerConnectorStatus,
    setActionNoticeMock: vi.fn(),
    tMock: vi.fn(
      (
        key: string,
        options?: Record<string, unknown> & { defaultValue?: string },
      ) => options?.defaultValue ?? key,
    ),
  };
});

vi.mock("react", () => require(reactModulePath));
vi.mock("react/jsx-runtime", () => require(reactJsxRuntimePath));
vi.mock("react/jsx-dev-runtime", () => require(reactJsxDevRuntimePath));

type SegmentedItem<T extends string> = {
  value: T;
  label: ReactNode;
};

vi.mock("@elizaos/app-core", () => {
  const React = require(reactModulePath) as typeof import("react");
  return {
    Badge: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    Button: "button",
    client: clientMock,
    Input: "input",
    SegmentedControl: <T extends string>({
      "aria-label": ariaLabel,
      items,
      onValueChange,
      value,
    }: {
      "aria-label"?: string;
      items: SegmentedItem<T>[];
      onValueChange: (value: T) => void;
      value: T;
    }) =>
      React.createElement(
        "div",
        { role: "group", "aria-label": ariaLabel },
        items.map((item) =>
          React.createElement(
            "button",
            {
              key: item.value,
              type: "button",
              "aria-pressed": item.value === value,
              onClick: () => onValueChange(item.value),
            },
            item.label,
          ),
        ),
      ),
    Textarea: "textarea",
    useApp: () => ({
      setActionNotice: setActionNoticeMock,
      t: tMock,
    }),
  };
});

vi.mock("../hooks/useGoogleLifeOpsConnector.js", () => ({
  useGoogleLifeOpsConnector: ({ side }: { side?: "owner" | "agent" }) => ({
    refresh: connectorRefreshMock,
    status: side === "agent" ? agentConnectorStatus : ownerConnectorStatus,
  }),
}));

import { LifeOpsWorkspaceView } from "./LifeOpsWorkspaceView";

const React = require(reactModulePath) as typeof import("react");

function gmailMessage(
  overrides: Partial<{
    id: string;
    subject: string;
    from: string;
    snippet: string;
    labels: string[];
    isUnread: boolean;
    likelyReplyNeeded: boolean;
  }> = {},
) {
  const id = overrides.id ?? "msg-1";
  return {
    accountEmail: "owner@example.test",
    agentId: "agent-1",
    cc: [],
    externalId: `ext-${id}`,
    from: overrides.from ?? "Sarah <sarah@example.test>",
    fromEmail: "sarah@example.test",
    htmlLink: null,
    id,
    isImportant: false,
    isUnread: overrides.isUnread ?? true,
    labels: overrides.labels ?? ["INBOX", "UNREAD"],
    likelyReplyNeeded: overrides.likelyReplyNeeded ?? true,
    metadata: {},
    provider: "google" as const,
    receivedAt: "2026-04-22T12:00:00.000Z",
    replyTo: null,
    side: "owner" as const,
    snippet: overrides.snippet ?? "Can you review this?",
    subject: overrides.subject ?? "Need reply",
    syncedAt: "2026-04-22T12:01:00.000Z",
    threadId: `thread-${id}`,
    to: ["owner@example.test"],
    triageReason: "Direct request",
    triageScore: 0.9,
    updatedAt: "2026-04-22T12:01:00.000Z",
  };
}

function renderWorkspace(): void {
  render(React.createElement(LifeOpsWorkspaceView));
}

beforeEach(() => {
  connectorRefreshMock.mockResolvedValue(undefined);
  clientMock.getLifeOpsCalendarFeed.mockResolvedValue({
    events: [],
    source: "synced",
    syncedAt: "2026-04-22T12:00:00.000Z",
  });
  clientMock.getLifeOpsGmailTriage.mockResolvedValue({
    messages: [
      gmailMessage(),
      gmailMessage({
        id: "msg-2",
        isUnread: false,
        likelyReplyNeeded: false,
        subject: "Newsletter",
      }),
    ],
    source: "synced",
    summary: {
      importantNewCount: 0,
      likelyReplyNeededCount: 1,
      unreadCount: 1,
    },
    syncedAt: "2026-04-22T12:00:00.000Z",
  });
  clientMock.getLifeOpsGmailSearch.mockResolvedValue({
    messages: [
      gmailMessage({
        id: "spam-1",
        labels: ["SPAM"],
        likelyReplyNeeded: false,
        subject: "DHL payment required",
      }),
    ],
    query: "in:spam",
    source: "synced",
    summary: {
      importantCount: 0,
      replyNeededCount: 0,
      totalCount: 1,
      unreadCount: 1,
    },
    syncedAt: "2026-04-22T12:00:00.000Z",
  });
  clientMock.getLifeOpsGmailNeedsResponse.mockResolvedValue({
    messages: [gmailMessage()],
    source: "synced",
    summary: {
      importantCount: 0,
      totalCount: 1,
      unreadCount: 1,
    },
    syncedAt: "2026-04-22T12:00:00.000Z",
  });
  clientMock.getLifeOpsGmailRecommendations.mockResolvedValue({
    recommendations: [
      {
        affectedCount: 2,
        confidence: 0.78,
        destructive: false,
        id: "gmail-archive-low-value",
        kind: "archive",
        labelIds: [],
        messageIds: ["msg-2", "msg-3"],
        operation: "archive",
        query: null,
        rationale: "Low-value automated mail.",
        requiresConfirmation: true,
        sampleMessages: [
          {
            from: "Newsletter <news@example.test>",
            fromEmail: "news@example.test",
            labels: ["INBOX"],
            messageId: "msg-2",
            receivedAt: "2026-04-22T12:00:00.000Z",
            snippet: "Digest",
            subject: "Newsletter",
          },
        ],
        title: "Archive low-value automated mail",
      },
      {
        affectedCount: 1,
        confidence: 0.9,
        destructive: false,
        id: "gmail-review-spam",
        kind: "review_spam",
        labelIds: [],
        messageIds: ["spam-1"],
        operation: null,
        query: null,
        rationale: "Already in Gmail spam.",
        requiresConfirmation: false,
        sampleMessages: [
          {
            from: "DHL <dhl@example.test>",
            fromEmail: "dhl@example.test",
            labels: ["SPAM"],
            messageId: "spam-1",
            receivedAt: "2026-04-22T12:00:00.000Z",
            snippet: "Pay now",
            subject: "DHL payment required",
          },
        ],
        title: "Review spam folder candidates",
      },
    ],
    source: "synced",
    summary: {
      archiveCount: 1,
      destructiveCount: 0,
      markReadCount: 0,
      replyCount: 0,
      spamReviewCount: 1,
      totalCount: 2,
    },
    syncedAt: "2026-04-22T12:00:00.000Z",
  });
  clientMock.createLifeOpsGmailReplyDraft.mockResolvedValue({
    draft: {
      bodyText: "Sounds good. I will review it tomorrow.",
      cc: [],
      messageId: "msg-1",
      previewLines: ["Sounds good."],
      requiresConfirmation: false,
      sendAllowed: true,
      subject: "Re: Need reply",
      threadId: "thread-msg-1",
      to: ["sarah@example.test"],
    },
  });
  clientMock.sendLifeOpsGmailReply.mockResolvedValue({ ok: true });
  clientMock.manageLifeOpsGmailMessages.mockImplementation(async (request) => ({
    accountEmail: "owner@example.test",
    affectedCount: request.messageIds.length,
    destructive:
      request.operation === "trash" || request.operation === "report_spam",
    grantId: "grant-1",
    labelIds: request.labelIds ?? [],
    messageIds: request.messageIds,
    ok: true,
    operation: request.operation,
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsWorkspaceView Gmail release controls", () => {
  it("invokes Gmail refresh, search filters, needs-response, and recommendations", async () => {
    renderWorkspace();

    await waitFor(() =>
      expect(screen.getAllByText("Need reply").length).toBeGreaterThan(0),
    );

    fireEvent.change(screen.getByLabelText("Gmail search query"), {
      target: { value: "in:spam" },
    });
    fireEvent.click(screen.getByLabelText("Reply-needed only"));
    fireEvent.click(screen.getByLabelText("Include spam/trash"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Search Gmail" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Search Gmail" }));

    await waitFor(() =>
      expect(clientMock.getLifeOpsGmailSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          includeSpamTrash: true,
          query: "in:spam",
          replyNeededOnly: true,
        }),
      ),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Needs response" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Needs response" }));
    await waitFor(() =>
      expect(clientMock.getLifeOpsGmailNeedsResponse).toHaveBeenCalled(),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Recommendations" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recommendations" }));
    await screen.findByText("Review spam folder candidates");
    expect(clientMock.getLifeOpsGmailRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({
        includeSpamTrash: true,
        query: "in:spam",
        replyNeededOnly: true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh inbox" }));
    await waitFor(() => expect(connectorRefreshMock).toHaveBeenCalled());
  });

  it("requires explicit confirmation before sending a generated Gmail reply", async () => {
    renderWorkspace();

    await waitFor(() =>
      expect(screen.getAllByText("Need reply").length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft reply" }));

    await waitFor(() =>
      expect(clientMock.createLifeOpsGmailReplyDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          includeQuotedOriginal: true,
          messageId: "msg-1",
          tone: "neutral",
        }),
      ),
    );
    expect(
      screen.getByText(
        "Draft created. It will not send until you confirm and press Send.",
      ),
    ).toBeTruthy();

    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByLabelText("Confirm sending this Gmail reply now"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(clientMock.sendLifeOpsGmailReply).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyText: "Sounds good. I will review it tomorrow.",
          confirmSend: true,
          messageId: "msg-1",
        }),
      ),
    );
  });

  it("invokes Gmail manage operations with label and destructive confirmation paths", async () => {
    renderWorkspace();

    await waitFor(() =>
      expect(screen.getAllByText("Need reply").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmDestructive: false,
          messageIds: ["msg-1"],
          operation: "archive",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "mark_unread",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "mark_read",
        }),
      ),
    );

    fireEvent.change(screen.getByLabelText("Label ID(s), comma-separated"), {
      target: { value: "Label_123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply label" }));
    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          labelIds: ["Label_123"],
          operation: "apply_label",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove label" }));
    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          labelIds: ["Label_123"],
          operation: "remove_label",
        }),
      ),
    );

    expect(screen.getByRole("button", { name: "Report spam" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByLabelText("Confirm bulk/destructive update"));
    fireEvent.click(screen.getByRole("button", { name: "Report spam" }));
    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmDestructive: true,
          operation: "report_spam",
        }),
      ),
    );

    fireEvent.click(screen.getByLabelText("Confirm bulk/destructive update"));
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmDestructive: true,
          operation: "trash",
        }),
      ),
    );
  });

  it("surfaces spam recommendation candidates as reportable review items", async () => {
    renderWorkspace();

    await waitFor(() =>
      expect(screen.getAllByText("Need reply").length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Recommendations" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recommendations" }));
    await screen.findByText("DHL payment required");

    const reportSampleButton = screen.getByRole("button", {
      name: "Report sample spam",
    });
    expect(reportSampleButton).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByLabelText("Confirm recommendation update"));
    fireEvent.click(reportSampleButton);

    await waitFor(() =>
      expect(clientMock.manageLifeOpsGmailMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmDestructive: true,
          messageIds: ["spam-1"],
          operation: "report_spam",
        }),
      ),
    );
  });
});
