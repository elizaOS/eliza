"use client";

import React, { useState, useEffect } from "react";
import { MerlinWizard } from "@/components/desktop/MerlinWizard";
import { TreasuryDesk } from "@/components/desktop/TreasuryDesk";
import { AdminTerminal } from "@/components/desktop/AdminTerminal";
import { ValhallaChatVoice } from "@/components/desktop/ValhallaChatVoice";
import { MASTER_ADMIN_EMAIL } from "@/services/adminAuth";

export default function ValhallaOSDesktop() {
  const [merlinOpen, setMerlinOpen] = useState(false);
  const [treasuryOpen, setTreasuryOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [persona, setPersona] = useState<"sentinel" | "nomad" | "offline">("offline");
  const [lastPing, setLastPing] = useState<string>("Initializing Loopback...");

  useEffect(() => {
    const initTimer = setTimeout(() => {
      window.postMessage(
        { source: "VALHALLA_WEB_DESK", action: "QUERY_STATE" },
        window.location.origin
      );
    }, 300);

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;

      const { source, payload } = event.data;
      if (source === "VALHALLA_ENGINE_TELEMETRY" && payload) {
        if (payload.persona) setPersona(payload.persona);
        if (payload.timestamp) {
          setLastPing(`Synced: ${new Date(payload.timestamp).toLocaleTimeString()}`);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      clearTimeout(initTimer);
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        backgroundColor: "#008080",
        overflow: "hidden",
        position: "relative",
        userSelect: "none",
        fontFamily: "'MS Sans Serif', Tahoma, sans-serif"
      }}
    >
      {/* Desktop App Icons */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, width: 90 }}>
        <div
          onDoubleClick={() => setChatOpen(true)}
          style={{ textAlign: "center", cursor: "pointer", color: "#fff", fontSize: 11 }}
        >
          <div style={{ fontSize: 32, marginBottom: 2 }}>🎙️</div>
          <span style={{ backgroundColor: chatOpen ? "#000080" : "rgba(0,0,0,0.4)", padding: "2px 4px" }}>
            Voice & Chat
          </span>
        </div>

        <div
          onDoubleClick={() => setMerlinOpen(true)}
          style={{ textAlign: "center", cursor: "pointer", color: "#fff", fontSize: 11 }}
        >
          <div style={{ fontSize: 32, marginBottom: 2 }}>🪄</div>
          <span style={{ backgroundColor: merlinOpen ? "#000080" : "rgba(0,0,0,0.4)", padding: "2px 4px" }}>
            Merlin Setup
          </span>
        </div>

        <div
          onDoubleClick={() => setTreasuryOpen(true)}
          style={{ textAlign: "center", cursor: "pointer", color: "#fff", fontSize: 11 }}
        >
          <div style={{ fontSize: 32, marginBottom: 2 }}>💰</div>
          <span style={{ backgroundColor: treasuryOpen ? "#000080" : "rgba(0,0,0,0.4)", padding: "2px 4px" }}>
            Treasury Desk
          </span>
        </div>

        <div
          onDoubleClick={() => setAdminOpen(true)}
          style={{ textAlign: "center", cursor: "pointer", color: "#fff", fontSize: 11 }}
        >
          <div style={{ fontSize: 32, marginBottom: 2 }}>🛡️</div>
          <span style={{ backgroundColor: adminOpen ? "#000080" : "rgba(0,0,0,0.4)", padding: "2px 4px" }}>
            Admin Terminal
          </span>
        </div>
      </div>

      {/* Windows */}
      {chatOpen && (
        <div style={{ position: "absolute", top: 30, left: 120, zIndex: 15 }}>
          <ValhallaChatVoice onClose={() => setChatOpen(false)} />
        </div>
      )}

      {merlinOpen && (
        <div style={{ position: "absolute", top: 60, left: 160, zIndex: 10 }}>
          <MerlinWizard onClose={() => setMerlinOpen(false)} />
        </div>
      )}

      {treasuryOpen && (
        <div style={{ position: "absolute", top: 120, left: 300, zIndex: 5 }}>
          <TreasuryDesk onClose={() => setTreasuryOpen(false)} />
        </div>
      )}

      {adminOpen && (
        <div style={{ position: "absolute", top: 70, left: 220, zIndex: 20 }}>
          <AdminTerminal onClose={() => setAdminOpen(false)} />
        </div>
      )}

      {/* Persistent Retro Taskbar */}
      <div
        className="window"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 6px",
          borderTop: "2px solid #dfdfdf",
          zIndex: 100
        }}
      >
        <button className="default" style={{ fontWeight: "bold", height: 24, fontSize: 11 }}>
          Start
        </button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "#333" }}>Admin: {MASTER_ADMIN_EMAIL}</span>
          <div style={{ fontSize: 11, padding: "2px 8px", border: "1px inset #808080", backgroundColor: "#dfdfdf" }}>
            Engine: <strong>{persona.toUpperCase()}</strong>
          </div>
          <div style={{ fontSize: 11, padding: "2px 8px", border: "1px inset #808080", backgroundColor: "#dfdfdf" }}>
            {lastPing}
          </div>
        </div>
      </div>
    </main>
  );
}
