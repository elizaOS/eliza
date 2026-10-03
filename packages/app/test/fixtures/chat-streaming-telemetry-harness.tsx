/**
 * Browser harness for the real dashboard chat client, send hook, transcript,
 * and React commit path. The test host injects an API base and reads the
 * timestamped telemetry exposed on `window`.
 */

import {
  Profiler,
  type ProfilerOnRenderCallback,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  type CodingAgentSession,
  type Conversation,
  type ConversationMessage,
  client,
  type ImageAttachment,
} from "../../../ui/src/api";
import { ChatTranscript } from "../../../ui/src/components/composites/chat/chat-transcript";
import {
  type UseChatSendDeps,
  useChatSend,
} from "../../../ui/src/state/useChatSend";

interface TimedValue<T> {
  at: number;
  value: T;
}

interface BrowserChatTelemetry {
  commits: Array<{
    actualDuration: number;
    at: number;
    phase: string;
  }>;
  doneAt?: number;
  error?: string;
  historyReloads: number;
  mutations: Array<TimedValue<string>>;
  mountCounts: Record<string, number>;
  rafCallbacks: number[];
  rafScheduled: number[];
  readyAt?: number;
  renderCounts: Record<string, number>;
  sseFrames: Array<TimedValue<Record<string, unknown>>>;
  startedAt?: number;
  stateSnapshots: Array<TimedValue<ConversationMessage[]>>;
  unmountCounts: Record<string, number>;
}

declare global {
  interface Window {
    __API_BASE__: string;
    __chatTelemetry: BrowserChatTelemetry;
    __startChat: (prompt: string) => Promise<void>;
  }
}

const telemetry: BrowserChatTelemetry = {
  commits: [],
  historyReloads: 0,
  mutations: [],
  mountCounts: {},
  rafCallbacks: [],
  rafScheduled: [],
  renderCounts: {},
  sseFrames: [],
  stateSnapshots: [],
  unmountCounts: {},
};
window.__chatTelemetry = telemetry;

const telemetryNow = (): number => performance.timeOrigin + performance.now();

const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  telemetry.rafScheduled.push(telemetryNow());
  return nativeRequestAnimationFrame((time) => {
    telemetry.rafCallbacks.push(telemetryNow());
    callback(time);
  });
};

const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args): Promise<Response> => {
  const response = await nativeFetch(...args);
  const input = args[0];
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.includes("/messages/stream") || !response.body) {
    return response;
  }

  const [clientBody, telemetryBody] = response.body.tee();
  void (async () => {
    const reader = telemetryBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        telemetry.sseFrames.push({ at: telemetryNow(), value: parsed });
      }
    }
  })().catch((error: unknown) => {
    telemetry.error = error instanceof Error ? error.message : String(error);
  });

  return new Response(clientBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

function TrackedMessageContent({ message }: { message: ConversationMessage }) {
  const renderKey = message.clientRenderId ?? message.id;
  telemetry.renderCounts[renderKey] =
    (telemetry.renderCounts[renderKey] ?? 0) + 1;
  useEffect(() => {
    telemetry.mountCounts[renderKey] =
      (telemetry.mountCounts[renderKey] ?? 0) + 1;
    return () => {
      telemetry.unmountCounts[renderKey] =
        (telemetry.unmountCounts[renderKey] ?? 0) + 1;
    };
  }, [renderKey]);
  return <span data-message-id={message.id}>{message.text}</span>;
}

function ChatHarness() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const activeConversationIdRef = useRef<string | null>(null);
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  const chatInputRef = useRef("");
  const chatPendingImagesRef = useRef<ImageAttachment[]>([]);
  const chatReplyTargetRef = useRef(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatSendBusyRef = useRef(false);
  const chatSendNonceRef = useRef(0);
  const ptySessionsRef = useRef<CodingAgentSession[]>([]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
  useEffect(() => {
    conversationMessagesRef.current = messages;
    telemetry.stateSnapshots.push({
      at: telemetryNow(),
      value: structuredClone(messages),
    });
  }, [messages]);

  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId,
    ptySessionsRef,
    setChatInput: (value) => {
      chatInputRef.current = value;
    },
    setChatSending: () => undefined,
    setChatFirstTokenReceived: () => undefined,
    setServerTurnStatus: () => undefined,
    setChatLastUsage: () => undefined,
    setChatPendingImages: (value) => {
      chatPendingImagesRef.current = value;
    },
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs: () => undefined,
    setConversationMessages: setMessages,
    setUnreadConversations: () => undefined,
    setChatReplyTarget: () => undefined,
    setActionNotice: (text, tone) => {
      if (tone === "error") telemetry.error = text;
    },
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef,
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    loadConversations: async () => conversationsRef.current,
    loadConversationMessages: async (conversationId) => {
      telemetry.historyReloads += 1;
      const result = await client.getConversationMessages(conversationId);
      setMessages(result.messages);
      return { ok: true };
    },
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: async () => true,
  };
  const chat = useChatSend(deps);

  useEffect(() => {
    let active = true;
    client.setBaseUrl(window.__API_BASE__, { persist: false });
    void client
      .createConversation("telemetry")
      .then(({ conversation }) => {
        if (!active) return;
        conversationsRef.current = [conversation];
        activeConversationIdRef.current = conversation.id;
        setConversations([conversation]);
        setActiveConversationId(conversation.id);
        telemetry.readyAt = telemetryNow();
      })
      .catch((error: unknown) => {
        telemetry.error =
          error instanceof Error ? error.message : String(error);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    window.__startChat = async (prompt: string) => {
      const conversationId = activeConversationIdRef.current;
      if (!conversationId) throw new Error("conversation not ready");
      telemetry.startedAt = telemetryNow();
      await chat.sendChatText(prompt, { conversationId });
      telemetry.doneAt = telemetryNow();
    };
  }, [chat]);

  useEffect(() => {
    const root = document.querySelector("#transcript");
    if (!root) return;
    const observer = new MutationObserver(() => {
      telemetry.mutations.push({
        at: telemetryNow(),
        value: root.textContent ?? "",
      });
    });
    observer.observe(root, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  const renderMessageContent = useCallback(
    (message: ConversationMessage) => (
      <TrackedMessageContent message={message} />
    ),
    [],
  );

  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_id, phase, actualDuration) => {
      telemetry.commits.push({
        actualDuration,
        at: telemetryNow(),
        phase,
      });
    },
    [],
  );

  return (
    <Profiler id="chat" onRender={onRender}>
      <main id="transcript">
        <ChatTranscript
          messages={messages}
          renderMessageContent={renderMessageContent}
        />
      </main>
    </Profiler>
  );
}

const root = document.querySelector("#root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<ChatHarness />);
