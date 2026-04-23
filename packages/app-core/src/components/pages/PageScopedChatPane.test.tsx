// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type VoiceHookOptions = {
  onTranscript: (text: string) => void;
  onTranscriptPreview?: (text: string) => void;
};

const {
  clientMock,
  startListeningMock,
  stopListeningMock,
  useAppMock,
  useVoiceChatMock,
  voiceOptionsRef,
  voiceState,
} = vi.hoisted(() => {
  const startListening = vi.fn();
  const stopListening = vi.fn();
  const voiceOptions: { current: VoiceHookOptions | null } = { current: null };
  return {
    clientMock: {
      createConversation: vi.fn(),
      deleteConversation: vi.fn(),
      getConversationMessages: vi.fn(),
      listConversations: vi.fn(),
      sendConversationMessageStream: vi.fn(),
      updateConversation: vi.fn(),
    },
    startListeningMock: startListening,
    stopListeningMock: stopListening,
    useAppMock: vi.fn(),
    useVoiceChatMock: vi.fn(),
    voiceOptionsRef: voiceOptions,
    voiceState: {
      assistantTtsQuality: "standard" as const,
      captureMode: "idle" as const,
      interimTranscript: "",
      isListening: false,
      isSpeaking: false,
      startListening,
      stopListening,
      supported: true,
      toggleListening: vi.fn(),
    },
  };
});

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../hooks/useVoiceChat", () => ({
  useVoiceChat: (options: VoiceHookOptions) => {
    voiceOptionsRef.current = options;
    return useVoiceChatMock(options);
  },
}));

import { PageScopedChatPane } from "./PageScopedChatPane";

const conversation = {
  createdAt: "2026-04-22T00:00:00.000Z",
  id: "apps-page-chat",
  metadata: { scope: "page-apps" },
  roomId: "room-apps",
  title: "Apps assistant",
  updatedAt: "2026-04-22T00:00:00.000Z",
};

describe("PageScopedChatPane", () => {
  beforeEach(() => {
    clientMock.createConversation.mockReset();
    clientMock.deleteConversation.mockReset();
    clientMock.getConversationMessages.mockReset();
    clientMock.listConversations.mockReset();
    clientMock.sendConversationMessageStream.mockReset();
    clientMock.updateConversation.mockReset();
    startListeningMock.mockReset();
    stopListeningMock.mockReset();
    useAppMock.mockReset();
    useVoiceChatMock.mockReset();
    voiceOptionsRef.current = null;
    voiceState.isListening = false;
    voiceState.interimTranscript = "";

    useAppMock.mockReturnValue({
      activeConversationId: null,
      conversations: [],
      elizaCloudConnected: false,
      elizaCloudVoiceProxyAvailable: false,
      uiLanguage: "en",
    });
    useVoiceChatMock.mockReturnValue(voiceState);
    clientMock.listConversations.mockResolvedValue({ conversations: [] });
    clientMock.createConversation.mockResolvedValue({ conversation });
    clientMock.deleteConversation.mockResolvedValue({ ok: true });
    clientMock.getConversationMessages.mockResolvedValue({ messages: [] });
    clientMock.sendConversationMessageStream.mockResolvedValue({
      agentName: "Eliza",
      completed: true,
      text: "Done",
    });
    clientMock.updateConversation.mockResolvedValue({ conversation });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps attachment and voice/send controls inside the composer", async () => {
    render(<PageScopedChatPane scope="page-apps" />);

    await screen.findByTestId("page-scoped-chat-intro-page-apps");

    const composer = screen.getByTestId("page-scoped-chat-composer-page-apps");
    const attachButton = screen.getByRole("button", { name: "Add attachment" });
    const voiceButton = screen.getByRole("button", {
      name: "Start voice input",
    });

    expect(composer.contains(attachButton)).toBe(true);
    expect(composer.contains(voiceButton)).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: /apps/i }), {
      target: { value: "What should I build next?" },
    });

    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(composer.contains(sendButton)).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Start voice input" }),
    ).toBeNull();
  });

  it("accepts sidebar prefill events in the page-scoped composer", async () => {
    render(<PageScopedChatPane scope="page-apps" />);

    await screen.findByTestId("page-scoped-chat-intro-page-apps");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("milady:chat:prefill", {
          detail: {
            text: "Draft a reply to this message",
            select: true,
          },
        }),
      );
    });

    expect(
      (screen.getByRole("textbox", { name: /apps/i }) as HTMLTextAreaElement)
        .value,
    ).toBe("Draft a reply to this message");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("shows the redesigned Character hub sections in the intro copy", async () => {
    clientMock.createConversation.mockResolvedValueOnce({
      conversation: {
        ...conversation,
        id: "character-page-chat",
        roomId: "room-character",
        metadata: { scope: "page-character" },
        title: "Character assistant",
      },
    });

    render(<PageScopedChatPane scope="page-character" />);

    const intro = await screen.findByTestId(
      "page-scoped-chat-intro-page-character",
    );
    expect(intro.textContent).toContain("Overview");
    expect(intro.textContent).toContain("Personality");
    expect(intro.textContent).toContain("Knowledge");
    expect(intro.textContent).toContain("Experience");
    expect(intro.textContent).toContain("Relationships");
  });

  it("stacks multiline inline drafts above the footer controls", async () => {
    render(<PageScopedChatPane scope="page-apps" />);

    await screen.findByTestId("page-scoped-chat-intro-page-apps");

    const composer = screen.getByTestId("page-scoped-chat-composer-page-apps");
    const textarea = screen.getByRole("textbox", { name: /apps/i });
    let scrollHeight = 32;

    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    scrollHeight = 72;
    fireEvent.change(textarea, {
      target: {
        value:
          "PieChartPieChartPieChartPieChartPieChartPieChartPieChartPieChart",
      },
    });

    await waitFor(() =>
      expect(
        composer.firstElementChild?.getAttribute("data-inline-layout"),
      ).toBe("stacked"),
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start voice input" }),
    ).toBeTruthy();
  });

  it("sends text and voice turns with page routing metadata", async () => {
    render(<PageScopedChatPane scope="page-apps" />);

    await screen.findByTestId("page-scoped-chat-intro-page-apps");

    fireEvent.change(screen.getByRole("textbox", { name: /apps/i }), {
      target: { value: "Recommend an app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(clientMock.sendConversationMessageStream).toHaveBeenCalledTimes(1),
    );
    let call = clientMock.sendConversationMessageStream.mock.calls[0];
    expect(call[1]).toContain("Recommend an app");
    expect(call[3]).toBe("DM");
    expect(call[7]).toMatchObject({
      surface: "page-scoped",
      taskId: "page-apps",
    });
    await screen.findByText("Done");

    act(() => {
      voiceOptionsRef.current?.onTranscript("Open the best starter app");
    });

    await waitFor(() =>
      expect(clientMock.sendConversationMessageStream).toHaveBeenCalledTimes(2),
    );
    call = clientMock.sendConversationMessageStream.mock.calls[1];
    expect(call[1]).toBe("Open the best starter app");
    expect(call[3]).toBe("VOICE_DM");
    expect(call[7]).toMatchObject({
      surface: "page-scoped",
      taskId: "page-apps",
    });
  });

  it("clears the current page-scoped chat into a fresh room", async () => {
    clientMock.listConversations.mockResolvedValue({
      conversations: [conversation],
    });
    clientMock.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          role: "user",
          text: "Existing page chat",
          timestamp: Date.now(),
        },
      ],
    });
    clientMock.createConversation
      .mockResolvedValueOnce({ conversation })
      .mockResolvedValueOnce({
        conversation: {
          ...conversation,
          id: "apps-page-chat-reset",
          roomId: "room-apps-reset",
        },
      });

    render(<PageScopedChatPane scope="page-apps" />);

    await screen.findByText("Existing page chat");

    fireEvent.click(screen.getByTestId("page-scoped-chat-clear-page-apps"));

    await waitFor(() =>
      expect(clientMock.deleteConversation).toHaveBeenCalledWith(
        "apps-page-chat",
      ),
    );
    await waitFor(() =>
      expect(clientMock.createConversation).toHaveBeenCalledTimes(1),
    );
  });
});
