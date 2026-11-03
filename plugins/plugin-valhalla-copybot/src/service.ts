import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { startDashboard } from "./dashboard.ts";
import { type AgentEngine, getEngine } from "./engine.ts";
import type { CoinSnapshot, Evaluation } from "./evaluate.ts";
import { liveTradingEnabled } from "./safety-gate.ts";

export const VALHALLA_SERVICE_TYPE = "valhalla_copybot";

export class ValhallaTradingService extends Service {
  static override serviceType = VALHALLA_SERVICE_TYPE;
  override capabilityDescription =
    "Valhalla Mech copy-trading book. Read-only until live is armed. No SOL or token transfers.";

  static async start(runtime: IAgentRuntime): Promise<ValhallaTradingService> {
    const service = new ValhallaTradingService(runtime);
    await service.engine().load();
    if (process.env.VALHALLA_DASHBOARD === "true") {
      const desk = await startDashboard(service.engine());
      logger.info(`[valhalla] desk http://127.0.0.1:${desk.port}`);
    } else {
      logger.info("[valhalla] trading service ready (read-only until live is armed)");
    }
    return service;
  }

  engine(): AgentEngine {
    return getEngine();
  }

  get book() {
    return this.engine().book;
  }

  env(): Record<string, string | undefined> {
    return this.engine().publicEnv();
  }

  live(): boolean {
    return this.engine().liveReady() || liveTradingEnabled(this.env());
  }

  status(): string {
    return this.engine().statusLine();
  }

  startLoop(): string {
    return this.engine().startLoop();
  }

  stopLoop(): string {
    return this.engine().stopLoop();
  }

  async evaluateMint(mint: string): Promise<Evaluation> {
    const message = await this.engine().queueMint(mint);
    return {
      ok: !message.startsWith("Blocked") && !message.startsWith("Scan"),
      reason: message,
      lane: "main",
      sizeSol: 0,
      checks: [],
    };
  }

  async evaluateSnapshot(
    snapshot: CoinSnapshot
  ): Promise<{ ok: boolean; reason: string; evaluation: Evaluation; position: null }> {
    const message = await this.engine().evaluateProvided(snapshot);
    const ok =
      message.startsWith("Paper") || message.startsWith("Live") || message.startsWith("Pass");
    const evaluation: Evaluation = {
      ok,
      reason: message,
      lane: snapshot.lane ?? "main",
      sizeSol: 0,
      checks: [],
    };
    return { ok, reason: message, evaluation, position: null };
  }

  override async stop(): Promise<void> {
    await this.engine().drain();
  }
}

export function getValhallaService(runtime: IAgentRuntime): ValhallaTradingService {
  const service = runtime.getService<ValhallaTradingService>(VALHALLA_SERVICE_TYPE);
  if (!service) throw new Error("Valhalla trading service is not registered.");
  return service;
}
