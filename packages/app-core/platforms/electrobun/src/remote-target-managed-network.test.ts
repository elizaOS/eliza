import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TailscaleCliManagedNetworkJoiner } from "./remote-target-managed-network";

class FakeChild extends EventEmitter {
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("native managed-network enrollment", () => {
  it("passes a one-use key through a mode-0600 file and never process arguments", async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-managed-network-test-"),
    );
    try {
      let observedArgs: readonly string[] = [];
      let observedKey = "";
      let observedMode = 0;
      const joiner = new TailscaleCliManagedNetworkJoiner(
        async () => "/test/tailscale",
        (_command, args) => {
          observedArgs = args;
          const authArgument = args.find((arg) =>
            arg.startsWith("--auth-key=file:"),
          );
          const authPath = authArgument?.slice("--auth-key=file:".length);
          if (!authPath) throw new Error("missing auth key file");
          const child = new FakeChild();
          void (async () => {
            observedKey = await fs.readFile(authPath, "utf8");
            observedMode = (await fs.stat(authPath)).mode & 0o777;
            child.emit("close", 0);
          })();
          return child as unknown as ChildProcess;
        },
        temporaryRoot,
        () => 2_000_000_000_000,
      );
      const authKey = "hskey-auth-one-use-secret";
      await joiner.join({
        loginServer: "https://headscale-staging.example",
        authKey,
        hostname: "eliza-host-one",
        expiresAt: 2_000_000_030_000,
      });
      expect(observedKey).toBe(authKey);
      expect(observedMode).toBe(0o600);
      expect(observedArgs.join(" ")).not.toContain(authKey);
      expect(observedArgs).toContain("--shields-up");
      expect(observedArgs).not.toContain("--reset");
      await expect(fs.readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects expired or unsafe enrollment before spawning", async () => {
    let spawned = false;
    const joiner = new TailscaleCliManagedNetworkJoiner(
      async () => "/test/tailscale",
      () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      },
      os.tmpdir(),
      () => 2_000_000_000_000,
    );
    await expect(
      joiner.join({
        loginServer: "http://attacker.example",
        authKey: "hskey-auth-one-use-secret",
        hostname: "eliza-host-one",
        expiresAt: 2_000_000_030_000,
      }),
    ).rejects.toThrow("login server is invalid");
    await expect(
      joiner.join({
        loginServer: "https://headscale.example",
        authKey: "hskey-auth-one-use-secret",
        hostname: "eliza-host-one",
        expiresAt: 1_999_999_999_999,
      }),
    ).rejects.toThrow("expired");
    expect(spawned).toBe(false);
  });
});
