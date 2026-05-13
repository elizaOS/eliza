import * as React from "react";

export interface ProvisioningChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface UseProvisioningChatArgs {
  agentId: string | null;
  cloudApiBase: string;
}

interface UseProvisioningChatResult {
  messages: ProvisioningChatMessage[];
  sendMessage: (content: string) => Promise<void>;
  containerStatus: string;
  bridgeUrl: string | null;
  isLoading: boolean;
  isContainerReady: boolean;
}

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const POLL_INTERVAL_MS = 5_000;

export function useProvisioningChat(
  args: UseProvisioningChatArgs,
): UseProvisioningChatResult {
  const { agentId, cloudApiBase } = args;

  const [messages, setMessages] = React.useState<ProvisioningChatMessage[]>([
    {
      id: generateId(),
      role: "assistant",
      content:
        "Hi! I'm Eliza. Your personal AI container is warming up — typically 2–4 minutes. While you wait, ask me anything about what I can do!",
    },
  ]);
  const [containerStatus, setContainerStatus] = React.useState("pending");
  const [bridgeUrl, setBridgeUrl] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const stoppedRef = React.useRef(false);

  const isContainerReady = containerStatus === "running" && bridgeUrl !== null;

  // Poll provisioning agent status every 5 seconds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cloudApiBase triggers client re-creation
  React.useEffect(() => {
    if (isContainerReady) return;
    if (containerStatus === "error") return;
    stoppedRef.current = false;

    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        const url = new URL(
          `/api/v1/provisioning-agent${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
          cloudApiBase,
        );
        const resp = await fetch(url.toString());
        if (stoppedRef.current) return;
        if (resp.ok) {
          const json = (await resp.json()) as {
            success?: boolean;
            data?: { status?: string; bridgeUrl?: string };
          };
          if (json.success && json.data) {
            const newStatus = json.data.status ?? containerStatus;
            setContainerStatus(newStatus);
            if (json.data.bridgeUrl) {
              setBridgeUrl(json.data.bridgeUrl);
            }
            if (newStatus === "running" && json.data.bridgeUrl) {
              stoppedRef.current = true;
              setMessages((prev) => [
                ...prev,
                {
                  id: generateId(),
                  role: "assistant",
                  content: "Your container is ready! Transferring you now...",
                },
              ]);
            }
          }
        }
      } catch {
        // Best-effort; endpoint may not exist yet.
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      stoppedRef.current = true;
      clearInterval(timer);
    };
  }, [agentId, cloudApiBase, isContainerReady, containerStatus]);

  const sendMessage = React.useCallback(
    async (content: string) => {
      if (isLoading || !content.trim()) return;

      const userMessage: ProvisioningChatMessage = {
        id: generateId(),
        role: "user",
        content: content.trim(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      try {
        const chatUrl = new URL("/api/v1/provisioning-agent/chat", cloudApiBase);
        const resp = await fetch(chatUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: content.trim(), agentId: agentId ?? undefined }),
        });
        if (resp.ok) {
          const json = (await resp.json()) as {
            success?: boolean;
            data?: { reply?: string; containerStatus?: string; bridgeUrl?: string };
          };
          if (json.success && json.data) {
            if (json.data.containerStatus) {
              setContainerStatus(json.data.containerStatus);
            }
            if (json.data.bridgeUrl) {
              setBridgeUrl(json.data.bridgeUrl);
            }
            const reply = json.data.reply;
            if (reply) {
              setMessages((prev) => [
                ...prev,
                { id: generateId(), role: "assistant", content: reply },
              ]);
            }
          }
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: "assistant",
            content:
              "I'm having trouble connecting right now. Your container is still warming up in the background — I'll let you know when it's ready!",
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [agentId, isLoading],
  );

  return {
    messages,
    sendMessage,
    containerStatus,
    bridgeUrl,
    isLoading,
    isContainerReady,
  };
}
