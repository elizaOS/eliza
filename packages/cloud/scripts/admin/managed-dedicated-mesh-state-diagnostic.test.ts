/** Tests the privacy-safe classifiers used by the live Dedicated mesh diagnostic. */

import { describe, expect, test } from "bun:test";
import {
  classifyContainerLogs,
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
});
