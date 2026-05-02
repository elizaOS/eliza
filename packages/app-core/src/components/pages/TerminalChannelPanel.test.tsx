// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { ptyConsoleBaseProps } = vi.hoisted(() => ({
  ptyConsoleBaseProps: vi.fn(),
}));

// ChatView reads coding-agent UI from the task-coordinator slot registry
// in app-core. Stub the slot module so the test doesn't need the real
// task-coordinator package registered to render.
vi.mock("../../app-shell/task-coordinator-slots", () => ({
  CodingAgentControlChip: () => null,
  CodingAgentSettingsSection: () => null,
  CodingAgentTasksPanel: () => null,
  PtyConsoleBase: (props: Record<string, unknown>) => {
    ptyConsoleBaseProps(props);
    return <div data-testid="pty-console-base">pty</div>;
  },
  registerTaskCoordinatorSlots: () => {},
}));

// ChatView.tsx has transitive imports that reach into the state layer and
// pull in the broader app context. We stub the heavy siblings that
// TerminalChannelPanel doesn't need to keep this test focused.
vi.mock("@elizaos/ui", () => ({
  ChatAttachmentStrip: () => null,
  ChatComposer: () => null,
  ChatComposerShell: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ChatSourceIcon: () => null,
  ChatThreadLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ChatTranscript: () => null,
  TypingIndicator: () => null,
}));

vi.mock("../../state/ChatComposerContext", () => ({
  useChatComposer: () => ({
    chatInput: "",
    chatSending: false,
    chatPendingImages: [],
    setChatPendingImages: () => {},
  }),
}));

vi.mock("../../state/PtySessionsContext", () => ({
  usePtySessions: () => ({ ptySessions: [] }),
}));

vi.mock("../../state/useApp", () => ({
  useApp: () => ({}),
}));

vi.mock("../../state/vrm", () => ({
  getVrmPreviewUrl: () => "",
}));

vi.mock("../../hooks/useChatAvatarVoiceBridge", () => ({
  useChatAvatarVoiceBridge: () => ({}),
}));

vi.mock("../chat/AgentActivityBox", () => ({
  AgentActivityBox: () => null,
}));

vi.mock("../chat/MessageContent", () => ({
  MessageContent: () => null,
}));

vi.mock("./chat-view-hooks", () => ({
  useChatVoiceController: () => ({
    voice: {
      supported: false,
      isListening: false,
      captureMode: "idle",
      interimTranscript: "",
      isSpeaking: false,
      assistantTtsQuality: undefined,
      toggleListening: () => {},
      startListening: () => {},
      stopListening: () => {},
    },
    beginVoiceCapture: () => {},
    endVoiceCapture: () => {},
    stopSpeaking: () => {},
  }),
  useGameModalMessages: () => ({
    gameModalVisibleMsgs: [],
    gameModalCarryoverOpacity: 0,
    companionCarryover: null,
  }),
  __resetCompanionSpeechMemoryForTests: () => {},
}));

vi.mock("../../api/client", () => ({
  client: {
    getInboxMessages: vi.fn(),
    sendInboxMessage: vi.fn(),
  },
}));

vi.mock("../../chat", () => ({
  isRoutineCodingAgentMessage: () => false,
}));

import { TerminalChannelPanel } from "./ChatView";

const sessionFixture = (
  sessionId: string,
  overrides: Record<string, unknown> = {},
) => ({
  sessionId,
  agentType: "shell",
  label: `Session ${sessionId}`,
  originalTask: "",
  workdir: "",
  status: "active" as const,
  decisionCount: 0,
  autoResolvedCount: 0,
  lastActivity: "",
  ...overrides,
});

describe("TerminalChannelPanel", () => {
  afterEach(() => {
    cleanup();
    ptyConsoleBaseProps.mockReset();
  });

  it("shows a loading placeholder when the active session is not in the list yet", () => {
    render(
      <TerminalChannelPanel
        activeSessionId="pending-xyz"
        sessions={[]}
        onClose={() => {}}
        loadingLabel="Starting terminal…"
      />,
    );

    expect(screen.getByTestId("terminal-channel-loading").textContent).toBe(
      "Starting terminal…",
    );
    expect(screen.queryByTestId("pty-console-base")).toBeNull();
    expect(ptyConsoleBaseProps).not.toHaveBeenCalled();
  });

  it("does not auto-spawn when the live session list is empty (spawning is owned by the sidebar)", () => {
    const spy = vi.fn();
    // Any side effect would surface as a prop/callback invocation; we only
    // assert that no PtyConsoleBase mount happens with zero sessions.
    render(
      <TerminalChannelPanel
        activeSessionId="pending-xyz"
        sessions={[]}
        onClose={spy}
        loadingLabel="Starting terminal…"
      />,
    );

    expect(spy).not.toHaveBeenCalled();
    expect(ptyConsoleBaseProps).not.toHaveBeenCalled();
  });

  it("renders PtyConsoleBase with variant=full once the active session is present", () => {
    const sessions = [
      sessionFixture("a"),
      sessionFixture("b"),
      sessionFixture("c"),
    ];

    render(
      <TerminalChannelPanel
        activeSessionId="b"
        sessions={sessions}
        onClose={() => {}}
        loadingLabel="Starting terminal…"
      />,
    );

    expect(screen.getByTestId("terminal-channel-panel")).toBeDefined();
    expect(ptyConsoleBaseProps).toHaveBeenCalledTimes(1);
    const props = ptyConsoleBaseProps.mock.calls[0]?.[0] as {
      activeSessionId: string;
      sessions: unknown[];
      variant: string;
    };
    expect(props.activeSessionId).toBe("b");
    expect(props.variant).toBe("full");
    expect(props.sessions).toHaveLength(3);
  });
});
