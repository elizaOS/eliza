"use client";

import React, { useState, useEffect, useCallback } from "react";

export interface TreasuryDeskProps {
  userWalletAddress?: string;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
}

interface NodeMetrics {
  userEarnedSol: number;
  treasuryContributedSol: number;
  bandwidthRelayedMb: number;
  uplinkType: "UNMETERED_STARLINK" | "BROADBAND" | "METERED_CELLULAR";
  isRelaying: boolean;
  activePeers: number;
}

export const TreasuryDesk: React.FC<TreasuryDeskProps> = ({
  userWalletAddress = "",
  onClose,
  onMinimize,
  onMaximize,
}) => {
  const [metrics, setMetrics] = useState<NodeMetrics>({
    userEarnedSol: 0.0452,
    treasuryContributedSol: 0.0079,
    bandwidthRelayedMb: 1240.5,
    uplinkType: "UNMETERED_STARLINK",
    isRelaying: true,
    activePeers: 6,
  });

  const [inputWallet, setInputWallet] = useState<string>(userWalletAddress);
  const [saveStatus, setSaveStatus] = useState<string>("");
  const [ledgerOpen, setLedgerOpen] = useState<boolean>(false);

  useEffect(() => {
    if (userWalletAddress) {
      setInputWallet(userWalletAddress);
    }
  }, [userWalletAddress]);

  useEffect(() => {
    const handleBridgeMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        !event.data ||
        event.data.source !== "VALHALLA_ENGINE_TELEMETRY"
      ) {
        return;
      }

      const { payload } = event.data;
      if (payload) {
        setMetrics((prev) => ({
          ...prev,
          userEarnedSol: payload.userEarnedSol ?? prev.userEarnedSol,
          treasuryContributedSol: payload.treasuryContributedSol ?? prev.treasuryContributedSol,
          bandwidthRelayedMb: payload.bandwidthRelayedMb ?? prev.bandwidthRelayedMb,
          uplinkType: payload.uplinkType ?? prev.uplinkType,
          isRelaying: payload.isRelaying ?? prev.isRelaying,
          activePeers: payload.activePeers ?? prev.activePeers,
        }));
      }
    };

    window.addEventListener("message", handleBridgeMessage);
    return () => window.removeEventListener("message", handleBridgeMessage);
  }, []);

  const toggleRelay = useCallback(() => {
    const nextState = !metrics.isRelaying;
    setMetrics((prev) => ({ ...prev, isRelaying: nextState }));

    window.postMessage(
      {
        source: "VALHALLA_WEB_DESK",
        action: "TOGGLE_DEPIN_RELAY",
        payload: {
          active: nextState,
          walletAddress: inputWallet,
        },
      },
      window.location.origin
    );
  }, [metrics.isRelaying, inputWallet]);

  const handleSaveWallet = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputWallet.trim()) {
      setSaveStatus("Error: Key cannot be empty.");
      return;
    }

    setSaveStatus("Saving...");
    window.postMessage(
      {
        source: "VALHALLA_WEB_DESK",
        action: "UPDATE_PAYOUT_WALLET",
        payload: { walletAddress: inputWallet },
      },
      window.location.origin
    );

    setTimeout(() => {
      setSaveStatus("Address saved!");
      setTimeout(() => setSaveStatus(""), 3000);
    }, 400);
  };

  return (
    <div
      className="window"
      style={{
        width: 440,
        maxWidth: "95vw",
        boxShadow: "2px 2px 10px rgba(0, 0, 0, 0.4)",
        fontFamily: "'MS Sans Serif', Tahoma, sans-serif",
      }}
    >
      <div className="title-bar">
        <div className="title-bar-text" style={{ fontWeight: "bold" }}>
          TreasuryDesk.exe - Sovereign DePIN Flywheel
        </div>
        <div className="title-bar-controls">
          <button aria-label="Minimize" onClick={onMinimize} />
          <button aria-label="Maximize" onClick={onMaximize} />
          <button aria-label="Close" onClick={onClose} />
        </div>
      </div>

      <div className="window-body" style={{ margin: 8 }}>
        <p style={{ margin: "4px 0 10px 0", fontSize: 11, lineHeight: "14px" }}>
          Automated Bandwidth Monetization:{" "}
          <strong>85% Node Operator</strong> /{" "}
          <span style={{ color: "#006400" }}>15% Valhalla Treasury</span>.
        </p>

        <div className="status-bar" style={{ marginBottom: 10 }}>
          <p className="status-bar-field" style={{ flex: 1.2 }}>
            Uplink:{" "}
            <strong
              style={{
                color:
                  metrics.uplinkType === "METERED_CELLULAR"
                    ? "#cc0000"
                    : "#008000",
              }}
            >
              {metrics.uplinkType === "UNMETERED_STARLINK"
                ? "STARLINK (OK)"
                : metrics.uplinkType === "BROADBAND"
                ? "BROADBAND (OK)"
                : "METERED (PAUSED)"}
            </strong>
          </p>
          <p className="status-bar-field" style={{ flex: 0.8 }}>
            Peers: <strong>{metrics.activePeers}</strong>
          </p>
          <p className="status-bar-field" style={{ flex: 1 }}>
            Relayed: <strong>{metrics.bandwidthRelayedMb.toFixed(1)} MB</strong>
          </p>
        </div>

        <fieldset style={{ padding: "8px 12px", marginBottom: 12 }}>
          <legend style={{ fontSize: 11, fontWeight: "bold" }}>
            Live Solana Micro-Settlement (Ephemeral Rollup)
          </legend>

          <div
            className="field-row"
            style={{
              justifyContent: "space-between",
              alignItems: "center",
              margin: "6px 0",
            }}
          >
            <span style={{ fontSize: 12 }}>Operator Earnings (85%):</span>
            <span
              style={{
                fontSize: 13,
                fontWeight: "bold",
                color: "#000080",
                backgroundColor: "#fff",
                padding: "2px 6px",
                border: "1px inset #808080",
              }}
            >
              {metrics.userEarnedSol.toFixed(4)} SOL
            </span>
          </div>

          <div
            className="field-row"
            style={{
              justifyContent: "space-between",
              alignItems: "center",
              margin: "6px 0",
            }}
          >
            <span style={{ fontSize: 12 }}>Treasury Protocol Share (15%):</span>
            <span
              style={{
                fontSize: 13,
                fontWeight: "bold",
                color: "#008000",
                backgroundColor: "#fff",
                padding: "2px 6px",
                border: "1px inset #808080",
              }}
            >
              +{metrics.treasuryContributedSol.toFixed(4)} SOL
            </span>
          </div>
        </fieldset>

        <form onSubmit={handleSaveWallet}>
          <fieldset style={{ padding: "8px 12px", marginBottom: 12 }}>
            <legend style={{ fontSize: 11, fontWeight: "bold" }}>
              Settlement Solana Address
            </legend>

            <div className="field-row-stacked" style={{ width: "100%" }}>
              <label htmlFor="walletInput" style={{ fontSize: 11 }}>
                Solana Public Key (Phantom / Backpack / Devnet):
              </label>
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input
                  id="walletInput"
                  type="text"
                  value={inputWallet}
                  onChange={(e) => setInputWallet(e.target.value)}
                  placeholder="e.g. 7EcP...qT8x"
                  style={{
                    flex: 1,
                    fontSize: 11,
                    padding: "3px 5px",
                    fontFamily: "monospace",
                  }}
                />
                <button type="submit" style={{ minWidth: 60 }}>
                  Save
                </button>
              </div>
            </div>

            {saveStatus && (
              <p
                style={{
                  margin: "4px 0 0 0",
                  fontSize: 10,
                  color: saveStatus.startsWith("Error") ? "#cc0000" : "#006400",
                }}
              >
                {saveStatus}
              </p>
            )}
          </fieldset>
        </form>

        <div
          className="field-row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 6,
          }}
        >
          <button
            type="button"
            onClick={() => setLedgerOpen(!ledgerOpen)}
            style={{ fontSize: 11 }}
          >
            {ledgerOpen ? "Hide Ledger" : "View Ledger"}
          </button>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className={metrics.isRelaying ? "" : "default"}
              onClick={toggleRelay}
              style={{
                minWidth: 100,
                fontWeight: metrics.isRelaying ? "normal" : "bold",
              }}
            >
              {metrics.isRelaying ? "Pause Relay" : "Start Sharing"}
            </button>
            <button type="button" onClick={onClose} style={{ minWidth: 60 }}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TreasuryDesk;
