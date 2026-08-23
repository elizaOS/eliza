/**
 * Unit coverage for Steward Sidecar types and constants in types.ts.
 *
 * Tests default constants (port, max restarts, health check timings, backoff timings,
 * tenant / agent ids and names, credentials file path).
 */

import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_FILE,
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_PORT,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_NAME,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "./types.js";

describe("steward-sidecar types and constants", () => {
  it("exports valid networking and execution constants", () => {
    expect(DEFAULT_PORT).toBe(3200);
    expect(DEFAULT_MAX_RESTARTS).toBe(5);
    expect(HEALTH_CHECK_INTERVAL_MS).toBe(500);
    expect(HEALTH_CHECK_TIMEOUT_MS).toBe(30_000);
    expect(INITIAL_BACKOFF_MS).toBe(1_000);
    expect(MAX_BACKOFF_MS).toBe(30_000);
  });

  it("exports valid identity and storage constants", () => {
    expect(DEFAULT_TENANT_ID).toBe("elizaos-desktop");
    expect(DEFAULT_TENANT_NAME).toBe("Desktop");
    expect(DEFAULT_AGENT_ID).toBe("eliza-wallet");
    expect(DEFAULT_AGENT_NAME).toBe("eliza-wallet");
    expect(CREDENTIALS_FILE).toBe("credentials.json");
  });

  it("enforces timing relationships", () => {
    expect(HEALTH_CHECK_INTERVAL_MS).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS);
    expect(INITIAL_BACKOFF_MS).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});
