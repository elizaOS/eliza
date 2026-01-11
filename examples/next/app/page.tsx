"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./page.module.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface StreamChunk {
  text?: string;
  done?: boolean;
  error?: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  // Initialize runtime on mount
  useEffect(() => {
    const initRuntime = async () => {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "init" }),
      });

      const data = (await response.json()) as {
        success?: boolean;
        error?: string;
        mode?: string;
      };

      if (data.success) {
        setIsInitialized(true);
        const statusEl = document.getElementById("status-text");
        if (statusEl) {
          statusEl.textContent =
            data.mode === "elizaos" ? "elizaOS" : "Classic";
        }
        const welcomeMsg =
          data.mode === "elizaos"
            ? "Hello! I'm Eliza, powered by elizaOS. How can I help you today?"
            : "Hello! I'm Eliza (classic mode). For LLM responses, set POSTGRES_URL or run `elizaos start`.";
        setMessages([
          {
            id: "welcome",
            role: "assistant",
            content: welcomeMsg,
            timestamp: new Date(),
          },
        ]);
      } else {
        setError(data.error || "Failed to initialize");
      }
    };

    initRuntime();
  }, []);

  // Focus input after loading
  useEffect(() => {
    if (isInitialized && !isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isInitialized, isLoading]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    const text = input.trim();
    if (!text || isLoading || !isInitialized) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    // Handle streaming response
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response stream");
    }

    const assistantMessageId = `assistant-${Date.now()}`;
    let fullContent = "";

    // Add empty assistant message
    setMessages((prev) => [
      ...prev,
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
      },
    ]);

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk
        .split("\n")
        .filter((line) => line.startsWith("data: "));

      for (const line of lines) {
        const data = JSON.parse(line.slice(6)) as StreamChunk;
        if (data.text) {
          fullContent += data.text;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: fullContent }
                : msg,
            ),
          );
        }
        if (data.error) {
          throw new Error(data.error);
        }
      }
    }

    setIsLoading(false);
  };

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <div className={styles.logo}>
            <div className={styles.logoIcon}>E</div>
            <div className={styles.logoText}>
              <h1>ELIZA</h1>
              <span>elizaOS Next.js Demo</span>
            </div>
          </div>
          <div className={styles.status}>
            <span
              className={`${styles.statusDot} ${isInitialized ? styles.online : styles.offline}`}
            />
            <span className={styles.statusText} id="status-text">
              {isInitialized ? "Ready" : "Initializing..."}
            </span>
          </div>
        </div>
      </header>

      {/* Chat area */}
      <main className={styles.main}>
        <div className={styles.messagesContainer}>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`${styles.message} ${styles[message.role]}`}
            >
              <div className={styles.messageAvatar}>
                {message.role === "assistant" ? "🤖" : "👤"}
              </div>
              <div className={styles.messageContent}>
                <div className={styles.messageMeta}>
                  <span className={styles.messageRole}>
                    {message.role === "assistant" ? "Eliza" : "You"}
                  </span>
                  <span className={styles.messageTime}>
                    {message.timestamp.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className={styles.messageText}>
                  {message.content || (
                    <span className={styles.typingIndicator}>
                      <span>●</span>
                      <span>●</span>
                      <span>●</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Error display */}
        {error && (
          <div className={styles.errorBanner}>
            <span>⚠️ {error}</span>
            <button type="button" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}
      </main>

      {/* Input area */}
      <footer className={styles.footer}>
        <form onSubmit={handleSubmit} className={styles.inputForm}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              isInitialized ? "Send a message..." : "Initializing..."
            }
            disabled={!isInitialized || isLoading}
            className={styles.input}
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={!isInitialized || isLoading || !input.trim()}
            className={styles.sendButton}
          >
            {isLoading ? (
              <span className={styles.spinner} />
            ) : (
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-label="Send message"
                role="img"
              >
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            )}
          </button>
        </form>
        <div className={styles.footerMeta}>Powered by elizaOS AgentRuntime</div>
      </footer>
    </div>
  );
}
