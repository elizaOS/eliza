import type { RateLimitConfig } from "./types";

export function rateLimitSummary(config: RateLimitConfig): string {
  return `${config.maxTxPerHour}/hr · ${config.maxTxPerDay}/day`;
}
