"use client";

import React, { useState, useEffect } from "react";
import { MASTER_ADMIN_EMAIL, isMasterAdmin } from "@/services/adminAuth";

interface AdminDashboardProps {
  onClose?: () => void;
}

export const AdminTerminal: React.FC<AdminDashboardProps> = ({ onClose }) => {
  const [authEmail, setAuthEmail] = useState<string>("");
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>("");

  const [systemStats, setSystemStats] = useState({
    activePersona: "NOMAD",
    reserveWallet: "Loading...",
    beaconUptime: "Online (24/7)",
    totalYieldSol: "0.0531",
    treasuryFeeRate: "15%",
    torCircuits: "Active (:9050)"
  });

  useEffect(() => {
    const stored = localStorage.getItem("valhalla_admin_email");
    if (stored && isMasterAdmin(stored)) {
      setAuthEmail(stored);
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (isMasterAdmin(authEmail)) {
      setIsAuthenticated(true);
      setAuthError("");
      localStorage.setItem("valhalla_admin_email", authEmail.trim().toLowerCase());
    } else {
      setAuthError("HTTP 403 Forbidden: Email does not match master administrative credentials.");
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem("valhalla_admin_email");
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
          AdminControl.exe - Master Sovereign Terminal
        </div>
        <div className="title-bar-controls">
          <button aria-label="Close" onClick={onClose} />
        </div>
      </div>

      <div className="window-body" style={{ margin: 10 }}>
        {!isAuthenticated ? (
          <form onSubmit={handleLogin}>
            <div style={{ backgroundColor: "#000080", color: "#fff", padding: "6px 8px", marginBottom: 10 }}>
              <strong>SYSTEM GOVERNANCE ACCESS RESTRICTED</strong>
              <div style={{ fontSize: 10, marginTop: 2 }}>Master Admin: {MASTER_ADMIN_EMAIL}</div>
            </div>

            <fieldset style={{ padding: "10px 12px" }}>
              <legend style={{ fontSize: 11, fontWeight: "bold" }}>Administrative Verification</legend>
              <div className="field-row-stacked" style={{ marginBottom: 8 }}>
                <label htmlFor="adminEmailInput" style={{ fontSize: 11 }}>Master Admin Identifier:</label>
                <input
                  id="adminEmailInput"
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="keene.jos@gmail.com"
                  style={{ width: "100%", fontSize: 11 }}
                />
              </div>

              {authError && (
                <div style={{ color: "#cc0000", fontSize: 10, margin: "6px 0", fontWeight: "bold" }}>
                  {authError}
                </div>
              )}

              <div className="field-row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                <button type="submit" className="default" style={{ minWidth: 80 }}>
                  Authenticate
                </button>
              </div>
            </fieldset>
          </form>
        ) : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: "#006400", fontWeight: "bold" }}>
                ● Master Authority Verified: {authEmail}
              </span>
              <button type="button" onClick={handleLogout} style={{ fontSize: 10 }}>
                Sign Out
              </button>
            </div>

            <fieldset style={{ padding: "8px 12px", marginBottom: 10 }}>
              <legend style={{ fontSize: 11, fontWeight: "bold" }}>Network & Yield Governance</legend>
              <div className="field-row" style={{ justifyContent: "space-between", margin: "4px 0" }}>
                <span>Active Operating Persona:</span>
                <strong>{systemStats.activePersona}</strong>
              </div>
              <div className="field-row" style={{ justifyContent: "space-between", margin: "4px 0" }}>
                <span>Daemon Loop State:</span>
                <span style={{ color: "#006400" }}>{systemStats.beaconUptime}</span>
              </div>
              <div className="field-row" style={{ justifyContent: "space-between", margin: "4px 0" }}>
                <span>Total Yield Accrued:</span>
                <strong>{systemStats.totalYieldSol} SOL</strong>
              </div>
              <div className="field-row" style={{ justifyContent: "space-between", margin: "4px 0" }}>
                <span>Protocol Fee Split:</span>
                <span>85% Operator / 15% Treasury</span>
              </div>
              <div className="field-row" style={{ justifyContent: "space-between", margin: "4px 0" }}>
                <span>Tor Circuit Gateway:</span>
                <span>{systemStats.torCircuits}</span>
              </div>
            </fieldset>

            <div className="field-row" style={{ justifyContent: "flex-end", gap: 6 }}>
              <button type="button" onClick={() => alert("Emergency override dispatched to port 3001.")}>
                Force State Sync
              </button>
              <button type="button" onClick={onClose}>
                Close Terminal
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminTerminal;
