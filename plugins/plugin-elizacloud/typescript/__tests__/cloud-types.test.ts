/**
 * Tests for cloud types — error class hierarchy, DEFAULT_CLOUD_CONFIG values.
 */

import { describe, it, expect } from "vitest";
import {
  CloudApiError,
  InsufficientCreditsError,
  DEFAULT_CLOUD_CONFIG,
} from "../types/cloud";

describe("CloudApiError", () => {
  it("captures status code and error body", () => {
    const body = { success: false as const, error: "Not Found" };
    const err = new CloudApiError(404, body);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Not Found");
    expect(err.name).toBe("CloudApiError");
    expect(err.errorBody).toBe(body);
  });

  it("is an instance of Error", () => {
    const err = new CloudApiError(500, { success: false, error: "boom" });
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves optional details and quota fields", () => {
    const body = {
      success: false as const,
      error: "quota",
      details: { reason: "too many" },
      quota: { current: 3, max: 3 },
    };
    const err = new CloudApiError(403, body);
    expect(err.errorBody.details).toEqual({ reason: "too many" });
    expect(err.errorBody.quota).toEqual({ current: 3, max: 3 });
  });
});

describe("InsufficientCreditsError", () => {
  it("extends CloudApiError with 402 status", () => {
    const body = { success: false as const, error: "Low credits", requiredCredits: 15.5 };
    const err = new InsufficientCreditsError(body);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(402);
    expect(err.name).toBe("InsufficientCreditsError");
    expect(err.requiredCredits).toBe(15.5);
  });

  it("defaults requiredCredits to 0 when not in body", () => {
    const err = new InsufficientCreditsError({ success: false, error: "broke" });
    expect(err.requiredCredits).toBe(0);
  });

  it("can be caught as CloudApiError", () => {
    const err = new InsufficientCreditsError({ success: false, error: "x" });
    let caught = false;
    if (err instanceof CloudApiError) {
      caught = true;
      expect(err.statusCode).toBe(402);
    }
    expect(caught).toBe(true);
  });
});

describe("DEFAULT_CLOUD_CONFIG", () => {
  it("has sane default baseUrl", () => {
    expect(DEFAULT_CLOUD_CONFIG.baseUrl).toBe("https://www.elizacloud.ai/api/v1");
  });

  it("is disabled by default", () => {
    expect(DEFAULT_CLOUD_CONFIG.enabled).toBe(false);
  });

  it("defaults to cloud inference mode", () => {
    expect(DEFAULT_CLOUD_CONFIG.inferenceMode).toBe("cloud");
  });

  it("has reasonable bridge settings", () => {
    expect(DEFAULT_CLOUD_CONFIG.bridge.reconnectIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_CLOUD_CONFIG.bridge.maxReconnectAttempts).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CLOUD_CONFIG.bridge.heartbeatIntervalMs).toBeGreaterThanOrEqual(5000);
  });

  it("has reasonable backup settings", () => {
    expect(DEFAULT_CLOUD_CONFIG.backup.autoBackupIntervalMs).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_CLOUD_CONFIG.backup.maxSnapshots).toBeGreaterThanOrEqual(1);
  });

  it("has ARM64 as default architecture", () => {
    expect(DEFAULT_CLOUD_CONFIG.container.defaultArchitecture).toBe("arm64");
  });

  it("container defaults are within ECS limits", () => {
    expect(DEFAULT_CLOUD_CONFIG.container.defaultCpu).toBeGreaterThanOrEqual(256);
    expect(DEFAULT_CLOUD_CONFIG.container.defaultCpu).toBeLessThanOrEqual(4096);
    expect(DEFAULT_CLOUD_CONFIG.container.defaultMemory).toBeGreaterThanOrEqual(256);
    expect(DEFAULT_CLOUD_CONFIG.container.defaultMemory).toBeLessThanOrEqual(4096);
    expect(DEFAULT_CLOUD_CONFIG.container.defaultPort).toBeGreaterThan(0);
    expect(DEFAULT_CLOUD_CONFIG.container.defaultPort).toBeLessThanOrEqual(65535);
  });
});
