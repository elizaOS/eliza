import { ModelStackRouter } from "./modelRouter";
import { CrossSpeechEngine } from "./crossSpeechEngine";
import { EmailNotifier } from "./emailNotifier";

export interface OverseerConfig {
  checkIntervalMs?: number;
  autoHealEnabled?: boolean;
}

/**
 * AutonomousSystemOverseer
 * 
 * Interweaves:
 *  - DeepSeek Reasoning / Code Repair
 *  - Google Gemini 2.0 Flash
 *  - Perplexity Real-time Web Grounding
 *  - ElizaOS Brain Core
 *  - Automated Email Alerts
 * 
 * Runs independently idle without requiring active user control.
 */
export class AutonomousSystemOverseer {
  private router: ModelStackRouter;
  private crossSpeech: CrossSpeechEngine;
  private notifier: EmailNotifier;
  private isRunning = false;
  private intervalMs: number;
  private cycleCount = 0;

  constructor(config: OverseerConfig = {}) {
    this.router = new ModelStackRouter();
    this.crossSpeech = new CrossSpeechEngine();
    this.notifier = new EmailNotifier();
    this.intervalMs = config.checkIntervalMs || 120_000; // 2 minute idle loop
  }

  startAutonomousLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("=================================================================");
    console.log("  VALHALLA AUTONOMOUS OVERSEER ACTIVE                            ");
    console.log("  Interweaving: DeepSeek + Gemini + Perplexity + ElizaOS Brain   ");
    console.log("  Self-Sustaining Mode: IDLE INDEPENDENT EXECUTION               ");
    console.log("=================================================================");
    this.runCycle();
  }

  stopAutonomousLoop(): void {
    this.isRunning = false;
  }

  private async runCycle(): Promise<void> {
    if (!this.isRunning) return;
    this.cycleCount++;

    try {
      console.log(`\n[AUTONOMOUS CYCLE #${this.cycleCount}] Evaluating system heartbeat and drift...`);

      // 1. A2A Cross-Speech Health Exchange between Zeus (Gemini), Gorgo (Repair), and Hermes (Perplexity)
      const speechExchanges = await this.crossSpeech.executeA2ACrossSpeech(
        "NETWORK_HEALTH",
        "Autonomous scheduled heartbeat check for Solana DePIN RPC and memory vault"
      );

      console.log(`[A2A BUS ACTIVE] Cross-speech dialogue cycles exchanged: ${speechExchanges.length}`);

      // 2. Synthesize health & drift analysis using ModelStackRouter
      const diagnosis = await this.router.routePrompt(
        "Perform rapid automated audit of active background processes, websocket swarm bridge, and DePIN lamport splits.",
        { tier: "fast" }
      );

      console.log(`[AUTONOMOUS DIAGNOSIS] Grounded via ${diagnosis.provider}: ${diagnosis.content.substring(0, 120)}...`);

      // 3. Autonomous Repair / Drift Remediation
      const hasDrift = diagnosis.content.toLowerCase().includes("degraded") || diagnosis.content.toLowerCase().includes("reconnect");

      if (hasDrift) {
        console.warn("[DRIFT DETECTED] Dispatching DeepSeek code and state repair sequence...");
        await this.crossSpeech.executeA2ACrossSpeech(
          "REPAIR_DISPATCH",
          "Automated self-healing triggered: reconnecting broken bridge routes and resetting local memory indices"
        );

        // Notify Administrator by Email on repair action
        await this.notifier.sendEmail({
          subject: "Autonomous Self-Repair Dispatched",
          level: "REPAIR_ALERT",
          body: `Valhalla Autonomous Overseer detected network drift during Cycle #${this.cycleCount}.\n\nDeepSeek repair engine and Gorgo ACP have reconciled the state.\n\nDiagnosis summary:\n${diagnosis.content}`,
        });
      } else if (this.cycleCount % 30 === 0) {
        // Send periodic heartbeat email every hour
        await this.notifier.sendEmail({
          subject: `Autonomous Heartbeat Report (Cycle #${this.cycleCount})`,
          level: "INFO",
          body: `All systems nominal.\nActive peers: ${this.crossSpeech.getPeers().length}\nLatest provider grounding: ${diagnosis.provider}\nStatus: ONLINE & SELF-SUSTAINING`,
        });
      }

    } catch (err: any) {
      console.error("[AUTONOMOUS OVERSEER ERROR]", err.message);
    } finally {
      if (this.isRunning) {
        setTimeout(() => this.runCycle(), this.intervalMs);
      }
    }
  }
}
