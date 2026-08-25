/**
 * Guards the user-facing provisioning duration estimate against drifting
 * below the real health-check budget again (#22548): the old flat 90s
 * estimate assumed a 60s health check against docker-sandbox-provider's real
 * 360s timeout, so users were told an in-budget job was "still in progress
 * after 362s". Deterministic constant assertions; no I/O.
 */
import { expect, test } from "bun:test";
import { HEALTH_CHECK_TIMEOUT_MS } from "../docker-sandbox-provider";
import {
  CONTAINER_HEALTH_CHECK_BUDGET_MS,
  CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
} from "../provisioning-jobs";

test("provisioning-jobs' mirrored health budget equals docker-sandbox-provider's timeout", () => {
  // provisioning-jobs cannot import docker-sandbox-provider (node-only deps
  // in the Worker bundle), so it mirrors the value; this pins the mirror.
  expect(CONTAINER_HEALTH_CHECK_BUDGET_MS).toBe(HEALTH_CHECK_TIMEOUT_MS);
});

test("the user-facing lifecycle estimate covers the full health-check budget", () => {
  expect(CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS).toBeGreaterThanOrEqual(HEALTH_CHECK_TIMEOUT_MS);
});
