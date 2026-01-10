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
} from "./game/plugin";
import type { PetState, Action, AnimationType } from "./game/types";
import "./App.css";

// ============================================================================
// STAT INDICATOR (minimal pill overlay)
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
  const previousStage = useRef(petState.stage);

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

  const isNight = !petState.lightsOn;
  const isDead = petState.stage === "dead";
  const isEgg = petState.stage === "egg";

  return (
    <div className={`game ${isNight ? "night" : "day"}`}>
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

      {/* Stats overlay (top) */}
      <div className="stats-overlay">
        <StatPill icon="🍔" value={petState.stats.hunger} critical={petState.stats.hunger < 20} />
        <StatPill icon="💖" value={petState.stats.happiness} />
        <StatPill icon="⚡" value={petState.stats.energy} />
        <StatPill icon="✨" value={petState.stats.cleanliness} />
        {petState.isSick && <div className="status-badge sick">🤒</div>}
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
          icon="⚙️"
          onClick={() => setShowSettings(!showSettings)}
        />
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="settings-panel" onClick={() => setShowSettings(false)}>
          <div className="settings-content" onClick={e => e.stopPropagation()}>
            <h3>Settings</h3>
            <button className="settings-btn" onClick={handleReset}>
              🥚 New Pet
            </button>
            <button className="settings-btn" onClick={() => handleAction("light_toggle")}>
              {petState.lightsOn ? "🌙 Lights Off" : "☀️ Lights On"}
            </button>
            <div className="settings-info">
              <p>Age: {getAge(petState)}</p>
              <p>Health: {Math.round(petState.stats.health)}%</p>
              <p>Discipline: {Math.round(petState.stats.discipline)}%</p>
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
