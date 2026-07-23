/**
 * Coverage lane composing the DockerSandboxProvider suites for the
 * changed-file gate (#16565) — same pattern as the orchestrator's
 * curated-coding-memory composite: the provider's lifecycle surface spans
 * many co-located suites, and a provider-touching change needs their UNION
 * to exercise the class (no single suite drives create+health+teardown).
 */
import { describe, expect, test } from "bun:test";
import "./app-docker-cmd.test.ts";
import "./docker-ensure-network.test.ts";
import "./docker-port-allocation.test.ts";
import "./docker-sandbox-already-gone.test.ts";
import "./docker-sandbox-headscale-route.test.ts";
import "./docker-sandbox-health-fallback.test.ts";
import "./docker-sandbox-health-stale-node.test.ts";
import "./docker-sandbox-probe-transport.test.ts";
import "./docker-sandbox-replacement-cleanup.test.ts";
import "./docker-sandbox-unreachable-terminal.test.ts";
import "./docker-ssh-probe-classify.test.ts";

describe("docker-sandbox-provider composite lane", () => {
  test("runs under bun with the suites it composes present", () => {
    expect(typeof test).toBe("function");
  });
});
