import type { TownState } from "../../shared/types";
import type { ModelSettings } from "../runtime/modelSettings.ts";
import type {
  MafiaGameState,
  MafiaGameUpdate,
} from "../simulation/mafiaGame.ts";
import { setTownSimulation } from "../simulation/townContext.ts";
import {
  TownSimulation,
  type TownSimulationSnapshot,
} from "../simulation/townSimulation.ts";

type TickMode = "continuous" | "interval";

export type TownEngineOptions = {
  settingsProvider: () => ModelSettings;
  snapshot?: TownSimulationSnapshot | null;
  onStateChange?: (state: TownState) => void;
  onGameChange?: (state: MafiaGameState) => void;
  tickIntervalMs?: number;
  frameIntervalMs?: number;
  tickMode?: TickMode;
  attachToTownContext?: boolean;
};

export class TownEngine {
  private simulation: TownSimulation;
  private options: TownEngineOptions;
  private running = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private lastState: TownState | null = null;
  private lastGameState: MafiaGameState | null = null;

  constructor(options: TownEngineOptions) {
    this.options = options;
    this.simulation = new TownSimulation(
      options.settingsProvider,
      options.snapshot ?? null,
    );
    const attach = options.attachToTownContext ?? true;
    if (attach) {
      setTownSimulation(this.simulation);
    }
    this.lastState = this.simulation.getState();
    this.lastGameState = this.simulation.getGameState();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextTick();
    this.startFrameLoop();
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  startGameRound(): MafiaGameUpdate {
    const update = this.simulation.startGameRound();
    this.emitGameState();
    return update;
  }

  pauseGame(paused: boolean): MafiaGameUpdate {
    const update = this.simulation.pauseGame(paused);
    this.emitGameState();
    return update;
  }

  resetGame(): MafiaGameUpdate {
    const update = this.simulation.resetGame();
    this.emitGameState();
    return update;
  }

  advanceGamePhase(): MafiaGameUpdate {
    const update = this.simulation.advanceGamePhase();
    this.emitGameState();
    return update;
  }

  getState(): TownState {
    return this.simulation.getState();
  }

  getGameState(): MafiaGameState {
    return this.simulation.getGameState();
  }

  getSnapshot(): TownSimulationSnapshot {
    return this.simulation.getSnapshot();
  }

  async stepTick(): Promise<TownState> {
    return this.runTick({ force: true });
  }

  stepFrame(now = Date.now()): TownState {
    const nextState = this.simulation.updateFrame(now);
    this.emitState(nextState);
    return nextState;
  }

  private scheduleNextTick(): void {
    if (!this.running) {
      return;
    }
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    const interval =
      this.options.tickIntervalMs ?? this.simulation.getTickIntervalMs();
    const tickMode = this.options.tickMode ?? "continuous";
    const delay = tickMode === "continuous" ? 0 : interval;
    this.tickTimer = setTimeout(() => {
      void this.runTick();
    }, delay);
  }

  private startFrameLoop(): void {
    if (this.frameTimer) {
      return;
    }
    const interval = this.options.frameIntervalMs ?? 1000 / 30;
    if (interval <= 0) {
      return;
    }
    this.frameTimer = setInterval(() => {
      if (!this.running) {
        return;
      }
      const nextState = this.simulation.updateFrame(Date.now());
      this.emitState(nextState);
    }, interval);
  }

  private async runTick(options?: { force?: boolean }): Promise<TownState> {
    if (this.tickInFlight) {
      return this.simulation.getState();
    }
    if (!this.running && !options?.force) {
      return this.simulation.getState();
    }
    this.tickInFlight = true;
    try {
      const nextState = await this.simulation.tick();
      this.emitState(nextState);
      this.emitGameState();
      return nextState;
    } finally {
      this.tickInFlight = false;
      if (this.running) {
        this.scheduleNextTick();
      }
    }
  }

  private emitState(nextState: TownState): void {
    if (this.lastState !== nextState) {
      this.lastState = nextState;
      this.options.onStateChange?.(nextState);
    }
  }

  private emitGameState(): void {
    const nextGameState = this.simulation.getGameState();
    if (this.lastGameState !== nextGameState) {
      this.lastGameState = nextGameState;
      this.options.onGameChange?.(nextGameState);
    }
  }
}
