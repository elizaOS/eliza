/**
 * ProvisioningChatView — interactive chat shown while the user's cloud
 * container is provisioning (typically 2-5 minutes). A serverless
 * placeholder agent answers questions while the Docker container warms up.
 * When the container becomes ready, `onContainerReady` is called with the
 * bridge URL and the caller transitions to the normal connect flow.
 */

import { ChevronLeft } from "lucide-react";
import * as React from "react";
import { useProvisioningChat } from "../../hooks/useProvisioningChat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

export interface ProvisioningChatViewProps {
  agentId: string | null;
  cloudApiBase: string;
  onContainerReady: (bridgeUrl: string) => void;
  onBack?: () => void;
}

export function ProvisioningChatView({
  agentId,
  cloudApiBase,
  onContainerReady,
  onBack,
}: ProvisioningChatViewProps) {
  const {
    messages,
    sendMessage,
    containerStatus,
    bridgeUrl,
    isLoading,
    isContainerReady,
  } = useProvisioningChat({ agentId, cloudApiBase });

  const [inputValue, setInputValue] = React.useState("");
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const onContainerReadyRef = React.useRef(onContainerReady);
  onContainerReadyRef.current = onContainerReady;

  // Scroll to bottom whenever messages change.
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Trigger the handoff when the container becomes ready.
  React.useEffect(() => {
    if (isContainerReady && bridgeUrl) {
      onContainerReadyRef.current(bridgeUrl);
    }
  }, [isContainerReady, bridgeUrl]);

  const handleSend = React.useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isLoading) return;
    setInputValue("");
    await sendMessage(text);
    inputRef.current?.focus();
  }, [inputValue, isLoading, sendMessage]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const statusLabel = isContainerReady
    ? "Container ready! Connecting..."
    : containerStatus === "error"
      ? "Container setup failed — please retry."
      : "Setting up your agent...";

  const statusColor = isContainerReady
    ? "#4ade80"
    : containerStatus === "error"
      ? "#f87171"
      : "#ffe600";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        maxWidth: "28rem",
        height: "min(480px, 70vh)",
        fontFamily: MONO_FONT,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "12px",
        }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "rgba(255,255,255,0.55)",
              padding: "4px",
              display: "flex",
              alignItems: "center",
            }}
            aria-label="Back"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div
          style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1 }}
        >
          {/* Pulsing dot */}
          <span
            style={{
              display: "inline-block",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: statusColor,
              animation: isContainerReady
                ? "none"
                : "pulse 2s ease-in-out infinite",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: "10px",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.75)",
            }}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Inline keyframe animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>

      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "12px",
          background: "rgba(0,0,0,0.45)",
          border: "2px solid rgba(240,185,11,0.35)",
          marginBottom: "10px",
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "8px 12px",
                background:
                  msg.role === "user"
                    ? "rgba(255,230,0,0.15)"
                    : "rgba(255,255,255,0.07)",
                border:
                  msg.role === "user"
                    ? "1px solid rgba(255,230,0,0.35)"
                    : "1px solid rgba(255,255,255,0.12)",
                fontSize: "12px",
                lineHeight: "1.5",
                color:
                  msg.role === "user"
                    ? "rgba(255,255,255,0.9)"
                    : "rgba(255,255,255,0.75)",
              }}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                padding: "8px 12px",
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.12)",
                fontSize: "12px",
                color: "rgba(255,255,255,0.45)",
                letterSpacing: "0.1em",
              }}
            >
              ...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{ display: "flex", gap: "8px" }}>
        <Input
          ref={inputRef}
          type="text"
          placeholder={
            isContainerReady ? "Container ready!" : "Ask me anything..."
          }
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading || isContainerReady}
          className="h-10 rounded-none border-2 border-[#f0b90b]/45 bg-black/55 text-sm text-white placeholder:text-white/40 focus:border-[#ffe600]"
          style={{ fontFamily: MONO_FONT, flex: 1 }}
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSend()}
          disabled={isLoading || !inputValue.trim() || isContainerReady}
          className="rounded-none border-2 border-black bg-[#ffe600] text-xs font-black uppercase tracking-[0.12em] text-black hover:bg-white disabled:opacity-40"
          style={{ fontFamily: MONO_FONT }}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
