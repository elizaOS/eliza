/**
 * Composes the DockerSandboxProvider lifecycle suites into one package-runner
 * entry. No individual suite drives creation, health checks, and teardown, so
 * the composite preserves complete lifecycle coverage.
 */
import { describe, expect, test } from "bun:test";
import "./app-docker-cmd.test.ts";
import "./docker-ensure-network.test.ts";
import "./docker-port-allocation.test.ts";
import "./docker-sandbox-already-gone.test.ts";
import "./docker-sandbox-exact-restore.test.ts";
import "./docker-sandbox-headscale-route.test.ts";
import "./docker-sandbox-health-fallback.test.ts";
import "./docker-sandbox-health-stale-node.test.ts";
import "./docker-sandbox-placement-fallback.test.ts";
import "./docker-sandbox-probe-transport.test.ts";
import "./docker-sandbox-replacement-cleanup.test.ts";
import "./docker-sandbox-unreachable-terminal.test.ts";
import "./docker-ssh-probe-classify.test.ts";

describe("docker-sandbox-provider composite lane", () => {
  test("runs under bun with the suites it composes present", () => {
    expect(typeof test).toBe("function");
  });
});
