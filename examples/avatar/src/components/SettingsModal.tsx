import { useCallback } from "react";
import type { DemoConfig, DemoMode, VoiceOutputProvider } from "../runtime/types";

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  config: DemoConfig;
  onConfigChange: (patch: (prev: DemoConfig) => DemoConfig) => void;
  effectiveMode: DemoMode;
  onResetConversation: () => void;
};

function modeLabel(mode: DemoMode): string {
  switch (mode) {
    case "elizaClassic":
      return "ELIZA classic (offline)";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "xai":
      return "xAI (Grok)";
    case "gemini":
      return "Gemini";
    case "groq":
      return "Groq";
    default:
      return "ELIZA classic (offline)";
  }
}

export function SettingsModal({
  isOpen,
  onClose,
  config,
  onConfigChange,
  effectiveMode,
  onResetConversation,
}: SettingsModalProps) {
  const updateConfig = useCallback(
    (patch: (prev: DemoConfig) => DemoConfig) => {
      onConfigChange(patch);
    },
    [onConfigChange],
  );

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-section">
            <h3>Provider</h3>
            <div className="field">
              <label>Active Mode</label>
              <select
                value={config.mode}
                onChange={(e) => {
                  const mode = e.currentTarget.value as DemoMode;
                  updateConfig((prev) => ({ ...prev, mode }));
                }}
              >
                <option value="elizaClassic">{modeLabel("elizaClassic")}</option>
                <option value="openai">{modeLabel("openai")}</option>
                <option value="anthropic">{modeLabel("anthropic")}</option>
                <option value="xai">{modeLabel("xai")}</option>
                <option value="gemini">{modeLabel("gemini")}</option>
                <option value="groq">{modeLabel("groq")}</option>
              </select>
            </div>
            <div className="field-note">
              <span className={`dot ${effectiveMode === "elizaClassic" ? "warn" : "good"}`} />
              Using: <strong>{modeLabel(effectiveMode)}</strong>
            </div>
          </div>

          {config.mode === "openai" && (
            <div className="settings-section">
              <h3>OpenAI Settings</h3>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={config.provider.openaiApiKey}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    updateConfig((p) => ({
                      ...p,
                      provider: { ...p.provider, openaiApiKey: value },
                    }));
                  }}
                  placeholder="sk-..."
                />
              </div>
            </div>
          )}

          {config.mode === "anthropic" && (
            <div className="settings-section">
              <h3>Anthropic Settings</h3>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={config.provider.anthropicApiKey}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    updateConfig((p) => ({
                      ...p,
                      provider: { ...p.provider, anthropicApiKey: value },
                    }));
                  }}
                  placeholder="sk-ant-..."
                />
              </div>
            </div>
          )}

          {config.mode === "xai" && (
            <div className="settings-section">
              <h3>xAI Settings</h3>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={config.provider.xaiApiKey}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    updateConfig((p) => ({
                      ...p,
                      provider: { ...p.provider, xaiApiKey: value },
                    }));
                  }}
                />
              </div>
            </div>
          )}

          {config.mode === "gemini" && (
            <div className="settings-section">
              <h3>Gemini Settings</h3>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={config.provider.googleGenaiApiKey}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    updateConfig((p) => ({
                      ...p,
                      provider: { ...p.provider, googleGenaiApiKey: value },
                    }));
                  }}
                />
              </div>
            </div>
          )}

          {config.mode === "groq" && (
            <div className="settings-section">
              <h3>Groq Settings</h3>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={config.provider.groqApiKey}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    updateConfig((p) => ({
                      ...p,
                      provider: { ...p.provider, groqApiKey: value },
                    }));
                  }}
                  placeholder="gsk_..."
                />
              </div>
            </div>
          )}

          <div className="settings-section">
            <h3>Voice Output</h3>
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.voiceOutputEnabled}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  updateConfig((p) => ({ ...p, voiceOutputEnabled: checked }));
                }}
              />
              Enable voice output
            </label>

            {config.voiceOutputEnabled && (
              <div className="sam-tuning">
                <div className="field">
                  <label>Voice Provider</label>
                  <select
                    value={config.voiceOutputProvider}
                    onChange={(e) => {
                      const value = e.currentTarget.value as VoiceOutputProvider;
                      updateConfig((p) => ({ ...p, voiceOutputProvider: value }));
                    }}
                  >
                    <option value="sam">Robot (SAM)</option>
                    <option value="elevenlabs">ElevenLabs</option>
                  </select>
                </div>

                {config.voiceOutputProvider === "elevenlabs" && (
                  <div className="field">
                    <label>ElevenLabs API Key</label>
                    <input
                      type="password"
                      value={config.provider.elevenlabsApiKey}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        updateConfig((p) => ({
                          ...p,
                          provider: { ...p.provider, elevenlabsApiKey: value },
                        }));
                      }}
                      placeholder="el_..."
                    />
                  </div>
                )}

                <div className="field-row">
                  <div className="field">
                    <label>Speed ({config.sam.speed})</label>
                    <input
                      type="range"
                      min={20}
                      max={200}
                      value={config.sam.speed}
                      onChange={(e) => {
                        const value = Number(e.currentTarget.value);
                        updateConfig((p) => ({
                          ...p,
                          sam: { ...p.sam, speed: value },
                        }));
                      }}
                    />
                  </div>
                  <div className="field">
                    <label>Pitch ({config.sam.pitch})</label>
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={config.sam.pitch}
                      onChange={(e) => {
                        const value = Number(e.currentTarget.value);
                        updateConfig((p) => ({
                          ...p,
                          sam: { ...p.sam, pitch: value },
                        }));
                      }}
                    />
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Throat ({config.sam.throat})</label>
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={config.sam.throat}
                      onChange={(e) => {
                        const value = Number(e.currentTarget.value);
                        updateConfig((p) => ({
                          ...p,
                          sam: { ...p.sam, throat: value },
                        }));
                      }}
                    />
                  </div>
                  <div className="field">
                    <label>Mouth ({config.sam.mouth})</label>
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={config.sam.mouth}
                      onChange={(e) => {
                        const value = Number(e.currentTarget.value);
                        updateConfig((p) => ({
                          ...p,
                          sam: { ...p.sam, mouth: value },
                        }));
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="settings-section">
            <h3>Conversation</h3>
            <button className="reset-conversation-button" onClick={onResetConversation}>
              Reset conversation
            </button>
            <div className="field-note" style={{ marginTop: 8 }}>
              This clears your chat history and starts a new session
            </div>
          </div>

          <div className="settings-note">
            <strong>Note:</strong> API keys are stored in your browser&apos;s localStorage and used client-side only.
          </div>
        </div>
      </div>
    </div>
  );
}
