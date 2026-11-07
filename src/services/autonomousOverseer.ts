import { ModelStackRouter } from "./modelRouter";
import { CrossSpeechEngine } from "./crossSpeechEngine";
import { EmailNotifier } from "./emailNotifier";

export interface OverseerConfig {
  checkIntervalMs?: number;
  autoHealEnabled?: boolean;
  currentUserEmail?: string;
}

/**
 * AutonomousSystemOverseer
 * 
 * General-user aligned autonomous system loop:
 *  - Interweaves DeepSeek, Gemini 2.0 Flash, Perplexity Sonar, and ElizaOS
 *  - Dispatches updates directly to the active logged-in user
 *  - Routes infrastructure alerts to admin only when explicitly defined
 */
export class AutonomousSystemOverseer {
  private router: ModelStackRouter;
  private crossSpeech: CrossSpeechEngine;
  private notifier: EmailNotifier;
  private isRunning = false;
  private intervalMs: number;
  private cycleCount = 0;
  private currentUserEmail?: string;

  constructor(config: OverseerConfig = {}) {
    this.router = new ModelStackRouter();
    this.crossSpeech = new CrossSpeechEngine();
    this.notifier = new EmailNotifier();
    this.intervalMs = config.checkIntervalMs || 120_000;
    this.currentUserEmail = config.currentUserEmail;
  }

  setCurrentUser(email: string): void {
    this.currentUserEmail = email;
  }

  startAutonomousLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("=================================================================");
    console.log("  VALHALLA AUTONOMOUS OVERSEER: GENERAL USER & SESSION ACTIVE    ");
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

        // Notify session user of autonomous recovery
        await this.notifier.sendEmail({
          subject: "Your Workspace Self-Healing Completed",
          level: "REPAIR_ALERT",
          audience: "user",
          body: `Valhalla Autonomous Overseer detected network drift during Cycle #${this.cycleCount}.\n\nYour session was automatically reconciled and remains non-custodial and secure.\n\nDiagnosis summary:\n${diagnosis.content}`,
        }, this.currentUserEmail);
      } else if (this.cycleCount % 30 === 0 && this.currentUserEmail) {
        // Send user periodic health update every hour
        await this.notifier.sendEmail({
          subject: `Your Valhalla Desk Status (Cycle #${this.cycleCount})`,
          level: "INFO",
          audience: "user",
          body: `All systems nominal.\nConnected peers: ${this.crossSpeech.getPeers().length}\nYour desk is live, calibrated, and self-sustaining.\nStatus: ONLINE`,
        }, this.currentUserEmail);
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
