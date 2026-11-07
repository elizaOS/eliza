"use client";

import React, { useState, useEffect, useRef } from "react";
import { isMasterAdmin } from "@/services/adminAuth";

interface MessageItem {
  id: string;
  sender: "user" | "valhalla" | "system";
  text: string;
  timestamp: string;
}

export const ValhallaChatVoice: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: "1",
      sender: "valhalla",
      text: "ValhallaOS Voice & Text Node online. Microphones and local audio synthesizers synchronized.",
      timestamp: new Date().toLocaleTimeString()
    }
  ]);

  const [inputText, setInputText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [activeAdmin, setActiveAdmin] = useState(false);

  const recognitionRef = useRef<any>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Check if authenticated as keene.jos@gmail.com
    const stored = localStorage.getItem("valhalla_admin_email");
    if (stored && isMasterAdmin(stored)) {
      setActiveAdmin(true);
    }

    // Auto-scroll chat log
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Web Speech API Voice Synthesis (Zero Cost, Browser Native)
  const speakText = (text: string) => {
    if (!voiceEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  // Web Speech API Voice Recognition (Zero Cost, Browser Native)
  const toggleListening = () => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Notice: Web Speech API is not supported in this browser. Please use text input.");
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      if (transcript) {
        handleSendMessage(transcript);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  // Dispatch message to ElizaOS loopback bridge
  const handleSendMessage = (textToSend?: string) => {
    const content = (textToSend || inputText).trim();
    if (!content) return;

    const userMsg: MessageItem = {
      id: `msg-${Date.now()}`,
      sender: "user",
      text: content,
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInputText("");

    // Forward to local engine / extension via window.postMessage
    window.postMessage(
      {
        source: "VALHALLA_WEB_DESK",
        action: "CHAT_MESSAGE",
        payload: { text: content }
      },
      window.location.origin
    );

    // Simulate Agent response or synthesize speech
    setTimeout(() => {
      const replyText = `[ELIZA-V38]: Directive received: "${content}". Processing in secure local runtime.`;
      const replyMsg: MessageItem = {
        id: `reply-${Date.now()}`,
        sender: "valhalla",
        text: replyText,
        timestamp: new Date().toLocaleTimeString()
      };
      setMessages((prev) => [...prev, replyMsg]);
      speakText(replyText);
    }, 600);
  };

  return (
    <div
      className="window"
      style={{
        width: 480,
        maxWidth: "95vw",
        boxShadow: "3px 3px 14px rgba(0,0,0,0.5)",
        fontFamily: "'MS Sans Serif', Tahoma, sans-serif"
      }}
    >
      <div className="title-bar">
        <div className="title-bar-text" style={{ fontWeight: "bold" }}>
          ValhallaChat.exe - Unified Voice & Text Hub 🎙️
        </div>
        <div className="title-bar-controls">
          <button aria-label="Close" onClick={onClose} />
        </div>
      </div>

      <div className="window-body" style={{ margin: 10 }}>
        <div className="status-bar" style={{ marginBottom: 8 }}>
          <p className="status-bar-field">Status: <strong>CONNECTED (:3001)</strong></p>
          <p className="status-bar-field">Voice: <strong>{voiceEnabled ? (isSpeaking ? "SPEAKING" : "READY") : "MUTED"}</strong></p>
          <p className="status-bar-field">Role: <strong>{activeAdmin ? "MASTER ADMIN" : "GUEST"}</strong></p>
        </div>

        {/* Scrollable Conversation Terminal */}
        <div
          ref={chatScrollRef}
          style={{
            height: 180,
            overflowY: "scroll",
            backgroundColor: "#fff",
            border: "1px inset #808080",
            padding: 8,
            marginBottom: 8,
            fontSize: 11
          }}
        >
          {messages.map((m) => (
            <div key={m.id} style={{ margin: "4px 0", lineHeight: "14px" }}>
              <span style={{ color: m.sender === "user" ? "#000080" : "#006400", fontWeight: "bold" }}>
                [{m.timestamp}] {m.sender === "user" ? "You" : "Valhalla"}:{" "}
              </span>
              <span>{m.text}</span>
            </div>
          ))}
        </div>

        {/* Text Input Row */}
        <div className="field-row" style={{ gap: 4, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="Type a directive or prompt..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
            style={{ flex: 1, fontSize: 11, padding: "3px 6px" }}
          />
          <button type="button" className="default" onClick={() => handleSendMessage()} style={{ minWidth: 60 }}>
            Send
          </button>
        </div>

        {/* Voice Controls Row */}
        <div className="field-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              onClick={toggleListening}
              style={{
                backgroundColor: isListening ? "#ffcccc" : undefined,
                fontWeight: isListening ? "bold" : "normal"
              }}
            >
              {isListening ? "🔴 Listening..." : "🎙️ Push to Talk"}
            </button>
            <button type="button" onClick={() => setVoiceEnabled(!voiceEnabled)}>
              {voiceEnabled ? "🔊 Mute Voice" : "🔈 Unmute"}
            </button>
          </div>
          <button type="button" onClick={onClose} style={{ minWidth: 60 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ValhallaChatVoice;
