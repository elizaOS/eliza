import { useCallback, useEffect, useRef, useState } from "react";
import { elizacloudAuthFetch } from "@/lib/api/client";

export interface ProvisioningChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatResponse {
  success?: boolean;
  data?: {
    reply?: string;
    launchUrl?: string | null;
    handoffComplete?: boolean;
    provisioning?: { status?: string; agentId?: string; bridgeUrl?: string };
    messages?: Array<{
      role?: "user" | "assistant";
      content?: string;
      createdAt?: string;
    }>;
  };
}

interface LegacyStatusResponse {
  success?: boolean;
  data?: { status?: string; agentId?: string; bridgeUrl?: string };
}

interface LegacyChatResponse {
  success?: boolean;
  data?: {
    reply?: string;
    containerStatus?: string;
    bridgeUrl?: string;
    agentId?: string;
  };
}

interface OnboardingChatApiMessage {
  role?: "user" | "assistant";
  content?: string;
  createdAt?: string;
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
    "Hi! I'm Eliza. I can set up your private cloud agent and keep this setup chat with it.",
};

function toChatMessages(
  messages: OnboardingChatApiMessage[] | undefined,
): ProvisioningChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [WELCOME];
  }
  return messages
    .filter(
      (
        message,
      ): message is OnboardingChatApiMessage & {
        role: "user" | "assistant";
        content: string;
      } =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
    .map((message, index) => ({
      id: `${message.createdAt ?? "message"}-${index}`,
      role: message.role,
      content: message.content,
    }));
}

export function useElizaAppProvisioningChat(
  active: boolean,
  onboardingSessionId?: string | null,
) {
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
  const usesSharedOnboarding = Boolean(onboardingSessionId);

  const applyOnboardingResponse = useCallback((data: ChatResponse["data"]) => {
    if (!data) return;
    const provisioning = data.provisioning;
    if (provisioning?.status) setContainerStatus(provisioning.status);
    if (provisioning?.agentId) setAgentId(provisioning.agentId);
    if (provisioning?.bridgeUrl) setBridgeUrl(provisioning.bridgeUrl);
    const nextMessages = toChatMessages(data.messages);
    if (nextMessages.length > 0) {
      setMessages(nextMessages);
    }
  }, []);

  useEffect(() => {
    if (!active || provisionedRef.current) return;
    provisionedRef.current = true;

    (async () => {
      try {
        if (!usesSharedOnboarding) {
          const res = await elizacloudAuthFetch<LegacyStatusResponse>(
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
          return;
        }

        const res = await elizacloudAuthFetch<ChatResponse>(
          "/api/eliza-app/onboarding/chat",
          {
            method: "POST",
            body: JSON.stringify({
              sessionId: onboardingSessionId ?? undefined,
              platform: onboardingSessionId ? "blooio" : "web",
            }),
          },
        );
        if (res.success && res.data) applyOnboardingResponse(res.data);
      } catch {
        return;
      }
    })();
  }, [active, applyOnboardingResponse, onboardingSessionId, usesSharedOnboarding]);

  useEffect(() => {
    if (!active || isReady) return;
    stoppedRef.current = false;

    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        if (!usesSharedOnboarding) {
          const res = await elizacloudAuthFetch<LegacyStatusResponse>(
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
          return;
        }

        const res = await elizacloudAuthFetch<ChatResponse>(
          "/api/eliza-app/onboarding/chat",
          {
            method: "POST",
            body: JSON.stringify({
              sessionId: onboardingSessionId ?? undefined,
              platform: onboardingSessionId ? "blooio" : "web",
            }),
          },
        );
        if (stoppedRef.current) return;
        if (res.success && res.data) {
          const provisioning = res.data.provisioning;
          const newStatus = provisioning?.status ?? containerStatus;
          setContainerStatus(newStatus);
          if (provisioning?.agentId && !agentId) setAgentId(provisioning.agentId);
          if (provisioning?.bridgeUrl) {
            setBridgeUrl(provisioning.bridgeUrl);
          }
          if (newStatus === "running" && provisioning?.bridgeUrl) {
            stoppedRef.current = true;
            applyOnboardingResponse(res.data);
          }
        }
      } catch {
        return;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stoppedRef.current = true;
      clearInterval(timer);
    };
  }, [
    active,
    agentId,
    applyOnboardingResponse,
    containerStatus,
    isReady,
    onboardingSessionId,
    usesSharedOnboarding,
  ]);

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
        if (!usesSharedOnboarding) {
          const res = await elizacloudAuthFetch<LegacyChatResponse>(
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
          return;
        }

        const res = await elizacloudAuthFetch<ChatResponse>(
          "/api/eliza-app/onboarding/chat",
          {
            method: "POST",
            body: JSON.stringify({
              sessionId: onboardingSessionId ?? undefined,
              message: content.trim(),
              platform: onboardingSessionId ? "blooio" : "web",
            }),
          },
        );
        if (res.success && res.data) {
          applyOnboardingResponse(res.data);
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
    [
      agentId,
      applyOnboardingResponse,
      isLoading,
      onboardingSessionId,
      usesSharedOnboarding,
    ],
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
