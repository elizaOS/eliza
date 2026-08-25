/**
 * Unit coverage for LifeOps connector degradation contracts
 * in lifeops-connector-degradation.ts.
 *
 * Tests degradation axes vocabulary completeness, uniqueness, string formatting,
 * and interface compatibility.
 */

import { describe, expect, it } from "vitest";
import {
  LIFEOPS_CONNECTOR_DEGRADATION_AXES,
  type LifeOpsConnectorDegradation,
} from "./lifeops-connector-degradation.js";

describe("lifeops-connector-degradation", () => {
  it("exports LIFEOPS_CONNECTOR_DEGRADATION_AXES array with expected items", () => {
    expect(Array.isArray(LIFEOPS_CONNECTOR_DEGRADATION_AXES)).toBe(true);
    expect(LIFEOPS_CONNECTOR_DEGRADATION_AXES).toEqual([
      "missing-scope",
      "rate-limited",
      "disconnected",
      "auth-expired",
      "session-revoked",
      "delivery-degraded",
      "helper-disconnected",
      "retry-idempotent",
      "hold-expired",
      "transport-offline",
      "blocked-resume",
    ]);
  });

  it("ensures all degradation axes are non-empty unique kebab-case strings", () => {
    const unique = new Set(LIFEOPS_CONNECTOR_DEGRADATION_AXES);
    expect(unique.size).toBe(LIFEOPS_CONNECTOR_DEGRADATION_AXES.length);

    for (const axis of LIFEOPS_CONNECTOR_DEGRADATION_AXES) {
      expect(typeof axis).toBe("string");
      expect(axis.length).toBeGreaterThan(0);
      expect(axis).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("validates structural typing for LifeOpsConnectorDegradation", () => {
    const record: LifeOpsConnectorDegradation = {
      axis: "auth-expired",
      code: "TOKEN_EXPIRED",
      message: "The OAuth refresh token has expired",
      retryable: false,
    };

    expect(LIFEOPS_CONNECTOR_DEGRADATION_AXES.includes(record.axis)).toBe(true);
    expect(record.retryable).toBe(false);
  });
});
