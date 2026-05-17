import { useState } from "react";
import { HttpAospFlasherBackend } from "../backend/http-backend";
import { FlasherApp } from "./FlasherApp";
import { IosFlasher } from "./IosFlasher";

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = "usb" | "android" | "ios";

interface Tab {
  id: TabId;
  label: string;
}

const TABS: Tab[] = [
  { id: "usb", label: "💾 USB Boot Drive" },
  { id: "android", label: "📱 Android Flash" },
  { id: "ios", label: "🍎 iPhone / iPad" },
];

// ---------------------------------------------------------------------------
// Placeholder panels
// ---------------------------------------------------------------------------

function UsbInstallerPanel() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: "40px 24px",
      }}
    >
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid #2a2a2a",
          borderRadius: "12px",
          padding: "40px 48px",
          maxWidth: "520px",
          width: "100%",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "48px", marginBottom: "16px" }}>💾</div>
        <h2
          style={{
            color: "#ffffff",
            fontSize: "20px",
            fontWeight: 600,
            margin: "0 0 12px",
          }}
        >
          USB Boot Drive
        </h2>
        <p
          style={{
            color: "#888888",
            fontSize: "14px",
            lineHeight: "1.6",
            margin: "0",
          }}
        >
          Launch the <strong style={{ color: "#cccccc" }}>elizaOS USB Installer</strong> app
          from your Applications folder to create a bootable elizaOS USB drive.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main shell
// ---------------------------------------------------------------------------

export interface InstallerShellProps {
  serverUrl: string;
}

export function InstallerShell({ serverUrl }: InstallerShellProps) {
  const [activeTab, setActiveTab] = useState<TabId>("usb");

  const backend = new HttpAospFlasherBackend(`${serverUrl}/api`);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0a0a0a",
        color: "#ffffff",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        overflow: "hidden",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 24px",
          height: "56px",
          borderBottom: "1px solid #1e1e1e",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            color: "#00ff88",
            fontWeight: 700,
            fontSize: "15px",
            letterSpacing: "-0.01em",
          }}
        >
          elizaOS
        </span>
        <span style={{ color: "#333333", fontSize: "15px" }}>/</span>
        <span style={{ color: "#888888", fontSize: "15px" }}>Installer</span>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: "0",
          padding: "0 24px",
          borderBottom: "1px solid #1e1e1e",
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: "none",
                border: "none",
                borderBottom: isActive
                  ? "2px solid #00ff88"
                  : "2px solid transparent",
                color: isActive ? "#00ff88" : "#666666",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: isActive ? 600 : 400,
                padding: "12px 20px",
                transition: "color 0.15s, border-color 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {activeTab === "usb" && <UsbInstallerPanel />}
        {activeTab === "android" && <FlasherApp backend={backend} />}
        {activeTab === "ios" && <IosFlasher serverUrl={serverUrl} />}
      </div>
    </div>
  );
}
