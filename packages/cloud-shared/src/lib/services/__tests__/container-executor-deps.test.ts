import { describe, expect, test } from "bun:test";
import { allocatePort } from "../docker-sandbox-utils";
import {
  APP_CONTAINER_HOST_PORT_MAX,
  APP_CONTAINER_HOST_PORT_MIN,
} from "../docker-port-allocation";

describe("allocateAppContainerHostPort range", () => {
  test("allocatePort stays within the app container host port band", () => {
    const used = new Set([20000, 25000, 39999]);
    const port = allocatePort(APP_CONTAINER_HOST_PORT_MIN, APP_CONTAINER_HOST_PORT_MAX, used);
    expect(port).toBeGreaterThanOrEqual(APP_CONTAINER_HOST_PORT_MIN);
    expect(port).toBeLessThan(APP_CONTAINER_HOST_PORT_MAX);
    expect(used.has(port)).toBe(false);
  });
});

describe("parseSeedDockerNodeEntry", () => {
  test("parses nodeId:hostname:capacity entries", async () => {
    const { parseSeedDockerNodeEntry } = await import("../container-executor-deps");
    expect(parseSeedDockerNodeEntry("app-node-1:10.0.0.5:40")).toEqual({
      nodeId: "app-node-1",
      hostname: "10.0.0.5",
    });
  });

  test("falls back to bare hostname tokens", async () => {
    const { parseSeedDockerNodeEntry } = await import("../container-executor-deps");
    expect(parseSeedDockerNodeEntry("worker.example.com")).toEqual({
      nodeId: "worker.example.com",
      hostname: "worker.example.com",
    });
  });
});
