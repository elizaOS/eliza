/**
 * BLOCKER #6 isolation gate (pure). `decideBuilderArming` / `selectBuilderHost`
 * decide WHETHER an untrusted user Dockerfile may be built and on WHICH host:
 *   - OFF unless the backend is configured AND build-from-repo is explicitly
 *     armed (APPS_BUILD_FROM_REPO_ENABLED=1), AND
 *   - only on an ISOLATED builder host — a dedicated APPS_BUILDS_HOST, or the
 *     runtime node ONLY when APPS_BUILD_ON_RUNTIME_NODE=1 opts in.
 *
 * Pure module (no DB/SSH chain), so the security gate is unit-testable directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideBuilderArming, selectBuilderHost } from "../app-builder-host";

const RUNTIME_NODE = "10.0.0.1";
const DEDICATED = "10.9.9.9";
const SAVED = { ...process.env };

function reset() {
  for (const k of [
    "APPS_BUILD_FROM_REPO_ENABLED",
    "APPS_BUILDS_HOST",
    "APPS_BUILD_ON_RUNTIME_NODE",
  ]) {
    delete process.env[k];
  }
}

beforeEach(reset);
afterEach(() => {
  reset();
  Object.assign(process.env, SAVED);
});

describe("selectBuilderHost — dedicated-host preference", () => {
  test("prefers the dedicated builder host over the runtime node", () => {
    process.env.APPS_BUILDS_HOST = `b1:${DEDICATED}:4`;
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1"; // dedicated still wins
    expect(selectBuilderHost(() => RUNTIME_NODE)).toBe(DEDICATED);
  });

  test("falls back to the runtime node only when explicitly opted in", () => {
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    expect(selectBuilderHost(() => RUNTIME_NODE)).toBe(RUNTIME_NODE);
  });

  test("returns null when no dedicated host and runtime build not opted in", () => {
    expect(selectBuilderHost(() => RUNTIME_NODE)).toBeNull();
  });
});

describe("decideBuilderArming — arming gate (BLOCKER #6)", () => {
  test("not armed when the container backend is disabled", () => {
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    const d = decideBuilderArming({ backendEnabled: false, selectRuntimeNode: () => RUNTIME_NODE });
    expect(d.armed).toBe(false);
    expect(d.host).toBeNull();
    expect(d.reason).toBe("backend-disabled");
  });

  test("not armed when build-from-repo is not explicitly enabled", () => {
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    const d = decideBuilderArming({ backendEnabled: true, selectRuntimeNode: () => RUNTIME_NODE });
    expect(d.armed).toBe(false);
    expect(d.reason).toBe("not-armed");
  });

  test("not armed when armed but no isolated builder host resolves", () => {
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    // no APPS_BUILDS_HOST, no runtime opt-in → refuse to build on a tenant node
    const d = decideBuilderArming({ backendEnabled: true, selectRuntimeNode: () => RUNTIME_NODE });
    expect(d.armed).toBe(false);
    expect(d.reason).toBe("no-isolated-host");
  });

  test("armed + dedicated when a dedicated builder host is configured", () => {
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILDS_HOST = DEDICATED;
    const d = decideBuilderArming({ backendEnabled: true, selectRuntimeNode: () => RUNTIME_NODE });
    expect(d.armed).toBe(true);
    expect(d.host).toBe(DEDICATED);
    expect(d.dedicated).toBe(true);
  });

  test("armed + NOT dedicated when only the runtime-node opt-in is set", () => {
    process.env.APPS_BUILD_FROM_REPO_ENABLED = "1";
    process.env.APPS_BUILD_ON_RUNTIME_NODE = "1";
    const d = decideBuilderArming({ backendEnabled: true, selectRuntimeNode: () => RUNTIME_NODE });
    expect(d.armed).toBe(true);
    expect(d.host).toBe(RUNTIME_NODE);
    expect(d.dedicated).toBe(false);
  });
});
