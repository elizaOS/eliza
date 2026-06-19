/**
 * Arming gate for build-from-repo: makeNodeBuilderExec exposes the app node's
 * SSH as a BuildExec ONLY when the container backend is configured, so the
 * deploy backend cleanly falls back to prebuilt images otherwise (no accidental
 * build-mode arming). Pins that safety property.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNodeBuilderExec } from "../container-executor-deps";

const SAVED = { ...process.env };

function reset() {
  for (const k of [
    "APPS_CONTAINERS_ENABLED",
    "CONTAINERS_DOCKER_NODES",
    "CONTAINERS_SSH_KEY",
    "CONTAINERS_SSH_KEY_PATH",
  ]) {
    delete process.env[k];
  }
}

beforeEach(reset);
afterEach(() => {
  reset();
  Object.assign(process.env, SAVED);
});

describe("makeNodeBuilderExec — arming gate", () => {
  test("returns null when no docker node is configured (→ prebuilt fallback)", () => {
    process.env.CONTAINERS_SSH_KEY = Buffer.from("fake-key").toString("base64");
    // no CONTAINERS_DOCKER_NODES
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns null when no SSH key is configured", () => {
    process.env.CONTAINERS_DOCKER_NODES = "apps-node-1:10.0.0.1:20";
    // no CONTAINERS_SSH_KEY / _PATH
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns null when explicitly disabled even if node + key present", () => {
    process.env.APPS_CONTAINERS_ENABLED = "0";
    process.env.CONTAINERS_DOCKER_NODES = "apps-node-1:10.0.0.1:20";
    process.env.CONTAINERS_SSH_KEY = Buffer.from("fake-key").toString("base64");
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns a BuildExec (exec fn) when node + key are configured", () => {
    process.env.CONTAINERS_DOCKER_NODES = "apps-node-1:10.0.0.1:20";
    process.env.CONTAINERS_SSH_KEY = Buffer.from("fake-key").toString("base64");
    const exec = makeNodeBuilderExec();
    expect(exec).not.toBeNull();
    expect(typeof exec?.exec).toBe("function");
  });
});
