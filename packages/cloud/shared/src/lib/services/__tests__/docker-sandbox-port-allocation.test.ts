/**
 * Port-allocation exhaustion guard for Docker sandbox provisioning.
 *
 * Provisioning passes one shared used-port set (bridge, WebUI, and
 * app-container ports on a node) to allocatePort for disjoint ranges, so the
 * exhaustion pre-check must count only in-range exclusions. Counting the raw
 * set size used to fail provisioning with "No available ports" while the
 * requested range still held free ports.
 *
 * Pure unit coverage: allocatePort is deterministic apart from the random
 * pick among free ports, so every case below runs without Docker, a
 * database, or network access.
 */

import { describe, expect, test } from "bun:test";
import {
  allocatePort,
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  WEBUI_PORT_MAX,
  WEBUI_PORT_MIN,
} from "../docker-sandbox-utils";

describe("allocatePort range exhaustion", () => {
  test("out-of-range exclusions do not exhaust the range", () => {
    const port = allocatePort(10, 12, new Set([99, 100]));
    expect(port === 10 || port === 11).toBe(true);
  });

  test("shared bridge+webui used set still allocates a free bridge port", () => {
    const used = new Set<number>();
    for (let port = BRIDGE_PORT_MIN; port < BRIDGE_PORT_MIN + 400; port++) {
      used.add(port);
    }
    for (let port = WEBUI_PORT_MIN; port < WEBUI_PORT_MIN + 700; port++) {
      used.add(port);
    }
    // 1100 exclusions against a 1000-port bridge range with 600 free ports.
    const port = allocatePort(BRIDGE_PORT_MIN, BRIDGE_PORT_MAX, used);
    expect(port).toBeGreaterThanOrEqual(BRIDGE_PORT_MIN + 400);
    expect(port).toBeLessThan(BRIDGE_PORT_MAX);
  });

  test("shared bridge+webui used set still allocates a free webui port", () => {
    const used = new Set<number>();
    for (let port = BRIDGE_PORT_MIN; port < BRIDGE_PORT_MAX; port++) {
      used.add(port);
    }
    for (let port = WEBUI_PORT_MIN; port < WEBUI_PORT_MIN + 700; port++) {
      used.add(port);
    }
    // A fully allocated bridge range must not exhaust the WebUI range.
    const port = allocatePort(WEBUI_PORT_MIN, WEBUI_PORT_MAX, used);
    expect(port).toBeGreaterThanOrEqual(WEBUI_PORT_MIN + 700);
    expect(port).toBeLessThan(WEBUI_PORT_MAX);
  });

  test("mixed in-range and out-of-range exclusions allocate the free port", () => {
    expect(allocatePort(10, 13, new Set([10, 11, 99]))).toBe(12);
  });

  test("a genuinely full range still throws instead of looping", () => {
    expect(() => allocatePort(10, 12, new Set([10, 11]))).toThrow(
      "No available ports in range [10, 12)",
    );
  });

  test("allocated ports never collide with in-range exclusions", () => {
    for (let i = 0; i < 200; i++) {
      const port = allocatePort(10, 14, new Set([10, 99, 100]));
      expect(port).toBeGreaterThanOrEqual(11);
      expect(port).toBeLessThan(14);
    }
  });
});
