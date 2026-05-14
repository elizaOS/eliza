import { useCallback, useEffect, useRef, useState } from "react";
import { elizacloudFetch, getAuthToken } from "@/lib/api/client";

export interface OnboardingChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface OnboardingChatAction {
  type: "login" | "control-panel" | "launch";
  label: string;
  href: string;
}

interface ApiMessage {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

interface OnboardingChatResponse {
  success?: boolean;
  data?: {
    sessionId?: string;
    reply?: string;
    requiresLogin?: boolean;
    loginUrl?: string;
    controlPanelUrl?: string;
    launchUrl?: string | null;
    handoffComplete?: boolean;
    provisioning?: {
      status?: string;
      agentId?: string;
      bridgeUrl?: string;
    };
    messages?: ApiMessage[];
  };
}

const SESSION_KEY = "eliza_onboarding_session";
const POLL_INTERVAL_MS = 5_000;

function uid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getStoredSessionId(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("onboardingSession");
  if (fromUrl) return fromUrl;
  return localStorage.getItem(SESSION_KEY);
}

function setStoredSessionId(sessionId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_KEY, sessionId);
}

function toMessages(messages: ApiMessage[] | undefined): OnboardingChatMessage[] {
  if (!messages?.length) {
    return [
      {
        id: "welcome",
        role: "assistant",
        content: "Hey, I'm Eliza. What should I call you?",
      },
    ];
  }
  return messages.map((message, index) => ({
    id: `${message.createdAt ?? "message"}-${index}`,
    role: message.role,
    content: message.content,
  }));
}

function toActions(data: OnboardingChatResponse["data"]): OnboardingChatAction[] {
  const actions: OnboardingChatAction[] = [];
  if (data?.requiresLogin && data.loginUrl) {
    actions.push({ type: "login", label: "Connect Eliza Cloud", href: data.loginUrl });
  }
  if (data?.controlPanelUrl && !data.requiresLogin) {
    actions.push({ type: "control-panel", label: "Open control panel", href: data.controlPanelUrl });
  }
  if (data?.launchUrl) {
    actions.push({ type: "launch", label: "Open agent", href: data.launchUrl });
  }
  return actions;
}

export function useElizaAppOnboardingChat(active: boolean) {
  const [sessionId, setSessionId] = useState<string | null>(() => getStoredSessionId());
  const [messages, setMessages] = useState<OnboardingChatMessage[]>(() => toMessages(undefined));
  const [actions, setActions] = useState<OnboardingChatAction[]>([]);
  const [containerStatus, setContainerStatus] = useState<string>("none");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [handoffComplete, setHandoffComplete] = useState(false);
  const initializedRef = useRef(false);

  const isReady = containerStatus === "running";

  const callOnboarding = useCallback(
    async (message?: string, options?: { optimistic?: boolean }) => {
      if (isLoading || (!message?.trim() && options?.optimistic)) return;

      const trimmed = message?.trim();
      if (trimmed && options?.optimistic !== false) {
        setMessages((prev) => [...prev, { id: uid(), role: "user", content: trimmed }]);
      }
      setIsLoading(true);

      try {
        const token = getAuthToken();
        const response = await elizacloudFetch<OnboardingChatResponse>(
          "/api/eliza-app/onboarding/chat",
          {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            body: JSON.stringify({
              ...(sessionId ? { sessionId } : {}),
              ...(trimmed ? { message: trimmed } : {}),
              platform: "web",
            }),
          },
        );

        const data = response.data;
        if (data?.sessionId) {
          setSessionId(data.sessionId);
          setStoredSessionId(data.sessionId);
        }
        setMessages(toMessages(data?.messages));
        setActions(toActions(data));
        setContainerStatus(data?.provisioning?.status ?? "none");
        setAgentId(data?.provisioning?.agentId ?? null);
        setHandoffComplete(Boolean(data?.handoffComplete));
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: "assistant",
            content: "I'm having trouble reaching Eliza Cloud. Try again in a moment.",
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, sessionId],
  );

  useEffect(() => {
    if (!active || initializedRef.current) return;
    initializedRef.current = true;
    void callOnboarding(undefined, { optimistic: false });
  }, [active, callOnboarding]);

  useEffect(() => {
    if (!active || handoffComplete || containerStatus === "none" || containerStatus === "running") {
      return;
    }
    const timer = setInterval(() => {
      void callOnboarding(undefined, { optimistic: false });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, callOnboarding, containerStatus, handoffComplete]);

  return {
    sessionId,
    messages,
    actions,
    sendMessage: (message: string) => callOnboarding(message),
    containerStatus,
    agentId,
    isLoading,
    isReady,
    handoffComplete,
  };
}
