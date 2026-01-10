/**
 * Elizagotchi - Virtual Pet Game
 * 
 * Fullscreen, minimal, stylish design.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { PetSprite } from "./components/PetSprite";
import { Poop, Ground, Clouds, Stars } from "./components/GameElements";
import {
  getGameState,
  updateGame,
  executeAction,
  resetGame,
  setGameState,
} from "./game/plugin";
import type { PetState, Action, AnimationType } from "./game/types";
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
  <div className={`stat-pill ${critical ? "critical" : ""} ${value < 25 ? "low" : value < 50 ? "medium" : "good"}`}>
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

const ActionBtn: React.FC<ActionBtnProps> = ({ icon, onClick, disabled, active }) => (
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
  const [petState, setPetState] = useState<PetState>(getGameState);
  const [animation, setAnimation] = useState<AnimationType>("idle");
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState("");
  const [importError, setImportError] = useState("");
  const previousStage = useRef(petState.stage);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Game tick
  useEffect(() => {
    const interval = setInterval(() => {
      const newState = updateGame();
      
      if (newState.stage !== previousStage.current) {
        previousStage.current = newState.stage;
        if (newState.stage !== "dead") {
          setAnimation("evolving");
          setMessage(`✨ Evolved to ${newState.stage}!`);
          setTimeout(() => setAnimation("happy"), 2000);
        } else {
          setMessage(newState.causeOfDeath || "Passed away...");
        }
      }
      
      setPetState(newState);
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  // Clear message after delay
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleAction = useCallback((action: Action) => {
    const result = executeAction(action);
    setPetState(result.state);
    
    if (result.success) {
      setMessage(result.message.split("!")[0] + "!");
      
      switch (action) {
        case "feed":
          setAnimation("eating");
          break;
        case "play":
          setAnimation("playing");
          break;
        case "clean":
          setAnimation("cleaning");
          break;
        case "sleep":
          setAnimation("sleeping");
          break;
        case "medicine":
          setAnimation("happy");
          break;
        default:
          setAnimation("idle");
      }
      
      if (action !== "sleep" && action !== "light_toggle") {
        setTimeout(() => setAnimation("idle"), 2000);
      }
    } else {
      setMessage(result.message);
      setAnimation("refusing");
      setTimeout(() => setAnimation("idle"), 1000);
    }
  }, []);

  const handleReset = useCallback(() => {
    const name = prompt("Name your pet:", "Elizagotchi") || "Elizagotchi";
    const newState = resetGame(name);
    setPetState(newState);
    previousStage.current = "egg";
    setAnimation("idle");
    setMessage(`🥚 ${name} appeared!`);
    setShowSettings(false);
  }, []);

  // Export pet data
  const handleExport = useCallback(() => {
    const data = {
      version: 1,
      pet: petState,
      exportedAt: Date.now(),
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${petState.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage("📦 Exported!");
  }, [petState]);

  // Import pet data
  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = event.target?.result as string;
        const data = JSON.parse(json);
        
        if (!data.pet || !data.pet.name || !data.pet.stage) {
          throw new Error("Invalid save file");
        }
        
        // Restore timestamps relative to now
        const pet: PetState = {
          ...data.pet,
          lastUpdate: Date.now(),
        };
        
        setGameState(pet);
        setPetState(pet);
        previousStage.current = pet.stage;
        setMessage(`📥 Loaded ${pet.name}!`);
        setImportError("");
        setShowSettings(false);
      } catch (err) {
        setImportError("Invalid save file");
      }
    };
    reader.readAsText(file);
    
    // Reset input so same file can be selected again
    e.target.value = "";
  }, []);

  const isNight = !petState.lightsOn;
  const isDead = petState.stage === "dead";
  const isEgg = petState.stage === "egg";

  return (
    <div className={`game ${isNight ? "night" : "day"}`}>
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
          <StatPill icon="🍔" value={petState.stats.hunger} critical={petState.stats.hunger < 20} />
          <StatPill icon="💖" value={petState.stats.happiness} />
          <StatPill icon="⚡" value={petState.stats.energy} />
          <StatPill icon="✨" value={petState.stats.cleanliness} />
          {petState.isSick && <div className="status-badge sick">🤒</div>}
        </div>
        <button className="settings-btn-top" onClick={() => setShowSettings(!showSettings)}>
          ⚙️
        </button>
      </div>

      {/* Pet name & stage */}
      <div className="pet-label">
        <span className="pet-name">{petState.name}</span>
        <span className="pet-stage">{petState.stage}</span>
      </div>

      {/* Message toast */}
      {message && (
        <div className="toast">
          {message}
        </div>
      )}

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
          <div className="settings-content" onClick={e => e.stopPropagation()}>
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
              {importError && <div className="settings-error">{importError}</div>}
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

            <button className="settings-close" onClick={() => setShowSettings(false)}>
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
