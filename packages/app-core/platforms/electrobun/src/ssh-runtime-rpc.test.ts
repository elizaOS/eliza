/** Security boundary tests for native SSH runtime enrollment. */
import { describe, expect, it } from "vitest";
import {
  desktopStartSshRuntime,
  desktopStopSshRuntime,
  normalizeSshRuntimeRequest,
} from "./ssh-runtime-rpc";

describe("SSH runtime RPC", () => {
  it.each([
    "root@example.com; touch /tmp/pwned",
    "root@example.com -oProxyCommand=evil",
    "root@",
    "example.com",
  ])("rejects an unsafe target before spawning: %s", async (target) => {
    await expect(
      desktopStartSshRuntime({
        runtimeId: "runtime-1",
        target,
        sshPort: 22,
        remoteApiPort: 2138,
      }),
    ).rejects.toThrow("SSH runtime fields are invalid");
  });

  it("rejects relative identity paths and invalid ports", async () => {
    await expect(
      desktopStartSshRuntime({
        runtimeId: "runtime-1",
        target: "eliza@example.com",
        sshPort: 0,
        remoteApiPort: 2138,
        identityFile: "../../private-key",
      }),
    ).rejects.toThrow("SSH runtime fields are invalid");
  });

  it("stopping an unknown tunnel is idempotent", async () => {
    await expect(
      desktopStopSshRuntime({ runtimeId: "not-running" }),
    ).resolves.toEqual({ stopped: false });
  });

  it("allows only the remote agent API surface and strips untrusted headers", () => {
    expect(
      normalizeSshRuntimeRequest({
        runtimeId: "runtime-1",
        credentialRef: "credential-1",
        path: "/api/conversations/c-1/messages?wait=true",
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "attacker-controlled",
          "x-forwarded-host": "evil.example",
        },
        body: "{}",
        timeoutMs: 60_000,
      }),
    ).toEqual(
      expect.objectContaining({
        path: "/api/conversations/c-1/messages?wait=true",
        headers: { accept: "application/json" },
      }),
    );
  });

  it.each([
    "/api/settings",
    "/api/health/../settings",
    "https://evil.example/api/health",
  ])("rejects a non-agent or origin-changing request path: %s", (path) => {
    expect(() =>
      normalizeSshRuntimeRequest({
        runtimeId: "runtime-1",
        path,
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 1_000,
      }),
    ).toThrow("route is not allowed");
  });
});
