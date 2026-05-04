import type { TownState } from "../../shared/types";
import { TownEngine } from "../engine/townEngine";
import {
  defaultModelSettings,
  type ModelSettings,
} from "../runtime/modelSettings";
import {
  setAutonomyEnabled,
  stopTownRuntimes,
} from "../simulation/elizaTownRuntime";
import type { MafiaGameState } from "../simulation/mafiaGame";
import type { TownSimulationSnapshot } from "../simulation/townSimulation";
import {
  clearTownState,
  loadModelSettings,
  loadRunningState,
  loadTownSnapshot,
  saveModelSettings,
  saveRunningState,
  saveTownSnapshot,
} from "./townPersistence";

type StoreSubscriber = () => void;

const subscribers = new Set<StoreSubscriber>();

let currentTownState: TownState | null = null;
let currentSettings: ModelSettings = defaultModelSettings();
let engine: TownEngine | null = null;
let initializing: Promise<void> | null = null;
let lastPersistedAt = 0;
let isRunning = false;

const PERSIST_INTERVAL_MS = 5000;

function notifySubscribers(): void {
  for (const listener of subscribers) {
    listener();
  }
}

function handleStateChange(nextState: TownState): void {
  currentTownState = nextState;
  notifySubscribers();
  void persistSnapshotIfNeeded();
}

function handleGameChange(): void {
  notifySubscribers();
  if (engine) {
    void saveTownSnapshot(engine.getSnapshot());
  }
}

async function persistSnapshotIfNeeded(): Promise<void> {
  const now = Date.now();
  if (!engine || !currentTownState) {
    return;
  }
  if (now - lastPersistedAt < PERSIST_INTERVAL_MS) {
    return;
  }
  lastPersistedAt = now;
  const snapshot = engine.getSnapshot();
  await saveTownSnapshot(snapshot);
}

async function restoreSnapshot(): Promise<TownSimulationSnapshot | null> {
  try {
    return await loadTownSnapshot();
  } catch (error) {
    console.warn("Failed to load town snapshot", error);
    return null;
  }
}

async function restoreSettings(): Promise<ModelSettings> {
  try {
    const stored = await loadModelSettings();
    if (stored) {
      return sanitizeSettings(stored);
    }
  } catch (error) {
    console.warn("Failed to load model settings", error);
  }
  return defaultModelSettings();
}

export function subscribe(listener: StoreSubscriber): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function getTownState(): TownState | null {
  return currentTownState;
}

export function getGameState(): MafiaGameState | null {
  if (!engine) {
    return null;
  }
  return engine.getGameState();
}

export function getModelSettings(): ModelSettings {
  return currentSettings;
}

export function getIsRunning(): boolean {
  return isRunning;
}

export async function initializeTownStore(): Promise<void> {
  if (engine) {
    return;
  }
  if (initializing) {
    return initializing;
  }
  initializing = (async () => {
    const [settings, snapshot] = await Promise.all([
      restoreSettings(),
      restoreSnapshot(),
    ]);
    currentSettings = settings;
    engine = new TownEngine({
      settingsProvider: () => currentSettings,
      snapshot,
      onStateChange: handleStateChange,
      onGameChange: handleGameChange,
      tickMode: "continuous",
      attachToTownContext: true,
    });
    currentTownState = engine.getState();
    isRunning = false;
    notifySubscribers();
    const shouldRun = loadRunningState();
    if (shouldRun) {
      setRunning(true);
    }

    window.addEventListener("beforeunload", () => {
      if (!engine) {
        return;
      }
      void saveTownSnapshot(engine.getSnapshot());
    });
  })();

  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

export function setModelSettings(settings: ModelSettings): void {
  currentSettings = sanitizeSettings(settings);
  notifySubscribers();
  void saveModelSettings(currentSettings);
  void stopTownRuntimes();
}

export function setRunning(next: boolean): void {
  if (!engine) {
    void initializeTownStore().then(() => setRunning(next));
    return;
  }
  if (next && !isRunning) {
    console.info("[town] simulation:start", { now: Date.now() });
  }
  if (!next && isRunning) {
    console.info("[town] simulation:pause", { now: Date.now() });
  }
  isRunning = next;
  saveRunningState(isRunning);
  notifySubscribers();
  if (isRunning) {
    setAutonomyEnabled(true);
    engine.start();
  } else {
    setAutonomyEnabled(false);
    engine.stop();
    void stopTownRuntimes();
  }
}

export function toggleRunning(): void {
  setRunning(!isRunning);
}

export async function resetTownState(): Promise<void> {
  if (!engine) {
    await initializeTownStore();
  }
  if (!engine) {
    return;
  }
  isRunning = false;
  saveRunningState(false);
  notifySubscribers();
  engine.stop();
  await stopTownRuntimes();
  await clearTownState();
  engine = new TownEngine({
    settingsProvider: () => currentSettings,
    snapshot: null,
    onStateChange: handleStateChange,
    onGameChange: handleGameChange,
    tickMode: "continuous",
    attachToTownContext: true,
  });
  currentTownState = engine.getState();
  notifySubscribers();
}

export function startGameRound(): void {
  if (!engine) {
    void initializeTownStore().then(() => startGameRound());
    return;
  }
  if (!isRunning) {
    setRunning(true);
  }
  const phase = engine.getGameState().phase;
  if (phase === "setup" || phase === "ended") {
    engine.startGameRound();
  }
}

export function pauseGame(paused: boolean): void {
  if (!engine) {
    return;
  }
  engine.pauseGame(paused);
}

export function resetGame(): void {
  if (!engine) {
    return;
  }
  engine.resetGame();
}

export function advanceGamePhase(): void {
  if (!engine) {
    return;
  }
  engine.advanceGamePhase();
}

function sanitizeSettings(settings: ModelSettings): ModelSettings {
  const defaults = defaultModelSettings();
  const provider = settings.provider;
  return {
    ...defaults,
    provider,
    openai: { ...defaults.openai, ...settings.openai },
    anthropic: { ...defaults.anthropic, ...settings.anthropic },
    google: { ...defaults.google, ...settings.google },
    groq: { ...defaults.groq, ...settings.groq },
    xai: { ...defaults.xai, ...settings.xai },
    local: { ...defaults.local, ...settings.local },
  };
}
