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
import { DeveloperTrace, DeveloperWorkspace } from "./DeveloperWorkspace";
import { useDeveloperTrajectories } from "./useDeveloperTrajectories";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
}));
const record = {
  id: "run-1",
  source: "client_chat",
  roomId: "room-1",
  status: "completed",
  updatedAt: "one",
  llmCallCount: 1,
  startTime: 1,
  durationMs: 1500,
  metadata: {},
} as TrajectoryRecord;
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
vi.mock("../../state/ChatComposerContext.hooks", () => ({
  useChatComposer: () => ({ chatSending: false }),
}));
vi.mock("../../state/ConversationMessagesContext.hooks", () => ({
  useConversationMessages: () => ({
    conversationMessages: [
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
vi.mock("../accounts/AddAccountDialog", () => ({
  AddAccountDialog: () => null,
}));
vi.mock("../settings/ModelConfigurationPanel", () => ({
  ModelConfigurationPanel: () => null,
}));

beforeEach(() => {
  vi.useFakeTimers();
  appState.agentStatus.canRespond = true;
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
  it("sends through canonical chat without overriding view, authority or conversation", async () => {
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    fireEvent.change(screen.getByLabelText(/Prompt Eliza/), {
      target: { value: "Open Calendar without changing anything" },
    });
    const form = screen
      .getByRole("button", { name: "Send to Eliza" })
      .closest("form");
    if (!form) throw new Error("Composer form missing");
    fireEvent.submit(form);
    await flush();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      "Open Calendar without changing anything",
    );
    expect(screen.getByText("Existing app")).toBeTruthy();
    expect(screen.getByTestId("developer-reply").textContent).toBe(
      "You are on Notes.",
    );
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
      screen
        .getByRole("button", { name: "Send to Eliza" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
