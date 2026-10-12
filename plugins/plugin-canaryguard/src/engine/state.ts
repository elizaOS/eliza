import type { CanaryGuardResult } from "../types";

export class CanaryGuardState {
  static lastStatus: "idle" | "clean" | "sanitized" | "blocked" | "error" = "idle";
  static lastError: string | null = null;
  static mode: "local" | "remote" | "local-fallback" = "local";
  static scansCount = 0;
  static threatsNeutralized = 0;

  static recordScan(result: CanaryGuardResult): void {
    this.scansCount++;
    this.threatsNeutralized += result.threats_neutralized.length;
    this.lastStatus = result.status;
    this.mode = result.mode;
    this.lastError = null;
  }

  static recordError(err: unknown): void {
    this.lastStatus = "error";
    this.lastError = err instanceof Error ? err.message : String(err);
  }
}
