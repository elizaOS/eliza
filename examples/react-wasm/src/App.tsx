import { useState, useRef, useEffect, useCallback } from "react";
import {
  getRuntime,
  sendMessage,
  getGreeting,
} from "./eliza-runtime";
import "./App.css";

interface Message {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isBooted, setIsBooted] = useState(false);
  const [bootStatus, setBootStatus] = useState("Initializing...");
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Boot sequence - initialize the AgentRuntime
  useEffect(() => {
    let mounted = true;

    const initializeEliza = async () => {
      try {
        setBootStatus("Loading elizaOS runtime...");

        // Initialize the AgentRuntime
        await getRuntime();

        if (!mounted) return;

        setBootStatus("Runtime initialized");
        setIsBooted(true);

        // Add initial greeting after boot
        setTimeout(() => {
          if (mounted) {
            addElizaMessage(getGreeting());
          }
        }, 500);
      } catch (error) {
        console.error("Failed to initialize elizaOS:", error);
        if (mounted) {
          setBootStatus(
            `Error: ${error instanceof Error ? error.message : "Failed to initialize"}`
          );
        }
      }
    };

    initializeEliza();

    return () => {
      mounted = false;
    };
  }, []);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop =
        chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input after boot
  useEffect(() => {
    if (isBooted && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isBooted, isTyping]);

  const addElizaMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `eliza-${Date.now()}`,
        text,
        isUser: false,
        timestamp: new Date(),
      },
    ]);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const text = inputValue.trim();
      if (!text || isTyping) return;

      // Add user message
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          text,
          isUser: true,
          timestamp: new Date(),
        },
      ]);
      setInputValue("");
      setIsTyping(true);

      try {
        // Send message through elizaOS runtime
        const response = await sendMessage(text);
        addElizaMessage(response);
      } catch (error) {
        console.error("Error sending message:", error);
        addElizaMessage(
          "I apologize, but I'm having trouble responding right now. Please try again."
        );
      } finally {
        setIsTyping(false);
      }
    },
    [inputValue, isTyping, addElizaMessage]
  );

  return (
    <div className="crt-monitor">
      <div className={`crt-screen ${isBooted ? "booted" : ""}`}>
        {/* Scanlines overlay */}
        <div className="scanlines" />

        {/* Screen glow */}
        <div className="screen-glow" />

        <div className="terminal">
          {/* Header */}
          <header className="terminal-header">
            <h1 className="title">ELIZA</h1>
            <div className="subtitle">Rogerian Psychotherapist Simulation</div>
            <div className="meta">MIT AI Lab • 1966 • Joseph Weizenbaum</div>
          </header>

          {/* Status bar */}
          <div className="status-bar">
            <div className="status-item">
              <span
                className={`status-indicator ${isBooted ? "online" : "loading"}`}
              />
              <span>{isBooted ? "System Ready" : bootStatus}</span>
            </div>
          </div>

          {/* Chat container */}
          <div className="chat-container" ref={chatContainerRef}>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`message ${message.isUser ? "user" : "eliza"}`}
              >
                <span className="message-label">
                  {message.isUser ? "YOU" : "ELIZA"}:
                </span>
                <span className="message-text">{message.text}</span>
              </div>
            ))}

            {isTyping && (
              <div className="message eliza typing">
                <span className="message-label">ELIZA:</span>
                <span className="typing-dots">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </div>
            )}
          </div>

          {/* Input area */}
          <form className="input-area" onSubmit={handleSubmit}>
            <span className="prompt-symbol">{">"}</span>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Tell me what's troubling you..."
              disabled={!isBooted || isTyping}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={!isBooted || isTyping || !inputValue.trim()}
            >
              SEND
            </button>
          </form>

        </div>
      </div>

      {/* Monitor bezel details */}
      <div className="led-container">
        <div className="led power" />
        <div className={`led activity ${isTyping ? "blinking" : ""}`} />
      </div>
    </div>
  );
}

export default App;
