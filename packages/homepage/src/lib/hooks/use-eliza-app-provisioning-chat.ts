/**
 * React hook for the authenticated homepage provisioning chat.
 *
 * It supports both the current shared onboarding session API and the legacy
 * provisioning-agent status/chat endpoints while exposing one chat-shaped
 * client state. Mounting and polling are read-only; compute lifecycle changes
 * require a separate explicit user action.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { elizacloudAuthFetch } from "@/lib/api/client";
import { buildProvisioningPollBody } from "@/lib/provisioning-poll-body";

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
    bridgeUrl?: string | null;
    agentId?: string | null;
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
const POLL_DEADLINE_MS = 5 * 60 * 1000;

const WELCOME: ProvisioningChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi! I'm Eliza. I'll show your Cloud status here. Dedicated compute stays off until you explicitly start it.",
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
  const [hasObservedStatus, setHasObservedStatus] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [provisioningError, setProvisioningError] = useState<string | null>(
    null,
  );
  const stoppedRef = useRef(false);
  const pollStartRef = useRef<number | null>(null);

  const isReady = containerStatus === "running" && bridgeUrl !== null;
  const isDedicatedOff = containerStatus === "none";
  const usesSharedOnboarding = Boolean(onboardingSessionId);

  const applyOnboardingResponse = useCallback((data: ChatResponse["data"]) => {
    if (!data) return;
    const provisioning = data.provisioning;
    if (provisioning?.status) {
      setContainerStatus(provisioning.status);
      setHasObservedStatus(true);
    }
    if (provisioning) {
      // Same authoritative replacement as the legacy poll branch.
      setAgentId(provisioning.agentId ?? null);
      setBridgeUrl(
        provisioning.status === "running"
          ? (provisioning.bridgeUrl ?? null)
          : null,
      );
    }
    const nextMessages = toChatMessages(data.messages);
    if (nextMessages.length > 0) {
      setMessages(nextMessages);
    }
  }, []);

  const generationRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSessionIdRef = useRef<string | null | undefined>(undefined);
  const containerStatusRef = useRef(containerStatus);
  const agentIdRef = useRef(agentId);
  const bridgeUrlRef = useRef(bridgeUrl);

  useEffect(() => {
    containerStatusRef.current = containerStatus;
  }, [containerStatus]);
  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);
  useEffect(() => {
    bridgeUrlRef.current = bridgeUrl;
  }, [bridgeUrl]);

  const retryProvisioning = useCallback(() => {
    setProvisioningError(null);
    pollStartRef.current = Date.now();
    stoppedRef.current = false;
    generationRef.current += 1;
  }, []);

  useEffect(() => {
    const isSameSession = lastSessionIdRef.current === onboardingSessionId;
    if (!isSameSession) {
      lastSessionIdRef.current = onboardingSessionId;
      setProvisioningError(null);
      pollStartRef.current = Date.now();
      stoppedRef.current = false;
      generationRef.current += 1;
      setContainerStatus("pending");
      setHasObservedStatus(false);
      setAgentId(null);
      setBridgeUrl(null);
      setMessages([WELCOME]);
      setIsLoading(false);
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
  }, [onboardingSessionId]);

  useEffect(() => {
    if (!active || isReady || isDedicatedOff || provisioningError) return;
    stoppedRef.current = false;
    if (pollStartRef.current === null) pollStartRef.current = Date.now();
    generationRef.current += 1;
    const generation = generationRef.current;
    let cancelled = false;

    const poll = async () => {
      if (
        stoppedRef.current ||
        cancelled ||
        generation !== generationRef.current
      )
        return;
      const elapsed = pollStartRef.current
        ? Date.now() - pollStartRef.current
        : 0;
      if (elapsed > POLL_DEADLINE_MS) {
        if (generation !== generationRef.current) return;
        stoppedRef.current = true;
        setProvisioningError(
          "Provisioning timed out. Please refresh or contact support.",
        );
        return;
      }
      try {
        if (!usesSharedOnboarding) {
          const res = await elizacloudAuthFetch<LegacyStatusResponse>(
            "/api/eliza-app/provisioning-agent",
          );
          if (
            stoppedRef.current ||
            cancelled ||
            generation !== generationRef.current
          )
            return;
          if (res.success && res.data) {
            const newStatus = res.data.status ?? containerStatusRef.current;
            setContainerStatus(newStatus);
            if (res.data.status) setHasObservedStatus(true);
            // Replace from the authoritative response rather than keeping the
            // first id ever seen: the server re-selects the canonical target
            // every poll, so first-write-wins pinned this client to a
            // superseded agent while status correctly moved on. A bridge only
            // belongs to a running target, so it clears with any other status.
            setAgentId(res.data.agentId ?? null);
            setBridgeUrl(
              newStatus === "running" ? (res.data.bridgeUrl ?? null) : null,
            );
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
              return;
            }
            if (newStatus === "none") {
              stoppedRef.current = true;
              return;
            }
            if (newStatus === "error") {
              stoppedRef.current = true;
              setProvisioningError(
                "Provisioning failed. Please try again or contact support.",
              );
              return;
            }
            if (newStatus === "deletion_failed") {
              stoppedRef.current = true;
              setProvisioningError(
                "Removing your previous Dedicated agent failed. Contact support.",
              );
              return;
            }
          }
        } else {
          const res = await elizacloudAuthFetch<ChatResponse>(
            "/api/eliza-app/onboarding/chat",
            {
              method: "POST",
              body: JSON.stringify(
                buildProvisioningPollBody(onboardingSessionId),
              ),
            },
          );
          if (
            stoppedRef.current ||
            cancelled ||
            generation !== generationRef.current
          )
            return;
          if (res.success && res.data) {
            const provisioning = res.data.provisioning;
            const newStatus =
              provisioning?.status ?? containerStatusRef.current;
            applyOnboardingResponse(res.data);
            if (newStatus === "running" && provisioning?.bridgeUrl) {
              stoppedRef.current = true;
              return;
            }
            if (newStatus === "none") {
              stoppedRef.current = true;
              return;
            }
            if (newStatus === "error") {
              stoppedRef.current = true;
              setProvisioningError(
                "Provisioning failed. Please try again or contact support.",
              );
              return;
            }
            if (newStatus === "deletion_failed") {
              stoppedRef.current = true;
              setProvisioningError(
                "Removing your previous Dedicated agent failed. Contact support.",
              );
              return;
            }
          }
        }
      } catch {
        return;
      } finally {
        if (
          !cancelled &&
          !stoppedRef.current &&
          generation === generationRef.current
        ) {
          timeoutRef.current = window.setTimeout(
            () => void poll(),
            POLL_INTERVAL_MS,
          );
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [
    active,
    applyOnboardingResponse,
    isReady,
    isDedicatedOff,
    onboardingSessionId,
    provisioningError,
    usesSharedOnboarding,
  ]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!hasObservedStatus || isLoading || isDedicatedOff || !content.trim())
        return;

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
            const nextStatus =
              res.data.containerStatus ?? containerStatusRef.current;
            if (res.data.containerStatus) {
              setContainerStatus(nextStatus);
              setHasObservedStatus(true);
            }
            // A chat response observes the same canonical target as polling.
            // Replace nullable identity fields so a removed or stopped target
            // cannot leave a stale handoff URL in the client.
            setAgentId(res.data.agentId ?? null);
            setBridgeUrl(
              nextStatus === "running" ? (res.data.bridgeUrl ?? null) : null,
            );
            if (nextStatus !== "running" || !res.data.bridgeUrl) {
              pollStartRef.current = Date.now();
              stoppedRef.current = false;
            }
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
              "I'm having trouble connecting. Dedicated compute was not started or changed.",
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [
      agentId,
      applyOnboardingResponse,
      hasObservedStatus,
      isDedicatedOff,
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
    isDedicatedOff,
    hasObservedStatus,
    provisioningError,
    retryProvisioning,
  };
}
