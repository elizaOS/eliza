import type { AutoApproveConfig } from "./types";

export function autoApproveSummary(config: AutoApproveConfig): string {
  return `Under $${config.threshold}`;
}
