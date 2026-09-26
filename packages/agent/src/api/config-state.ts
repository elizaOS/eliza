/** Keeps live configuration references aligned with committed durable state. */
import type { ElizaConfig } from "../config/config.ts";

/** Replace a live config in place so references held by callers stay valid. */
export function replaceConfigInPlace(
  state: ElizaConfig,
  next: ElizaConfig,
): void {
  const stateRecord = state as ElizaConfig & Record<string, unknown>;
  const nextRecord = next as ElizaConfig & Record<string, unknown>;
  for (const key of Object.keys(stateRecord)) {
    if (!(key in nextRecord)) {
      delete stateRecord[key];
    }
  }
  for (const [key, value] of Object.entries(nextRecord)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    stateRecord[key] = value;
  }
}
