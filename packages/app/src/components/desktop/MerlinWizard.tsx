"use client";

import React, { useState, useEffect } from "react";

export interface PartnerConfig {
  ollamaUrl: string;
  groqApiKey: string;
  togetherApiKey: string;
  deepseekApiKey: string;
  solanaRpcUrl: string;
  courtListenerToken: string;
}

export const MerlinWizard: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const [step, setStep] = useState<number>(1);
  const [config, setConfig] = useState<PartnerConfig>({
    ollamaUrl: "http://127.0.0.1:11434",
    groqApiKey: "",
    togetherApiKey: "",
    deepseekApiKey: "",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    courtListenerToken: ""
  });
  const [testStatus, setTestStatus] = useState<string>("");
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    try {
      const cached = localStorage.getItem("valhalla_partner_config");
      if (cached) {
        setConfig((prev) => ({ ...prev, ...JSON.parse(cached) }));
      }
    } catch (e) {
      console.warn("[MERLIN] Stored configuration unreadable.");
    }

    const handleBridgeResponse = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.action === "OLLAMA_TEST_RESULT") {
        setIsTesting(false);
        setTestStatus(event.data.payload?.success ? "Success! Local Ollama online." : "Ollama offline. Using cloud stack.");
      }
    };

    window.addEventListener("message", handleBridgeResponse);
    return () => window.removeEventListener("message", handleBridgeResponse);
  }, []);

  const sanitizeInput = (val: string) => val.trim().replace(/[\r\n"']/g, "");

  const testLocalOllama = () => {
    setIsTesting(true);
    setTestStatus("Probing local engine...");
    window.postMessage(
      {
        source: "VALHALLA_WEB_DESK",
        action: "TEST_OLLAMA_CONNECTION",
        payload: { url: sanitizeInput(config.ollamaUrl) }
      },
      window.location.origin
    );
  };

  const handleFinish = () => {
    setIsSaving(true);
    const sanitizedConfig: PartnerConfig = {
      ollamaUrl: sanitizeInput(config.ollamaUrl),
      groqApiKey: sanitizeInput(config.groqApiKey),
      togetherApiKey: sanitizeInput(config.togetherApiKey),
      deepseekApiKey: sanitizeInput(config.deepseekApiKey),
      solanaRpcUrl: sanitizeInput(config.solanaRpcUrl),
      courtListenerToken: sanitizeInput(config.courtListenerToken)
    };

    window.postMessage(
      {
        source: "VALHALLA_WEB_DESK",
        action: "MERLIN_UPDATE_PARTNERS",
        payload: sanitizedConfig
      },
      window.location.origin
    );

    try {
      localStorage.setItem("valhalla_partner_config", JSON.stringify(sanitizedConfig));
    } catch (e) {
      console.warn("[MERLIN] Quota exceeded on localStorage.");
    }

    setTimeout(() => {
      setIsSaving(false);
      setStep(4);
    }, 300);
  };

  return (
    <div className="window" style={{ width: 480, maxWidth: "95vw", boxShadow: "3px 3px 12px rgba(0,0,0,0.4)" }}>
      <div className="title-bar">
        <div className="title-bar-text" style={{ fontWeight: "bold" }}>Merlin.exe - Sovereign Setup Wizard 🪄</div>
        <div className="title-bar-controls"><button aria-label="Close" onClick={onClose} /></div>
      </div>

      <div className="window-body" style={{ margin: 10 }}>
        <div style={{ display: "flex", gap: 12, backgroundColor: "#ffffe1", border: "1px solid #000", padding: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 36 }}>🧙‍♂️</div>
          <div style={{ fontSize: 11, color: "#000" }}>
            <strong>Merlin says:</strong>
            <p style={{ margin: "4px 0 0 0" }}>
              {step === 1 && "Configure your local brain. If you have an Ollama instance, I will connect to it for $0 offline compute."}
              {step === 2 && "Add your free cloud API keys (Groq, Together, DeepSeek) to stack hardware when local resources are busy."}
              {step === 3 && "Configure Solana RPC and CourtListener tokens for automated DePIN settlement and legal verification."}
              {step === 4 && "Abracadabra! Your engine is configured and communicating with the 24/7 background beacon."}
            </p>
          </div>
        </div>

        {step === 1 && (
          <fieldset style={{ padding: "10px 12px" }}>
            <legend style={{ fontSize: 11, fontWeight: "bold" }}>Local Brain Setup</legend>
            <div className="field-row-stacked" style={{ marginBottom: 8 }}>
              <label htmlFor="ollamaHost" style={{ fontSize: 11 }}>Ollama Host Address:</label>
              <input id="ollamaHost" type="text" value={config.ollamaUrl} onChange={(e) => setConfig({ ...config, ollamaUrl: e.target.value })} style={{ width: "100%", fontSize: 11 }} />
            </div>
            <div className="field-row" style={{ justifyContent: "space-between" }}>
              <button type="button" onClick={testLocalOllama} disabled={isTesting}>{isTesting ? "Probing..." : "Test Connection"}</button>
              <span style={{ fontSize: 10, color: testStatus.includes("Success") ? "#006400" : "#800000" }}>{testStatus}</span>
            </div>
          </fieldset>
        )}

        {step === 2 && (
          <fieldset style={{ padding: "10px 12px" }}>
            <legend style={{ fontSize: 11, fontWeight: "bold" }}>Cloud GPU Accelerators</legend>
            <div className="field-row-stacked" style={{ marginBottom: 6 }}>
              <label htmlFor="groqKey" style={{ fontSize: 11 }}>Tier 1: High-Speed (Groq API Key):</label>
              <input id="groqKey" type="password" value={config.groqApiKey} onChange={(e) => setConfig({ ...config, groqApiKey: e.target.value })} style={{ width: "100%", fontFamily: "monospace" }} />
            </div>
            <div className="field-row-stacked" style={{ marginBottom: 6 }}>
              <label htmlFor="deepseekKey" style={{ fontSize: 11 }}>Tier 2: Reasoning (DeepSeek API Key):</label>
              <input id="deepseekKey" type="password" value={config.deepseekApiKey} onChange={(e) => setConfig({ ...config, deepseekApiKey: e.target.value })} style={{ width: "100%", fontFamily: "monospace" }} />
            </div>
            <div className="field-row-stacked">
              <label htmlFor="togetherKey" style={{ fontSize: 11 }}>Tier 3: Context (Together AI Key):</label>
              <input id="togetherKey" type="password" value={config.togetherApiKey} onChange={(e) => setConfig({ ...config, togetherApiKey: e.target.value })} style={{ width: "100%", fontFamily: "monospace" }} />
            </div>
          </fieldset>
        )}

        {step === 3 && (
          <fieldset style={{ padding: "10px 12px" }}>
            <legend style={{ fontSize: 11, fontWeight: "bold" }}>Web3 & Legal Providers</legend>
            <div className="field-row-stacked" style={{ marginBottom: 6 }}>
              <label htmlFor="solanaRpc" style={{ fontSize: 11 }}>Solana RPC Provider:</label>
              <input id="solanaRpc" type="text" value={config.solanaRpcUrl} onChange={(e) => setConfig({ ...config, solanaRpcUrl: e.target.value })} style={{ width: "100%" }} />
            </div>
            <div className="field-row-stacked">
              <label htmlFor="courtToken" style={{ fontSize: 11 }}>CourtListener API Token (Raises 5 req/min limit):</label>
              <input id="courtToken" type="password" value={config.courtListenerToken} onChange={(e) => setConfig({ ...config, courtListenerToken: e.target.value })} style={{ width: "100%", fontFamily: "monospace" }} />
            </div>
          </fieldset>
        )}

        {step === 4 && (
          <div style={{ textAlign: "center", padding: "16px 8px" }}>
            <h4 style={{ margin: "0 0 6px 0", color: "#000080" }}>Configuration Complete!</h4>
            <p style={{ fontSize: 11, margin: "0 0 10px 0" }}>Partner keys are active in the local engine. The background beacon is utilizing your hardware stack.</p>
            <button type="button" className="default" onClick={onClose}>Close Wizard</button>
          </div>
        )}

        {step < 4 && (
          <div className="field-row" style={{ justifyContent: "space-between", marginTop: 12 }}>
            <button type="button" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>&lt; Back</button>
            <div style={{ display: "flex", gap: 6 }}>
              {step < 3 ? (
                <button type="button" className="default" onClick={() => setStep(step + 1)}>Next &gt;</button>
              ) : (
                <button type="button" className="default" onClick={handleFinish} disabled={isSaving}>{isSaving ? "Saving..." : "Finish & Save"}</button>
              )}
              <button type="button" onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MerlinWizard;
