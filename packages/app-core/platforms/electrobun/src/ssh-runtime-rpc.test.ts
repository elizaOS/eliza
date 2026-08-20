/** Security boundary tests for native SSH runtime enrollment. */
import { describe, expect, it } from "vitest";
import {
  desktopStartSshRuntime,
  desktopStopSshRuntime,
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
});
