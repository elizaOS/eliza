// @vitest-environment jsdom

import type { CustomActionDef } from "@elizaos/app-core/api";
import React, { useEffect, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient, mockUseApp, mockUseVoiceChat } = vi.hoisted(() => ({
  mockClient: {
    getCodingAgentStatus: vi.fn(async () => null),
    listCustomActions: vi.fn(),
    generateCustomAction: vi.fn(),
    createCustomAction: vi.fn(),
    updateCustomAction: vi.fn(),
    deleteCustomAction: vi.fn(),
    testCustomAction: vi.fn(),
  },
  mockUseApp: vi.fn(),
  mockUseVoiceChat: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  getVrmPreviewUrl: () => null,
}));

vi.mock("@elizaos/app-core/platform", () => ({
  isDesktopPlatform: () => false,
}));

vi.mock("@elizaos/app-core/hooks", async () => {
  const actual = await vi.importActual<typeof import("@elizaos/app-core/hooks")>(
    "@elizaos/app-core/hooks",
  );
  return {
    ...actual,
    useVoiceChat: () => mockUseVoiceChat(),
  };
});

vi.mock("../../src/components/ChatAvatar", () => ({
  ChatAvatar: () => null,
}));

vi.mock("../../src/components/MessageContent", () => ({
  MessageContent: ({ message }: { message: { text: string } }) =>
    React.createElement("span", null, message.text),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
}));

interface ChatViewContextStub {
  agentStatus: { agentName: string } | null;
  chatInput: string;
  chatSending: boolean;
  chatFirstTokenReceived: boolean;
  conversationMessages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    source?: string;
  }>;
  handleChatSend: (mode: "simple" | "power") => Promise<void>;
  handleChatStop: () => void;
  handleChatRetry: (id: string) => void;
  handleChatEdit: (id: string, text: string) => Promise<boolean>;
  setState: (key: string, value: unknown) => void;
  droppedFiles: string[];
  shareIngestNotice: string;
  selectedVrmIndex: number;
  chatPendingImages: string[];
}

function createContext(
  overrides?: Partial<ChatViewContextStub>,
): ChatViewContextStub {
  return {
    agentStatus: { agentName: "Milady" },
    chatInput: "",
    chatSending: false,
    chatFirstTokenReceived: false,
    conversationMessages: [],
    handleChatSend: vi.fn(async () => { }),
    handleChatStop: vi.fn(),
    handleChatRetry: vi.fn(),
    handleChatEdit: vi.fn(async () => true),
    setState: vi.fn(),
    droppedFiles: [],
    shareIngestNotice: "",
    selectedVrmIndex: 0,
    chatPendingImages: [],
    ...overrides,
    uiLanguage: "en" as const,
    t: (k: string) => k,
  };
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child: TestRenderer.ReactTestInstance | string) =>
      typeof child === "string"
        ? child
        : text(child as TestRenderer.ReactTestInstance),
    )
    .join("")
    .trim();
}

function findButtonByText(
  root: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  const found = root.root.findAll(
    (n: TestRenderer.ReactTestInstance) =>
      n.type === "button" && text(n) === label,
  );
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

function findInputByPlaceholder(
  root: TestRenderer.ReactTestRenderer,
  placeholder: string,
): TestRenderer.ReactTestInstance {
  const found = root.root.findAll(
    (n) =>
      n.type === "input" &&
      typeof n.props.placeholder === "string" &&
      n.props.placeholder.includes(placeholder),
  );
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

import { ChatView } from "../../src/components/ChatView";
import { CustomActionEditor } from "../../src/components/CustomActionEditor";
import { CustomActionsPanel } from "../../src/components/CustomActionsPanel";

function FlowHarness({
  onSaved,
}: {
  onSaved: (action: CustomActionDef) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<CustomActionDef | null>(
    null,
  );

  useEffect(() => {
    const handler = () => setPanelOpen((open) => !open);
    window.addEventListener("toggle-custom-actions-panel", handler);
    return () =>
      window.removeEventListener("toggle-custom-actions-panel", handler);
  }, []);

  return React.createElement(
    "div",
    null,
    React.createElement(ChatView),
    React.createElement(CustomActionsPanel, {
      open: panelOpen,
      onClose: () => setPanelOpen(false),
      onOpenEditor: (action?: CustomActionDef | null) => {
        setEditingAction(action ?? null);
        setEditorOpen(true);
      },
    }),
    React.createElement(CustomActionEditor, {
      open: editorOpen,
      action: editingAction,
      onSave: (action: CustomActionDef) => {
        onSaved(action);
        setEditorOpen(false);
        setEditingAction(null);
      },
      onClose: () => {
        setEditorOpen(false);
        setEditingAction(null);
      },
    }),
  );
}

describe("custom actions smoke flow", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockUseVoiceChat.mockReset();
    mockUseApp.mockReturnValue(createContext());
    mockUseVoiceChat.mockReturnValue({
      supported: false,
      isListening: false,
      captureMode: "idle",
      interimTranscript: "",
      toggleListening: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      mouthOpen: 0,
      isSpeaking: false,
      usingAudioAnalysis: false,
      speak: vi.fn(),
      queueAssistantSpeech: vi.fn(),
      stopSpeaking: vi.fn(),
    });

    for (const fn of Object.values(mockClient)) {
      if (typeof fn === "function" && "mockReset" in fn) {
        fn.mockReset();
      }
    }

    const listeners = new Map<string, Set<(event: Event) => void>>();
    Object.assign(window, {
      addEventListener: (type: string, handler: (event: Event) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, handler: (event: Event) => void) => {
        const set = listeners.get(type);
        if (set) {
          set.delete(handler);
        }
      },
      dispatchEvent: (event: Event) => {
        const set = listeners.get(event.type) ?? new Set();
        for (const handler of set) {
          handler(event);
        }
        return true;
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens action panel, generates and saves an action", async () => {
    mockClient.listCustomActions.mockResolvedValue([]);
    mockClient.generateCustomAction.mockResolvedValue({
      ok: true,
      generated: {
        name: "check_site",
        description: "Checks if a URL responds.",
        handlerType: "http",
        handler: {
          type: "http",
          method: "GET",
          url: "https://example.com/{{url}}",
          headers: {
            accept: "application/json",
          },
          bodyTemplate: '{"ping": true}',
        },
        parameters: [
          {
            name: "url",
            description: "Target URL",
            required: true,
          },
        ],
        similes: ["site", "health check"],
      },
    });
    mockClient.createCustomAction.mockImplementation(
      async (payload: CustomActionDef) => ({
        ...payload,
        id: "act-1",
      }),
    );

    const onSaved = vi.fn();

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FlowHarness, { onSaved }));
    });
    if (!tree) throw new Error("failed to render FlowHarness");

    // The ChatView no longer renders an "Actions" button — the panel is toggled
    // via a custom event. Dispatch it directly to open the panel.

    await act(async () => {
      window.dispatchEvent(new Event("toggle-custom-actions-panel"));
    });
    await flush();

    expect(mockClient.listCustomActions).toHaveBeenCalledTimes(1);

    const title = tree?.root.findAll(
      (node: TestRenderer.ReactTestInstance) =>
        node.type === "h2" && text(node) === "customactionspanel.CustomActions",
    );
    expect(title.length).toBe(1);

    const createButton = findButtonByText(
      tree,
      "customactionspanel.NewCustomAction",
    );
    await act(async () => {
      createButton.props.onClick();
    });
    await flush();

    const editorHeader = tree?.root.findAll(
      (node: TestRenderer.ReactTestInstance) =>
        node.type === "h2" && text(node) === "New Custom Action",
    );
    expect(editorHeader.length).toBe(1);

    const promptInput = findInputByPlaceholder(
      tree,
      "customactioneditor.eGCheckIfAWebs",
    );
    await act(async () => {
      promptInput.props.onChange({
        target: { value: "Build a URL health check action" },
      });
    });
    await flush();

    const generateButton = findButtonByText(tree, "Generate");
    await act(async () => {
      generateButton.props.onClick();
    });
    await flush();

    expect(mockClient.generateCustomAction).toHaveBeenCalledWith(
      "Build a URL health check action",
    );

    const nameInput = findInputByPlaceholder(
      tree,
      "customactioneditor.MYACTION",
    );
    expect(nameInput.props.value).toBe("CHECK_SITE");

    const descriptionArea = tree?.root.findAll(
      (node: TestRenderer.ReactTestInstance) =>
        node.type === "textarea" &&
        node.props.placeholder === "customactioneditor.WhatDoesThisActio",
    )[0];
    expect(descriptionArea.props.value).toBe("Checks if a URL responds.");

    const saveButton = findButtonByText(tree, "Save");
    await act(async () => {
      saveButton.props.onClick();
    });
    await flush();

    expect(mockClient.createCustomAction).toHaveBeenCalledWith({
      name: "CHECK_SITE",
      description: "Checks if a URL responds.",
      similes: ["SITE", "HEALTH_CHECK"],
      parameters: [
        {
          name: "url",
          description: "Target URL",
          required: true,
        },
      ],
      handler: {
        type: "http",
        method: "GET",
        url: "https://example.com/{{url}}",
        headers: {
          accept: "application/json",
        },
        bodyTemplate: '{"ping": true}',
      },
      enabled: true,
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
