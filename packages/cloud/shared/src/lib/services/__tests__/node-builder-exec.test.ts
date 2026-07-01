/**
 * Arming gate for build-from-repo. `makeNodeBuilderExec` exposes a builder
 * host's SSH as a BuildExec ONLY when:
 *   - the container backend is configured,
 *   - build-from-repo is explicitly ARMED (APPS_BUILD_FROM_REPO_ENABLED=1), AND
 *   - an ISOLATED builder host resolves (a dedicated APPS_BUILDS_HOST, or the
 *     runtime node only if APPS_BUILD_ON_RUNTIME_NODE=1 opts in).
 *
 * This pins the BLOCKER #6 mitigation: an un-armed / mis-configured canary never
 * builds an untrusted Dockerfile, and it never builds on a tenant-hosting node
 * by accident — it cleanly falls back to the prebuilt-image path (null).
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
    "APPS_IMAGE_REGISTRY",
    "APPS_BUILD_FROM_REPO_ENABLED",
    "APPS_BUILDS_HOST",
    "APPS_BUILD_ON_RUNTIME_NODE",
  ]) {
    delete process.env[k];
  }
}

/** Configure the container backend (node + key) so only the build gate is under test. */
function armBackend() {
  process.env.CONTAINERS_DOCKER_NODES = "apps-node-1:10.0.0.1:20";
  process.env.CONTAINERS_SSH_KEY = Buffer.from("fake-key").toString("base64");
}

beforeEach(reset);
afterEach(() => {
  reset();
  Object.assign(process.env, SAVED);
});

describe("makeNodeBuilderExec — arming gate", () => {
  test("returns null when no docker node is configured (→ prebuilt fallback)", () => {
    process.env.CONTAINERS_SSH_KEY = Buffer.from("fake-key").toString("base64");
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    // no CONTAINERS_DOCKER_NODES
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns null when no SSH key is configured", () => {
    process.env.CONTAINERS_DOCKER_NODES = "apps-node-1:10.0.0.1:20";
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    // no CONTAINERS_SSH_KEY / _PATH
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns null when explicitly disabled even if node + key present", () => {
    process.env.APPS_CONTAINERS_ENABLED = "0";
    armBackend();
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns null when build-from-repo is NOT armed (backend configured)", () => {
    armBackend();
    // APPS_BUILD_FROM_REPO_ENABLED unset → stays on prebuilt path
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns null when only the image registry is configured", () => {
    armBackend();
    process.env.APPS_IMAGE_REGISTRY = "ghcr.io/elizaos";
    // A registry is necessary for build-from-repo, but it is not an arming flag.
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns null when armed but no isolated builder host (no dedicated, no runtime opt-in)", () => {
    armBackend();
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    // neither APPS_BUILDS_HOST nor APPS_BUILD_ON_RUNTIME_NODE — refuse to build
    // on a tenant-hosting node by default
    expect(makeNodeBuilderExec()).toBeNull();
  });

  test("returns a BuildExec when armed + a DEDICATED builder host is set", () => {
    armBackend();
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILDS_HOST = "builder-1:10.9.9.9:4";
    const exec = makeNodeBuilderExec();
    expect(exec).not.toBeNull();
    expect(typeof exec?.exec).toBe("function");
  });

  test("returns a BuildExec when armed + runtime-node opt-in (no dedicated host)", () => {
    armBackend();
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    const exec = makeNodeBuilderExec();
    expect(exec).not.toBeNull();
    expect(typeof exec?.exec).toBe("function");
  });
});
