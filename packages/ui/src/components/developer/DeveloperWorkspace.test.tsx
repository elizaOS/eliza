// @vitest-environment jsdom
/** Tests canonical chat dispatch and inspector polling with mocked transport. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TrajectoryDetailResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import {
  callLane,
  DeveloperTrace,
  DeveloperWorkspace,
} from "./DeveloperWorkspace";
import { useDeveloperTrajectories } from "./useDeveloperTrajectories";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
}));
const record = {
  id: "run-1",
  agentId: "agent-1",
  entityId: null,
  conversationId: "conversation-1",
  source: "client_chat",
  roomId: "room-1",
  status: "completed",
  updatedAt: "one",
  llmCallCount: 1,
  startTime: 1,
  endTime: 1501,
  providerAccessCount: 0,
  createdAt: "2026-09-09T00:00:00Z",
  durationMs: 1500,
  totalPromptTokens: 100,
  totalCompletionTokens: 20,
  metadata: { messageId: "user-1" },
} satisfies TrajectoryRecord;
const detail = {
  trajectory: record,
  llmCalls: [],
  providerAccesses: [],
} as TrajectoryDetailResult;
const appState = {
  activeConversationId: "conversation-1",
  conversations: [
    { id: "conversation-1", roomId: "room-1", title: "Current chat" },
  ],
  conversationMessages: [],
  chatSending: false,
  chatFirstTokenReceived: false,
  agentStatus: { canRespond: true },
  sendChatText: mocks.send,
  handleChatStop: mocks.stop,
  tab: "notes",
};
vi.mock("../../api/client", () => ({
  client: { getTrajectories: mocks.list, getTrajectoryDetail: mocks.detail },
}));
vi.mock("../../state/ChatComposerContext.hooks", async () => {
  const { useState } = await import("react");
  return {
    useChatComposer: () => {
      const [chatInput, setChatInput] = useState("");
      return { chatSending: appState.chatSending, chatInput, setChatInput };
    },
  };
});
vi.mock("../../state/ConversationMessagesContext.hooks", () => ({
  useConversationMessages: () => ({
    conversationMessages: [
      {
        id: "user-1",
        role: "user",
        text: "Which view is open?",
        timestamp: 1000,
      },
      { id: "reply-1", role: "assistant", text: "You are on Notes." },
    ],
  }),
}));
vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => "local-agent",
}));
vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (select: (state: typeof appState) => unknown) =>
    select(appState),
}));
vi.mock("../RoleGate", () => ({
  RoleGate: ({ children }: { children: ReactNode }) => children,
  OwnerOnlyNotice: () => null,
}));
vi.mock("../chat/MessageContent", () => ({
  MessageContent: ({ message }: { message: { text: string } }) => (
    <p>{message.text}</p>
  ),
}));
vi.mock("../accounts/AddAccountDialog", () => ({
  AddAccountDialog: () => null,
}));
vi.mock("../settings/ModelConfigurationPanel", () => ({
  ModelConfigurationPanel: () => null,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  appState.agentStatus.canRespond = true;
  appState.chatSending = false;
  mocks.list.mockResolvedValue({
    trajectories: [record],
    total: 1,
    offset: 0,
    limit: 50,
  });
  mocks.detail.mockResolvedValue(detail);
  mocks.send.mockResolvedValue(undefined);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("developer workspace", () => {
  it("classifies generic provider calls by their recorded semantic stage", () => {
    const call = { purpose: "external_llm" };
    expect(callLane(call, "client_chat", "evaluation")).toBe(
      "Post-turn evaluation",
    );
    expect(callLane(call, "client_chat", "planner")).toBe("Foreground");
    expect(callLane(call, "background_memory", "evaluation")).toBe(
      "Background memory",
    );
  });
  it("sends through canonical chat without overriding view, authority or conversation", async () => {
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    fireEvent.change(screen.getByLabelText("Message Eliza"), {
      target: { value: "Open Calendar without changing anything" },
    });
    const form = screen.getByRole("button", { name: "Send" }).closest("form");
    if (!form) throw new Error("Composer form missing");
    fireEvent.submit(form);
    await flush();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      "Open Calendar without changing anything",
    );
    expect(screen.getByText("Existing app")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Exit" }).getAttribute("href"),
    ).toBe("/notes");
    expect(screen.getByTestId("developer-reply").textContent).toBe(
      "You are on Notes.",
    );
  });

  it("shows the conversation and tokens, fetching details only after expansion", async () => {
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByText("Which view is open?")).toBeTruthy();
    expect(screen.getByText(/100 tokens in · 20 out/)).toBeTruthy();
    expect(screen.queryByText("Recorded runs")).toBeNull();
    expect(screen.queryByText("Foreground input")).toBeNull();
    expect(mocks.detail).not.toHaveBeenCalled();
    const disclosure = screen.getByText("Details").closest("details");
    if (!disclosure) throw new Error("Missing reply disclosure");
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    await flush();
    expect(mocks.detail).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      expect.objectContaining({ includePayloads: false }),
    );
    expect(screen.getByText("Foreground input")).toBeTruthy();
    expect(screen.queryByLabelText("Full trajectory JSON")).toBeNull();
  });

  it("shows live elapsed time before usage arrives without inventing token counts", async () => {
    appState.chatSending = true;
    mocks.list.mockResolvedValue({ trajectories: [], total: 0 });
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Thinking");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status").textContent).toContain("1.00s");
    expect(screen.getByText(/Waiting for the run/)).toBeTruthy();
    expect(screen.queryByText(/tokens in/)).toBeNull();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("never attaches another room's token counts to a reply", async () => {
    mocks.list.mockResolvedValue({
      trajectories: [{ ...record, roomId: "other-room" }],
      total: 1,
    });
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.queryByText(/tokens in/)).toBeNull();
  });

  it("polls small evidence, caches settled runs, pauses and resumes without discarding inspection", async () => {
    const { result } = renderHook(() =>
      useDeveloperTrajectories("room-1", false),
    );
    await flush();
    expect(mocks.detail).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        includePayloads: false,
        signal: expect.any(AbortSignal),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(4);
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    act(() => result.current.setPaused(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(4);
    expect(result.current.inspection?.record.id).toBe("run-1");
    act(() => result.current.setPaused(false));
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(5);
  });

  it("does not overlap slow reads or accept data after unmount", async () => {
    let resolveList!: (result: unknown) => void;
    mocks.list.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const { unmount } = renderHook(() =>
      useDeveloperTrajectories("room-1", true),
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    const signal = mocks.list.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    resolveList({ trajectories: [record], total: 1 });
    await flush();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("keeps unknown usage and post-turn evaluation distinct from foreground totals", () => {
    const calls = [
      {
        id: "one",
        purpose: "reply",
        model: "qwen",
        promptTokens: 100,
        completionTokens: 0,
      },
      { id: "two", purpose: "reply", model: "qwen" },
      { id: "three", purpose: "evaluation", model: "qwen", promptTokens: 800 },
    ] as TrajectoryDetailResult["llmCalls"];
    render(
      <DeveloperTrace
        record={record}
        detail={{ ...detail, llmCalls: calls }}
      />,
    );
    expect(screen.getByText("100+")).toBeTruthy();
    expect(screen.getByText("Post-turn evaluation")).toBeTruthy();
    expect(screen.queryByText("900")).toBeNull();
  });
  it("shows unknown instead of an invented zero for wholly missing usage", () => {
    render(
      <DeveloperTrace
        record={record}
        detail={{
          ...detail,
          llmCalls: [
            { id: "unknown", purpose: "reply", model: "qwen" },
          ] as TrajectoryDetailResult["llmCalls"],
        }}
      />,
    );
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.queryByText("0+")).toBeNull();
  });
  it("does not label an unavailable agent ready", async () => {
    appState.agentStatus.canRespond = false;
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByText(/Agent unavailable/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
