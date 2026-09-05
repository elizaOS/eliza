/** Tests the privacy-safe classifiers used by the live Dedicated mesh diagnostic. */

import { describe, expect, test } from "bun:test";
import {
  classifyApplicationState,
  classifyContainerLogs,
  classifyHostRuntimeState,
  classifyRuntimeProcessState,
  classifyTailscaleStatus,
} from "./managed-dedicated-mesh-state-diagnostic";

describe("managed Dedicated mesh-state diagnostic", () => {
  test("retains only closed Tailscale status facts", () => {
    expect(
      classifyTailscaleStatus(
        JSON.stringify({
          BackendState: "NeedsLogin",
          AuthURL: "https://login.tailscale.com/private",
          Self: { MachineAuthorized: false, TailscaleIPs: ["100.64.0.9"] },
        }),
      ),
    ).toEqual({
      query: "success",
      backendState: "NeedsLogin",
      machineAuthorized: false,
      authUrlPresent: true,
    });
  });

  test("fails closed for malformed or unknown status", () => {
    expect(classifyTailscaleStatus("not-json")).toEqual({
      query: "error",
      backendState: null,
      machineAuthorized: null,
      authUrlPresent: false,
    });
    expect(
      classifyTailscaleStatus('{"BackendState":"FuturePrivateState"}'),
    ).toEqual({
      query: "success",
      backendState: null,
      machineAuthorized: null,
      authUrlPresent: false,
    });
  });

  test("maps raw container logs to booleans without returning their text", () => {
    expect(
      classifyContainerLogs(
        "tailscale up failed: auth key expired\nhttps://login.tailscale.com/a/private-token",
      ),
    ).toEqual({
      authKeyRejected: true,
      interactiveAuthRequired: true,
      tailscaleUpFailed: true,
      agentStarted: false,
    });
  });

  test("retains only closed container startup process facts", () => {
    expect(
      classifyRuntimeProcessState(
        [
          "pid1=entrypoint",
          "agent=absent",
          "entrypoint=present",
          "tailscale_up=present",
          "force_noise_443=enabled",
          "stuck_cli_escape=present",
        ].join("\n"),
      ),
    ).toEqual({
      pid1: "entrypoint",
      agentProcessPresent: false,
      entrypointProcessPresent: true,
      tailscaleUpProcessPresent: true,
      forceNoise443Enabled: true,
      stuckCliEscapePresent: true,
    });
  });

  test("fails closed for missing or unrecognized process facts", () => {
    expect(
      classifyRuntimeProcessState("pid1=private-command\nagent=present"),
    ).toEqual({
      pid1: "unknown",
      agentProcessPresent: true,
      entrypointProcessPresent: false,
      tailscaleUpProcessPresent: false,
      forceNoise443Enabled: false,
      stuckCliEscapePresent: false,
    });
  });

  test("retains only closed application listener and runtime-mode facts", () => {
    expect(
      classifyApplicationState(
        "health=unreachable\nroot=response\ncloud_provisioned=true\napi_expose_port=false",
      ),
    ).toEqual({
      health: "unreachable",
      root: "response",
      cloudProvisioned: true,
      apiExposePortEnabled: false,
    });
    expect(classifyApplicationState("health=private-status")).toEqual({
      health: "unknown",
      root: "unknown",
      cloudProvisioned: false,
      apiExposePortEnabled: false,
    });
  });

  test("retains only closed Docker host configuration and service facts", () => {
    expect(
      classifyHostRuntimeState(
        "live_restore=true\ndocker_service=active\ncontainerd_service=active",
      ),
    ).toEqual({
      liveRestoreConfigured: true,
      dockerServiceActive: true,
      containerdServiceActive: true,
    });
    expect(classifyHostRuntimeState("private-host-output")).toEqual({
      liveRestoreConfigured: false,
      dockerServiceActive: false,
      containerdServiceActive: false,
    });
  });
});
