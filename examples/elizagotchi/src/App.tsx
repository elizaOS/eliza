/**
 * Elizagotchi - Virtual Pet Game
 *
 * Fullscreen, minimal, stylish design.
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Clouds, Ground, Poop, Stars } from "./components/GameElements";
import { PetSprite } from "./components/PetSprite";
import {
  type ElizagotchiAgentLogEntry,
  sendElizagotchiCommand,
  subscribeElizagotchiAgentLog,
  subscribeElizagotchiState,
} from "./game/agent";
import type { Action, AnimationType, PetState } from "./game/types";
import "./App.css";

// ============================================================================
// STAT INDICATOR
// ============================================================================

interface StatPillProps {
  icon: string;
  value: number;
  critical?: boolean;
}

const StatPill: React.FC<StatPillProps> = ({ icon, value, critical }) => (
  <div
    className={`stat-pill ${critical ? "critical" : ""} ${value < 25 ? "low" : value < 50 ? "medium" : "good"}`}
  >
    <span className="stat-pill-icon">{icon}</span>
    <div className="stat-pill-bar">
      <div className="stat-pill-fill" style={{ width: `${value}%` }} />
    </div>
  </div>
);

// ============================================================================
// ACTION BUTTON
// ============================================================================

interface ActionBtnProps {
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

const ActionBtn: React.FC<ActionBtnProps> = ({
  icon,
  onClick,
  disabled,
  active,
}) => (
  <button
    className={`action-btn ${active ? "active" : ""}`}
    onClick={onClick}
    disabled={disabled}
  >
    {icon}
  </button>
);

// ============================================================================
// MAIN APP
// ============================================================================

function App() {
  const [petState, setPetState] = useState<PetState | null>(null);
  const [animation, setAnimation] = useState<AnimationType>("idle");
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [agentLogEnabled, setAgentLogEnabled] = useState(false);
  const [agentLog, setAgentLog] = useState<ElizagotchiAgentLogEntry[]>([]);
  const previousStage = useRef<PetState["stage"] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const agentLogEnabledRef = useRef(agentLogEnabled);

  useEffect(() => {
    agentLogEnabledRef.current = agentLogEnabled;
  }, [agentLogEnabled]);

  // Agent-driven state subscription (pet state lives inside runtime)
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      unsubscribe = await subscribeElizagotchiState((payload) => {
        if (cancelled) return;
        const newState = payload.petState;

        if (
          previousStage.current !== null &&
          newState.stage !== previousStage.current
        ) {
          previousStage.current = newState.stage;
          if (newState.stage !== "dead") {
            setAnimation("evolving");
            setMessage(`✨ Evolved to ${newState.stage}!`);
            setTimeout(() => setAnimation("happy"), 2000);
          } else {
            setMessage(newState.causeOfDeath || "Passed away...");
          }
        }

        if (previousStage.current === null) {
          previousStage.current = newState.stage;
        }
        setPetState(newState);
      });

      // Ensure we have an immediate snapshot even if the first tick emitted before subscribing.
      await sendElizagotchiCommand("__tick__");
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Optional: show internal eliza action execution as a dev overlay
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      unsubscribe = await subscribeElizagotchiAgentLog((entry) => {
        if (cancelled) return;
        if (!agentLogEnabledRef.current) return;
        setAgentLog((prev) => [entry, ...prev].slice(0, 60));
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Clear message after delay
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleAction = useCallback(async (action: Action) => {
    const event = await sendElizagotchiCommand(action);

    // Prefer agent-specified animation, fallback to local mapping
    const nextAnimation =
      event && typeof event.animation === "string"
        ? (event.animation as AnimationType)
        : action === "feed"
          ? "eating"
          : action === "play"
            ? "playing"
            : action === "clean"
              ? "cleaning"
              : action === "sleep"
                ? "sleeping"
                : action === "medicine"
                  ? "happy"
                  : "idle";

    setAnimation(nextAnimation);

    const text = event?.text;
    if (typeof text === "string" && text.trim() !== "") {
      // Keep the toast short for UI; game engine messages often end with emoji.
      setMessage(text.split("\n")[0]);
    }

    if (action !== "sleep" && action !== "light_toggle") {
      setTimeout(() => setAnimation("idle"), 2000);
    }
  }, []);

  const handleReset = useCallback(() => {
    (async () => {
      const name = prompt("Name your pet:", "Elizagotchi") || "Elizagotchi";
      await sendElizagotchiCommand(`__reset__:${encodeURIComponent(name)}`);
      previousStage.current = "egg";
      setAnimation("idle");
      setMessage(`🥚 ${name} appeared!`);
      setShowSettings(false);
    })();
  }, []);

  // Export pet data
  const handleExport = useCallback(() => {
    (async () => {
      if (!petState) return;
      const event = await sendElizagotchiCommand("__export__");
      const saveData = event?.saveData;
      if (!saveData) {
        setMessage("Export failed");
        return;
      }

      const json = JSON.stringify(saveData, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${petState.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage("📦 Exported!");
    })();
  }, [petState]);

  // Import pet data
  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        void (async () => {
          const raw = event.target?.result;
          if (typeof raw !== "string") {
            throw new Error("Invalid save file");
          }

          // Route through agent (state is stored inside runtime)
          const encoded = encodeURIComponent(raw);
          const result = await sendElizagotchiCommand(`__import__:${encoded}`);
          const loaded = result?.petState;
          if (loaded) {
            previousStage.current = loaded.stage;
            setMessage(`📥 Loaded ${loaded.name}!`);
            setImportError("");
            setShowSettings(false);
          } else {
            setImportError("Invalid save file");
          }
        })().catch(() => setImportError("Invalid save file"));
      };
      reader.readAsText(file);

      // Reset input so same file can be selected again
      e.target.value = "";
    },
    [],
  );

  if (!petState) {
    return (
      <div className="game day">
        <div className="toast">Initializing Elizagotchi agent…</div>
      </div>
    );
  }

  const isNight = !petState.lightsOn;
  const isDead = petState.stage === "dead";
  const isEgg = petState.stage === "egg";

  return (
    <div className={`game ${isNight ? "night" : "day"}`}>
      {/* Agent log overlay (enable/disable in Settings) */}
      {agentLogEnabled && (
        <div className="agent-log">
          <div className="agent-log-header">
            <div className="agent-log-title">Agent log</div>
            <div className="agent-log-actions">
              <button
                className="agent-log-btn"
                onClick={() => setAgentLog([])}
                type="button"
              >
                Clear
              </button>
              <button
                className="agent-log-btn"
                onClick={() => setAgentLogEnabled(false)}
                type="button"
              >
                Hide
              </button>
            </div>
          </div>
          <div className="agent-log-list" role="log" aria-live="polite">
            {agentLog.length === 0 ? (
              <div className="agent-log-empty">No actions yet.</div>
            ) : (
              agentLog.map((e) => (
                <div key={e.id} className="agent-log-entry">
                  <div className="agent-log-meta">
                    <span className="agent-log-kind">{e.kind}</span>
                    <span className="agent-log-action">{e.action}</span>
                    {e.status && (
                      <span className="agent-log-status">{e.status}</span>
                    )}
                  </div>
                  {e.text && <div className="agent-log-text">{e.text}</div>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />

      {/* Background */}
      <div className="bg-layer">
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
          {isNight ? <Stars /> : <Clouds />}
          <Ground isNight={isNight} />
        </svg>
      </div>

      {/* Poop layer */}
      {petState.poop > 0 && (
        <div className="poop-layer">
          {petState.poop >= 1 && <Poop x={15} y={75} size={20} />}
          {petState.poop >= 2 && <Poop x={80} y={78} size={16} />}
          {petState.poop >= 3 && <Poop x={30} y={82} size={14} />}
          {petState.poop >= 4 && <Poop x={65} y={72} size={18} />}
        </div>
      )}

      {/* Pet */}
      <div className={`pet-layer ${animation}`}>
        <PetSprite
          stage={petState.stage}
          mood={petState.mood}
          animation={animation}
          isSleeping={petState.isSleeping}
        />
      </div>

      {/* Top bar: Stats + Settings */}
      <div className="top-bar">
        <div className="stats-overlay">
          <StatPill
            icon="🍔"
            value={petState.stats.hunger}
            critical={petState.stats.hunger < 20}
          />
          <StatPill icon="💖" value={petState.stats.happiness} />
          <StatPill icon="⚡" value={petState.stats.energy} />
          <StatPill icon="✨" value={petState.stats.cleanliness} />
          {petState.isSick && <div className="status-badge sick">🤒</div>}
        </div>
        <button
          className="settings-btn-top"
          onClick={() => setShowSettings(!showSettings)}
        >
          ⚙️
        </button>
      </div>

      {/* Pet name & stage */}
      <div className="pet-label">
        <span className="pet-name">{petState.name}</span>
        <span className="pet-stage">{petState.stage}</span>
      </div>

      {/* Message toast */}
      {message && <div className="toast">{message}</div>}

      {/* Actions (bottom) */}
      <div className="actions-bar">
        <ActionBtn
          icon="🍔"
          onClick={() => handleAction("feed")}
          disabled={isDead || isEgg}
        />
        <ActionBtn
          icon="🎮"
          onClick={() => handleAction("play")}
          disabled={isDead || isEgg || petState.isSleeping}
        />
        <ActionBtn
          icon="🧹"
          onClick={() => handleAction("clean")}
          disabled={isDead || isEgg}
        />
        <ActionBtn
          icon={petState.isSleeping ? "☀️" : "😴"}
          onClick={() => {
            if (petState.isSleeping) {
              handleAction("light_toggle");
            } else if (!petState.lightsOn) {
              handleAction("sleep");
            } else {
              handleAction("light_toggle");
            }
          }}
          disabled={isDead || isEgg}
          active={petState.isSleeping}
        />
        <ActionBtn
          icon="💊"
          onClick={() => handleAction("medicine")}
          disabled={isDead || !petState.isSick}
        />
        <ActionBtn
          icon={petState.lightsOn ? "💡" : "🌙"}
          onClick={() => handleAction("light_toggle")}
          disabled={isDead}
          active={!petState.lightsOn}
        />
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="settings-panel" onClick={() => setShowSettings(false)}>
          <div
            className="settings-content"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Settings</h3>

            <div className="settings-section">
              <button className="settings-action" onClick={handleReset}>
                🥚 New Pet
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Save / Load</div>
              <button className="settings-action" onClick={handleExport}>
                📤 Export Pet
              </button>
              <button className="settings-action" onClick={handleImport}>
                📥 Import Pet
              </button>
              {importError && (
                <div className="settings-error">{importError}</div>
              )}
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Developer</div>
              <button
                className="settings-action"
                onClick={() => setAgentLogEnabled((v) => !v)}
                type="button"
              >
                {agentLogEnabled ? "🧠 Agent log: On" : "🧠 Agent log: Off"}
              </button>
              {agentLogEnabled && (
                <button
                  className="settings-action"
                  onClick={() => setAgentLog([])}
                  type="button"
                >
                  🧹 Clear Agent Log
                </button>
              )}
            </div>

            <div className="settings-info">
              <div className="info-row">
                <span>Age</span>
                <span>{getAge(petState)}</span>
              </div>
              <div className="info-row">
                <span>Health</span>
                <span>{Math.round(petState.stats.health)}%</span>
              </div>
              <div className="info-row">
                <span>Discipline</span>
                <span>{Math.round(petState.stats.discipline)}%</span>
              </div>
              <div className="info-row">
                <span>Personality</span>
                <span>{petState.personality}</span>
              </div>
            </div>

            <button
              className="settings-close"
              onClick={() => setShowSettings(false)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Attention pulse */}
      {petState.needsAttention && !petState.isSleeping && !isDead && (
        <div className="attention-pulse" />
      )}
    </div>
  );
}

function getAge(state: PetState): string {
  const ms = Date.now() - state.birthTime;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export default App;
