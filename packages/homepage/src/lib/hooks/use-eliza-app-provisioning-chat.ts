import { useCallback, useEffect, useRef, useState } from "react";
import { elizacloudAuthFetch } from "@/lib/api/client";

export interface ProvisioningChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface StatusResponse {
  success?: boolean;
  data?: { status?: string; agentId?: string; bridgeUrl?: string };
}

interface ChatResponse {
  success?: boolean;
  data?: {
    reply?: string;
    containerStatus?: string;
    bridgeUrl?: string;
    agentId?: string;
  };
}

function uid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const POLL_INTERVAL_MS = 5_000;

const WELCOME: ProvisioningChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi! I'm Eliza. Your personal AI space is warming up — typically 2–4 minutes. Ask me anything while you wait!",
};

export function useElizaAppProvisioningChat(active: boolean) {
  const [messages, setMessages] = useState<ProvisioningChatMessage[]>([
    WELCOME,
  ]);
  const [containerStatus, setContainerStatus] = useState<string>("pending");
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const stoppedRef = useRef(false);
  const provisionedRef = useRef(false);

  const isReady = containerStatus === "running" && bridgeUrl !== null;

  // Kick off provisioning once when the hook becomes active.
  useEffect(() => {
    if (!active || provisionedRef.current) return;
    provisionedRef.current = true;

    (async () => {
      try {
        const res = await elizacloudAuthFetch<StatusResponse>(
          "/api/eliza-app/provisioning-agent",
          {
            method: "POST",
          },
        );
        if (res.success && res.data) {
          setContainerStatus(res.data.status ?? "pending");
          if (res.data.agentId) setAgentId(res.data.agentId);
          if (res.data.bridgeUrl) setBridgeUrl(res.data.bridgeUrl);
        }
      } catch {
        // Provisioning call failure is non-fatal; polling will pick up the status.
      }
    })();
  }, [active]);

  // Poll container status every 5 seconds.
  useEffect(() => {
    if (!active || isReady) return;
    stoppedRef.current = false;

    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        const res = await elizacloudAuthFetch<StatusResponse>(
          "/api/eliza-app/provisioning-agent",
        );
        if (stoppedRef.current) return;
        if (res.success && res.data) {
          const newStatus = res.data.status ?? containerStatus;
          setContainerStatus(newStatus);
          if (res.data.agentId && !agentId) setAgentId(res.data.agentId);
          if (res.data.bridgeUrl) {
            setBridgeUrl(res.data.bridgeUrl);
          }
          if (newStatus === "running" && res.data.bridgeUrl) {
            stoppedRef.current = true;
            setMessages((prev) => [
              ...prev,
              {
                id: uid(),
                role: "assistant",
                content:
                  "Your AI space is ready! You can start chatting in full now.",
              },
            ]);
          }
        }
      } catch {
        // Best-effort; network failures are transient.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stoppedRef.current = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isReady, containerStatus, agentId]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (isLoading || !content.trim()) return;

      const userMsg: ProvisioningChatMessage = {
        id: uid(),
        role: "user",
        content: content.trim(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        const res = await elizacloudAuthFetch<ChatResponse>(
          "/api/eliza-app/provisioning-agent/chat",
          {
            method: "POST",
            body: JSON.stringify({
              message: content.trim(),
              agentId: agentId ?? undefined,
            }),
          },
        );
        if (res.success && res.data) {
          if (res.data.containerStatus)
            setContainerStatus(res.data.containerStatus);
          if (res.data.bridgeUrl) setBridgeUrl(res.data.bridgeUrl);
          if (res.data.agentId && !agentId) setAgentId(res.data.agentId);
          const reply = res.data.reply;
          if (reply) {
            setMessages((prev) => [
              ...prev,
              { id: uid(), role: "assistant", content: reply },
            ]);
          }
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: "assistant",
            content:
              "I'm having trouble connecting. Your space is still warming up in the background!",
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
    agentId,
    isLoading,
    isReady,
  };
}
