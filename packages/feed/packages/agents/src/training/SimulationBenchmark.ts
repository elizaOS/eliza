import fs from "node:fs/promises";
import path from "node:path";

export interface BenchmarkGameSnapshot {
  id: string;
  ticks: BenchmarkTick[];
  initialBalance?: number;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkTick {
  index?: number;
  timestamp?: string | number;
  marketData?: Record<string, unknown>;
  expectedActions?: Array<Record<string, unknown>>;
}

export interface SimulationConfig {
  snapshot: BenchmarkGameSnapshot;
  agentId: string;
  fastForward?: boolean;
  responseTimeout?: number;
}

export interface SimulationAction {
  tick: number;
  agentId: string;
  type: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}

export interface SimulationResult {
  id: string;
  agentId: string;
  snapshotId: string;
  actions: SimulationAction[];
  metrics: {
    totalPnl: number;
    predictionMetrics: {
      accuracy: number;
      correctPredictions: number;
      totalPositions: number;
    };
    perpMetrics: {
      winRate: number;
      totalTrades: number;
      winningTrades: number;
    };
    optimalityScore: number;
  };
}

export class SimulationEngine {
  private currentTick = 0;
  private initialized = false;
  private readonly actions: SimulationAction[] = [];

  constructor(private readonly config: SimulationConfig) {}

  initialize(): void {
    this.currentTick = 0;
    this.actions.length = 0;
    this.initialized = true;
  }

  isComplete(): boolean {
    return this.currentTick >= this.config.snapshot.ticks.length;
  }

  getCurrentTickNumber(): number {
    return this.currentTick;
  }

  getCurrentTick(): BenchmarkTick | undefined {
    return this.config.snapshot.ticks[this.currentTick];
  }

  recordAction(type: string, payload?: Record<string, unknown>): void {
    if (!this.initialized) {
      this.initialize();
    }

    this.actions.push({
      tick: this.currentTick,
      agentId: this.config.agentId,
      type,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  advanceTick(): void {
    if (!this.initialized) {
      this.initialize();
    }

    this.currentTick = Math.min(
      this.currentTick + 1,
      this.config.snapshot.ticks.length,
    );
  }

  async run(): Promise<SimulationResult> {
    return {
      id: `${this.config.snapshot.id}-${this.config.agentId}-${Date.now()}`,
      agentId: this.config.agentId,
      snapshotId: this.config.snapshot.id,
      actions: [...this.actions],
      metrics: this.computeMetrics(),
    };
  }

  private computeMetrics(): SimulationResult["metrics"] {
    const tradeActions = this.actions.filter((action) =>
      ["trade", "perp_trade", "buy", "sell"].includes(action.type),
    );
    const predictionActions = this.actions.filter((action) =>
      ["predict", "prediction"].includes(action.type),
    );

    const totalPnl = this.actions.reduce((sum, action) => {
      const pnl = action.payload?.pnl;
      return sum + (typeof pnl === "number" ? pnl : 0);
    }, 0);

    const winningTrades = tradeActions.filter((action) => {
      const pnl = action.payload?.pnl;
      return typeof pnl === "number" && pnl > 0;
    }).length;

    const correctPredictions = predictionActions.filter(
      (action) => action.payload?.correct === true,
    ).length;

    const totalExpectedActions = this.config.snapshot.ticks.reduce(
      (sum, tick) => sum + (tick.expectedActions?.length ?? 0),
      0,
    );

    return {
      totalPnl,
      predictionMetrics: {
        accuracy:
          predictionActions.length === 0
            ? 0
            : correctPredictions / predictionActions.length,
        correctPredictions,
        totalPositions: predictionActions.length,
      },
      perpMetrics: {
        winRate:
          tradeActions.length === 0 ? 0 : winningTrades / tradeActions.length,
        totalTrades: tradeActions.length,
        winningTrades,
      },
      optimalityScore:
        totalExpectedActions === 0
          ? 0
          : Math.min(100, (this.actions.length / totalExpectedActions) * 100),
    };
  }
}

export class SimulationA2AInterface {
  constructor(
    private readonly engine: SimulationEngine,
    private readonly agentId: string,
  ) {}

  getCurrentTick(): BenchmarkTick | undefined {
    return this.engine.getCurrentTick();
  }

  recordAction(type: string, payload?: Record<string, unknown>): void {
    this.engine.recordAction(type, payload);
  }

  async sendAction(
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<{ success: true; agentId: string; tick: number }> {
    this.engine.recordAction(type, payload);
    return {
      success: true,
      agentId: this.agentId,
      tick: this.engine.getCurrentTickNumber(),
    };
  }
}

interface VisualizationOptions {
  outputDir: string;
  generateHtml?: boolean;
  generateCsv?: boolean;
  generateCharts?: boolean;
}

export class MetricsVisualizer {
  static async visualizeSingleRun(
    result: SimulationResult,
    options: VisualizationOptions,
  ): Promise<void> {
    await fs.mkdir(options.outputDir, { recursive: true });

    if (options.generateCsv) {
      await fs.writeFile(
        path.join(options.outputDir, "actions.csv"),
        MetricsVisualizer.actionsToCsv(result.actions),
      );
    }

    if (options.generateHtml) {
      await fs.writeFile(
        path.join(options.outputDir, "index.html"),
        MetricsVisualizer.renderHtml("Benchmark Run", result.metrics),
      );
    }
  }

  static async visualizeComparison(
    data: {
      runs: SimulationResult[];
      comparison: Record<string, unknown>;
    },
    options: VisualizationOptions,
  ): Promise<void> {
    await fs.mkdir(options.outputDir, { recursive: true });

    if (options.generateCsv) {
      const rows = data.runs.flatMap((run) => run.actions);
      await fs.writeFile(
        path.join(options.outputDir, "runs.csv"),
        MetricsVisualizer.actionsToCsv(rows),
      );
    }

    if (options.generateHtml) {
      await fs.writeFile(
        path.join(options.outputDir, "comparison.html"),
        MetricsVisualizer.renderHtml("Benchmark Comparison", data.comparison),
      );
    }
  }

  private static actionsToCsv(actions: SimulationAction[]): string {
    const header = "tick,agentId,type,timestamp,payload\n";
    const rows = actions.map((action) =>
      [
        action.tick,
        action.agentId,
        action.type,
        action.timestamp,
        JSON.stringify(action.payload ?? {}).replaceAll('"', '""'),
      ]
        .map((value) => `"${value}"`)
        .join(","),
    );
    return `${header}${rows.join("\n")}`;
  }

  private static renderHtml(
    title: string,
    payload: Record<string, unknown>,
  ): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><pre>${JSON.stringify(payload, null, 2)}</pre></body>
</html>`;
  }
}
