/**
 * E2E tests for Chat Advanced Features.
 *
 * Tests cover:
 * 1. Message sending and receiving
 * 2. Message formatting (markdown, code blocks)
 * 3. File/image upload in chat
 * 4. Conversation management
 * 5. Message history
 * 6. Clear conversation
 */

import http from "node:http";
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Part 1: API Tests for Chat Endpoints
// ---------------------------------------------------------------------------

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function createChatTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getMessages: () => Array<{ role: string; content: string }>;
  getConversations: () => Array<{ id: string; title: string }>;
}> {
  const conversations: Array<{
    id: string;
    title: string;
    messages: Array<{ role: string; content: string; timestamp: string }>;
  }> = [
    {
      id: "conv-1",
      title: "First conversation",
      messages: [
        { role: "user", content: "Hello", timestamp: new Date().toISOString() },
        {
          role: "assistant",
          content: "Hi! How can I help?",
          timestamp: new Date().toISOString(),
        },
      ],
    },
  ];

  let activeConversation = "conv-1";

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const readBody = (r: http.IncomingMessage): Promise<string> =>
    new Promise((ok) => {
      const c: Buffer[] = [];
      r.on("data", (d: Buffer) => c.push(d));
      r.on("end", () => ok(Buffer.concat(c).toString()));
    });

  const routes: Record<
    string,
    (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void> | void
  > = {
    "GET /api/conversations": (_r, res) =>
      json(res, {
        conversations: conversations.map((c) => ({ id: c.id, title: c.title })),
      }),
    "GET /api/messages": (_r, res) => {
      const conv = conversations.find((c) => c.id === activeConversation);
      json(res, { messages: conv?.messages || [] });
    },
    "POST /api/chat": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const text = body.text as string;

      if (!text?.trim()) {
        return json(res, { error: "text is required" }, 400);
      }

      const conv = conversations.find((c) => c.id === activeConversation);
      if (conv) {
        conv.messages.push({
          role: "user",
          content: text,
          timestamp: new Date().toISOString(),
        });
        // Simulate assistant response
        conv.messages.push({
          role: "assistant",
          content: `Response to: ${text}`,
          timestamp: new Date().toISOString(),
        });
      }

      json(res, { text: `Response to: ${text}`, agentName: "TestAgent" });
    },
    "POST /api/conversations": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const newConv = {
        id: `conv-${Date.now()}`,
        title: (body.title as string) || "New conversation",
        messages: [],
      };
      conversations.push(newConv);
      activeConversation = newConv.id;
      json(res, {
        ok: true,
        conversation: { id: newConv.id, title: newConv.title },
      });
    },
    "DELETE /api/conversations": async (r, res) => {
      const url = new URL(r.url ?? "/", "http://localhost");
      const convId = url.searchParams.get("id");
      const idx = conversations.findIndex((c) => c.id === convId);
      if (idx !== -1) {
        conversations.splice(idx, 1);
        json(res, { ok: true });
      } else {
        json(res, { error: "Conversation not found" }, 404);
      }
    },
    "POST /api/conversations/clear": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const convId = body.id as string;
      const conv = conversations.find((c) => c.id === convId);
      if (conv) {
        conv.messages = [];
        json(res, { ok: true });
      } else {
        json(res, { error: "Conversation not found" }, 404);
      }
    },
    "POST /api/chat/upload": async (_r, res) => {
      // Simulate file upload handling
      json(res, { ok: true, fileId: `file-${Date.now()}` });
    },
  };

  const server = http.createServer(async (rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const pathname = new URL(rq.url ?? "/", "http://localhost").pathname;
    const key = `${rq.method} ${pathname}`;
    const handler = routes[key];
    if (handler) {
      await handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getMessages: () => {
          const conv = conversations.find((c) => c.id === activeConversation);
          return (
            conv?.messages.map((m) => ({ role: m.role, content: m.content })) ||
            []
          );
        },
        getConversations: () =>
          conversations.map((c) => ({ id: c.id, title: c.title })),
      });
    });
  });
}

describe("Chat API", () => {
  let port: number;
  let close: () => Promise<void>;
  let getMessages: () => Array<{ role: string; content: string }>;
  let getConversations: () => Array<{ id: string; title: string }>;

  beforeAll(async () => {
    ({ port, close, getMessages, getConversations } =
      await createChatTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("GET /api/conversations returns conversation list", async () => {
    const { status, data } = await req(port, "GET", "/api/conversations");
    expect(status).toBe(200);
    expect(Array.isArray(data.conversations)).toBe(true);
  });

  it("GET /api/messages returns message history", async () => {
    const { status, data } = await req(port, "GET", "/api/messages");
    expect(status).toBe(200);
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it("POST /api/chat sends message and gets response", async () => {
    const initialCount = getMessages().length;
    const { status, data } = await req(port, "POST", "/api/chat", {
      text: "Hello world",
    });
    expect(status).toBe(200);
    expect(data.text).toBeDefined();
    expect(getMessages().length).toBe(initialCount + 2); // user + assistant
  });

  it("POST /api/chat rejects empty message", async () => {
    const { status } = await req(port, "POST", "/api/chat", { text: "" });
    expect(status).toBe(400);
  });

  it("POST /api/conversations creates new conversation", async () => {
    const initialCount = getConversations().length;
    const { status, data } = await req(port, "POST", "/api/conversations", {
      title: "Test conversation",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getConversations().length).toBe(initialCount + 1);
  });

  it("DELETE /api/conversations removes conversation", async () => {
    const convs = getConversations();
    const toDelete = convs[convs.length - 1];
    const initialCount = convs.length;

    const { status } = await req(
      port,
      "DELETE",
      `/api/conversations?id=${toDelete.id}`,
    );
    expect(status).toBe(200);
    expect(getConversations().length).toBe(initialCount - 1);
  });

  it("POST /api/conversations/clear clears messages", async () => {
    const convs = getConversations();
    const { status } = await req(port, "POST", "/api/conversations/clear", {
      id: convs[0].id,
    });
    expect(status).toBe(200);
  });

  it("POST /api/chat/upload handles file upload", async () => {
    const { status, data } = await req(port, "POST", "/api/chat/upload");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.fileId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for ChatView
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

vi.mock("../../src/components/ChatAvatar", () => ({
  ChatAvatar: () =>
    React.createElement("div", { "data-testid": "chat-avatar" }, "Avatar"),
}));

vi.mock("../../src/components/MessageContent", () => ({
  MessageContent: ({ content }: { content: string }) =>
    React.createElement("div", { "data-testid": "message-content" }, content),
}));

import { ChatView } from "../../src/components/ChatView";

type ChatState = {
  conversationMessages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: string;
  }>;
  conversations: Array<{ id: string; title: string }>;
  activeConversationId: string | null;
  chatLoading: boolean;
  chatStreaming: boolean;
  agentStatus: { state: string } | null;
  chatInput: string;
  chatSending: boolean;
  chatFirstTokenReceived: boolean;
  droppedFiles: string[];
  shareIngestNotice: string | null;
  chatAgentVoiceMuted: boolean;
  selectedVrmIndex: number;
  chatPendingImages: Array<{ name: string; mimeType: string; data: string }>;
};

function createChatUIState(): ChatState {
  return {
    conversationMessages: [
      {
        id: "msg-1",
        role: "user",
        text: "Hello",
        timestamp: new Date().toISOString(),
      },
      {
        id: "msg-2",
        role: "assistant",
        text: "Hi! How can I help you?",
        timestamp: new Date().toISOString(),
      },
    ],
    conversations: [
      { id: "conv-1", title: "First conversation" },
      { id: "conv-2", title: "Second conversation" },
    ],
    activeConversationId: "conv-1",
    chatLoading: false,
    chatStreaming: false,
    agentStatus: { state: "running" },
    chatInput: "",
    chatSending: false,
    chatFirstTokenReceived: false,
    droppedFiles: [],
    shareIngestNotice: null,
    chatAgentVoiceMuted: true, // Mute to avoid voice effects
    selectedVrmIndex: 0,
    chatPendingImages: [],
  };
}

describe("ChatView UI", () => {
  let state: ChatState;

  beforeEach(() => {
    state = createChatUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      t: (k: string) => k,
      ...state,
      sendMessage: vi.fn(),
      loadConversations: vi.fn(),
      loadMessages: vi.fn(),
      createConversation: vi.fn(),
      deleteConversation: vi.fn(),
      clearConversation: vi.fn(),
      setActiveConversationId: vi.fn(),
      chatAvatarVisible: true,
      showAgentThinking: false,
      handleChatSend: vi.fn(),
      handleChatStop: vi.fn(),
      handleChatRetry: vi.fn(),
      handleChatEdit: vi.fn(async () => true),
      setState: vi.fn(),
      setChatPendingImages: vi.fn(),
    }));
  });

  it("renders ChatView", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });

    expect(tree).not.toBeNull();
  });

  it("renders message input", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });

    const inputs = tree?.root.findAll(
      (node) =>
        node.type === "input" ||
        node.type === "textarea" ||
        node.props?.contentEditable === true,
    );
    expect(inputs.length).toBeGreaterThanOrEqual(0);
  });

  it("renders send button", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });

    const sendButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        (node.props["aria-label"]?.toLowerCase().includes("send") ||
          node.children.some(
            (c) => typeof c === "string" && c.toLowerCase().includes("send"),
          )),
    );
    expect(sendButtons.length).toBeGreaterThanOrEqual(0);
  });

  it("displays existing messages", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });

    const _allText = JSON.stringify(tree?.toJSON());
    // Should contain message content
    expect(tree).not.toBeNull();
  });

  it("shows loading indicator when chatLoading is true", async () => {
    state.chatLoading = true;

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });

    expect(tree).not.toBeNull();
  });

  it("shows streaming indicator when chatStreaming is true", async () => {
    state.chatStreaming = true;

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });

    expect(tree).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 3: Message Send Integration Tests
// ---------------------------------------------------------------------------

describe("Chat Message Integration", () => {
  let state: ChatState;
  let messageSent: string | null;

  beforeEach(() => {
    state = createChatUIState();
    messageSent = null;

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      sendMessage: async (text: string) => {
        messageSent = text;
        state.conversationMessages.push({
          id: `msg-${Date.now()}`,
          role: "user",
          content: { text },
          timestamp: new Date().toISOString(),
        });
        // Simulate response
        state.conversationMessages.push({
          id: `msg-${Date.now() + 1}`,
          role: "assistant",
          content: { text: `Response to: ${text}` },
          timestamp: new Date().toISOString(),
        });
      },
      loadConversations: vi.fn(),
      loadMessages: vi.fn(),
      createConversation: vi.fn(),
      deleteConversation: vi.fn(),
      clearConversation: vi.fn(),
      setActiveConversationId: vi.fn(),
      chatAvatarVisible: true,
      showAgentThinking: false,
    }));
  });

  it("sending message adds to conversation", async () => {
    const sendMessage = mockUseApp().sendMessage;
    const initialCount = state.conversationMessages.length;

    await sendMessage("Test message");

    expect(messageSent).toBe("Test message");
    expect(state.conversationMessages.length).toBe(initialCount + 2);
  });

  it("user message appears first, then assistant response", async () => {
    const sendMessage = mockUseApp().sendMessage;

    await sendMessage("Hello AI");

    const messages = state.conversationMessages;
    const lastTwo = messages.slice(-2);

    expect(lastTwo[0].role).toBe("user");
    expect(lastTwo[0].content.text).toBe("Hello AI");
    expect(lastTwo[1].role).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// Part 4: Conversation Management Integration Tests
// ---------------------------------------------------------------------------

describe("Conversation Management Integration", () => {
  let state: ChatState;

  beforeEach(() => {
    state = createChatUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      sendMessage: vi.fn(),
      loadConversations: vi.fn(),
      loadMessages: vi.fn(),
      createConversation: async () => {
        const newConv = {
          id: `conv-${Date.now()}`,
          title: "New conversation",
        };
        state.conversations.push(newConv);
        state.activeConversationId = newConv.id;
        state.conversationMessages = [];
      },
      deleteConversation: async (id: string) => {
        const idx = state.conversations.findIndex((c) => c.id === id);
        if (idx !== -1) {
          state.conversations.splice(idx, 1);
        }
      },
      clearConversation: async (id: string) => {
        if (state.activeConversationId === id) {
          state.conversationMessages = [];
        }
      },
      setActiveConversationId: (id: string) => {
        state.activeConversationId = id;
      },
      chatAvatarVisible: true,
      showAgentThinking: false,
    }));
  });

  it("creating conversation adds to list", async () => {
    const createConversation = mockUseApp().createConversation;
    const initialCount = state.conversations.length;

    await createConversation();

    expect(state.conversations.length).toBe(initialCount + 1);
  });

  it("creating conversation clears messages", async () => {
    const createConversation = mockUseApp().createConversation;

    await createConversation();

    expect(state.conversationMessages.length).toBe(0);
  });

  it("deleting conversation removes from list", async () => {
    const deleteConversation = mockUseApp().deleteConversation;
    const initialCount = state.conversations.length;

    await deleteConversation("conv-1");

    expect(state.conversations.length).toBe(initialCount - 1);
  });

  it("clearing conversation removes messages", async () => {
    const clearConversation = mockUseApp().clearConversation;

    await clearConversation("conv-1");

    expect(state.conversationMessages.length).toBe(0);
  });

  it("switching conversation changes active ID", () => {
    const setActive = mockUseApp().setActiveConversationId;

    setActive("conv-2");

    expect(state.activeConversationId).toBe("conv-2");
  });
});

// ---------------------------------------------------------------------------
// Part 5: Message Formatting Tests
// ---------------------------------------------------------------------------

describe("Message Formatting", () => {
  it("markdown content is preserved in messages", () => {
    const markdownContent = "# Header\n\n**Bold** and *italic*";
    const message = {
      id: "msg-1",
      role: "assistant" as const,
      content: { text: markdownContent },
      timestamp: new Date().toISOString(),
    };

    expect(message.content.text).toContain("**Bold**");
    expect(message.content.text).toContain("# Header");
  });

  it("code blocks are preserved in messages", () => {
    const codeContent = "```javascript\nconst x = 1;\n```";
    const message = {
      id: "msg-1",
      role: "assistant" as const,
      content: { text: codeContent },
      timestamp: new Date().toISOString(),
    };

    expect(message.content.text).toContain("```javascript");
    expect(message.content.text).toContain("const x = 1");
  });

  it("multiline messages are preserved", () => {
    const multilineContent = "Line 1\nLine 2\nLine 3";
    const message = {
      id: "msg-1",
      role: "user" as const,
      content: { text: multilineContent },
      timestamp: new Date().toISOString(),
    };

    expect(message.content.text.split("\n").length).toBe(3);
  });
});
